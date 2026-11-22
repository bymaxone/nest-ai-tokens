/**
 * @fileoverview The rows a store returns are read as the rows it kept: a key planted on `Object.prototype` under the name of a field the row
 * lacks is not one of its fields. Each row plants the key, runs the operation that reads the stored row, and asserts what was billed, what
 * was counted or whether the call was refused.
 * @layer server
 */

import type { NormalizedUsage } from '../../shared'
import { NOW, TENANT, USER_SCOPE, budgetInput, expectRejectCode, makeService, usageRecord } from '../../../test/fakes/budget-fixtures'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { HoldEstimate, MeteringContext } from '../interfaces'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService } from './metering.service'
import { PricingService } from './pricing.service'

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it, whatever `run` does. */
async function planted<T>(key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

/** A complete normalized usage (1000 in, 500 out, gpt-5 chat): 6,250,000 nano-USD at the seeded rates. */
function usage(): NormalizedUsage {
  return { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
}

const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }
const CONTEXT: MeteringContext = { tenantId: TENANT, scope: USER_SCOPE, feature: 'chat.reply' }

/** A metering service over in-memory stores whose model has a price for a tool unit; `hide` defines the unit rates of the price row as not enumerable. */
async function meteringWorld(hide = false): Promise<MeteringService> {
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    wallets: { enabled: false },
    budgets: { enabled: false },
  } as unknown as ResolvedAiTokensOptions
  const pricing = new InMemoryPricingStore()
  await pricing.upsertPrice({
    provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n,
    unitRates: { web_search: 10_000_000n }, effectiveFrom: new Date(0),
  })
  if (hide) {
    const resolve = pricing.resolveRate.bind(pricing)
    jest.spyOn(pricing, 'resolveRate').mockImplementation(async (...args) => {
      const row = await resolve(...args)
      if (row === null) return null
      const { unitRates, ...rest } = row
      return Object.defineProperty({ ...rest }, 'unitRates', { value: unitRates, enumerable: false })
    })
  }
  return new MeteringService(new LedgerService(new InMemoryLedgerStore(), options), new PricingService(options, pricing), new MarkupResolver(options), options, undefined, undefined, undefined, () => NOW)
}

describe('the units of a stored hold', () => {
  /** A hold that kept no units is captured at the table rate of the call: a planted `extraUnits` is not the host's. */
  it('captures a hold that kept no extraUnits at 6,250,000 when extraUnits is planted', async () => {
    const service = await meteringWorld()
    const hold = await service.hold(CONTEXT, ESTIMATE)
    const captured = await planted('extraUnits', { web_search: 1_000 }, () => service.capture(hold, { tenantId: TENANT, scope: USER_SCOPE }, usage()))
    expect(captured.billedCostNanoUsd).toBe(6_250_000n)
    expect('extraUnits' in captured).toBe(false)
  })
})

describe('the price row a store returned', () => {
  /** A rate defined as a non-enumerable field is still the row's: 3 searches at 10,000,000 are billed on top of the 6,250,000 of the tokens. */
  it('bills the unit rates of a price row that defines them as not enumerable', async () => {
    const service = await meteringWorld(true)
    const record = await service.record({ usage: { ...usage(), serverToolUse: { web_search: 3 } }, context: CONTEXT })
    expect(record.billedCostNanoUsd).toBe(36_250_000n)
  })
})

describe('the rows a budget is reconciled from', () => {
  /** A record that reverses none counts once: a planted `reversesRecordId` does not make it a compensating record. */
  it('reconciles two posted records to a count of 2 when reversesRecordId is planted', async () => {
    const { service, store, ledgerStore } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 1_000n }))
    await ledgerStore.append(usageRecord({ idempotencyKey: 'a', billedCostNanoUsd: 25n }), 'ha')
    await ledgerStore.append(usageRecord({ idempotencyKey: 'b', billedCostNanoUsd: 30n }), 'hb')
    const windowStart = new Date('2026-06-01T00:00:00.000Z')
    await planted('reversesRecordId', 'planted-original', () => service.reconcileWindow(budget.id, TENANT, windowStart))
    const window = await store.getWindow(budget.id, windowStart)
    expect(window?.spentCount).toBe(2)
    expect(window?.spentNanoUsd).toBe(55n)
  })
})

describe('the tenant of a stored budget', () => {
  /** A row that names no tenant is nobody's: a planted `tenantId` equal to the caller's does not make it the caller's. */
  it('refuses to replace a budget row that names no tenant when the caller\'s tenant is planted', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 1_000n }))
    const find = store.findBudgetById.bind(store)
    jest.spyOn(store, 'findBudgetById').mockImplementation(async (key) => {
      const row = await find(key)
      if (row === null) return null
      const { tenantId: _tenant, ...rest } = row
      return rest as typeof row
    })
    await planted('tenantId', TENANT, () => expectRejectCode(service.upsertBudget(budgetInput({ id: budget.id, limitNanoUsd: 5n })), 'AI_TOKENS_INVALID_CONFIG'))
  })
})
