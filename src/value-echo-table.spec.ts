/**
 * @fileoverview Where a value the host or the caller supplied may come back in an error. One table feeds a sentinel string through
 * every refusal that takes an id, a key, a model, a provider, a policy or a price, and asserts the serialised response of the
 * typed error does not contain it, except under the one `details` key a row names as the documented echo of an identifier the
 * caller already holds. A refusal added without a row here is a refusal nobody decided about: the table is the place to decide it.
 * @layer server
 */

import { TENANT, USER_SCOPE, budgetInput, makeService } from '../test/fakes/budget-fixtures'
import { makeFullStore } from '../test/fakes/full-store'
import { InMemoryLedgerStore } from '../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../test/fakes/in-memory-wallet-store'
import { applyDefaults, validateOptions } from './server/config'
import { Reflector } from '@nestjs/core'
import { AiTokensException } from './server/errors'
import { BudgetGuard } from './server/enforcement/budget.guard'
import { StreamUsageCollector } from './server/streaming/stream-usage-collector'
import { providerPresets } from './server/config/provider-presets'
import { InMemoryBudgetStore } from '../test/fakes/in-memory-budget-store'
import { BudgetService } from './server/services/budget.service'
import { LedgerService } from './server/services/ledger.service'
import { MarkupResolver } from './server/services/markup.resolver'
import { MeteringService } from './server/services/metering.service'
import { PricingService } from './server/services/pricing.service'
import { WalletService } from './server/services/wallet.service'

/** A string no library message contains, fed through each row as the value the host or the caller supplied. */
const S = 'sentinel-private-host-10.0.0.5-s3cr3t'

interface Row {
  /** What is fed in and what refuses it. */
  readonly name: string
  /** Makes the refusing call with the sentinel as the supplied value. */
  readonly run: (s: string) => unknown
  /** The `details` keys where the sentinel may appear because each is an identifier the caller holds, if any. */
  readonly echoes?: string | readonly string[]
}

async function rig(): Promise<{ metering: MeteringService; pricing: PricingService; wallets: WalletService }> {
  const options = applyDefaults({ store: makeFullStore(), markup: 1, pricing: { seedFromSnapshot: false, strict: true } })
  const pricing = new PricingService(options, new InMemoryPricingStore())
  const ledger = new LedgerService(new InMemoryLedgerStore(), options)
  await pricing.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n, effectiveFrom: new Date(0) })
  const wallets = new WalletService(new InMemoryWalletStore(), { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' })
  return { pricing, wallets, metering: new MeteringService(ledger, pricing, new MarkupResolver(options), options) }
}

const usage = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
const call = (tenantId: string): { tenantId: string; scope: typeof USER_SCOPE; feature: string } => ({ tenantId, scope: USER_SCOPE, feature: S })
const walletRef = (id: string): { tenantId: string; ownerType: 'user'; ownerId: string } => ({ tenantId: id, ownerType: 'user', ownerId: id })

const ROWS: readonly Row[] = [
  { name: 'a budget id that does not exist, at rotateWindow', run: (s) => makeService().service.rotateWindow(s, TENANT) },
  { name: 'a budget id that does not exist, at reconcileWindow', run: (s) => makeService().service.reconcileWindow(s, TENANT, new Date(0)) },
  { name: 'a budget id that belongs to another tenant, at upsertBudget', run: async (s) => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ id: s, tenantId: 'other-tenant' }))
    return service.upsertBudget(budgetInput({ id: s }))
  } },
  { name: 'a policy that is not documented, at upsertBudget', run: (s) => makeService().service.upsertBudget(budgetInput({ policy: s } as never)) },
  { name: 'a rating mode that is not documented', run: (s) => validateOptions({ store: makeFullStore(), ratingMode: s } as never) },
  { name: 'a tenant id and a feature on a budget refused for its limit', run: (s) => makeService().service.upsertBudget(budgetInput({ tenantId: s, limitNanoUsd: -1n })) },
  { name: 'a markup policy that returns a string', run: async (s) => new MarkupResolver({ markup: { resolve: () => s as never } }).resolve({ scope: USER_SCOPE, provider: 'openai', model: s, operation: 'chat', serviceTier: 'standard', feature: s }) },
  { name: 'a numeric option given as a string', run: (s) => validateOptions({ store: makeFullStore(), holds: { ttlSeconds: s } } as never) },
  { name: 'a record with a date that is not valid, under a tenant and a key that are the sentinel', run: async (s) => (await rig()).metering.record({ usage, context: { ...call(s), idempotencyKey: s }, occurredAt: s } as never) },
  { name: 'a wallet grant that is not valid, for an owner that is the sentinel', run: async (s) => (await rig()).wallets.grant(walletRef(s), { amountNanoUsd: -1n, idempotencyKey: s, reason: s }) },
  { name: 'a wallet debit with no funds, for an owner that is the sentinel', run: async (s) => (await rig()).wallets.debit(walletRef(s), { amountNanoUsd: 5n, idempotencyKey: s, reason: s }) },
  { name: 'a budget that is exhausted, with a budget id that is the sentinel', echoes: 'budgetId', run: async (s) => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ id: s, limitNanoUsd: 5n }))
    return service.consume({ tenantId: TENANT, scope: USER_SCOPE, feature: 'f' }, { nanoUsd: 10n, tokens: 0, count: 0 })
  } },
  { name: 'a record to reverse that does not exist', echoes: 'recordId', run: async (s) => {
    const options = applyDefaults({ store: makeFullStore(), markup: 1 })
    return new LedgerService(new InMemoryLedgerStore(), options).reverse(s, s)
  } },
  { name: 'a stream that ended with no usage and no tokenizer, from a provider and a model that are the sentinel', echoes: ['provider', 'model'], run: (s) => new StreamUsageCollector({ provider: s, model: s, preset: providerPresets.openaiChat }).finalize() },
  { name: 'an exhausted budget met by the guard, with a budget id that is the sentinel', echoes: 'budgetId', run: async (s) => {
    const now = new Date('2026-06-15T00:00:00.000Z')
    const options = applyDefaults({ store: makeFullStore(), markup: 1, budgets: {} })
    const ledger = new LedgerService(new InMemoryLedgerStore(), options)
    const budgets = new BudgetService(new InMemoryBudgetStore({ now: () => now }), ledger, { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true }, () => now)
    const metering = new MeteringService(ledger, new PricingService(options, new InMemoryPricingStore()), new MarkupResolver(options), options, undefined, undefined, budgets, () => now)
    await budgets.upsertBudget(budgetInput({ id: s, limitNanoUsd: 5n }))
    await budgets.consume({ tenantId: TENANT, scope: USER_SCOPE, feature: 'f' }, { nanoUsd: 5n, tokens: 0, count: 0 })
    const guard = new BudgetGuard(budgets, metering, new Reflector(), { scopeResolver: () => ({ tenantId: TENANT, scope: USER_SCOPE, feature: 'f' }) })
    const handler = (): string => 'ok'
    const http = { getHandler: () => handler, getClass: () => Object, switchToHttp: () => ({ getRequest: () => ({}) }) }
    return guard.canActivate(http as never)
  } },
  { name: 'a hold that does not exist, at capture', echoes: 'holdId', run: async (s) => (await rig()).metering.capture({ id: s } as never, { tenantId: TENANT, scope: USER_SCOPE }, usage) },
  { name: 'a record retried under the same key with another body', echoes: 'idempotencyKey', run: async (s) => {
    const { metering } = await rig()
    await metering.record({ usage, context: { ...call(TENANT), idempotencyKey: s } })
    return metering.record({ usage: { ...usage, inputTokens: 2 }, context: { ...call(TENANT), idempotencyKey: s } })
  } },
  { name: 'a provider the library has no normalizer for', echoes: 'provider', run: async (s) => (await rig()).metering.record({ usage: { ...usage, provider: s }, context: call(TENANT) }) },
  { name: 'a model with no price, on a strict pricing', echoes: 'model', run: async (s) => (await rig()).metering.estimateCost({ provider: 'openai', model: s, operation: 'chat', inputTokens: 1, maxOutputTokens: 1 }) },
  { name: 'a currency other than USD with no fx, a refusal at boot', run: (s) => validateOptions({ store: makeFullStore(), currency: s }) },
]

/** The typed error a row raises; fails when the row does not raise one. */
async function raised(run: () => unknown): Promise<AiTokensException> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AiTokensException) return error
    throw error
  }
  throw new Error('expected the row to be refused')
}

describe('a value the host or the caller supplied, in the response of the error that refuses it', () => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const error = await raised(() => row.run(S))
    const response = JSON.parse(JSON.stringify(error.getResponse())) as { error: { details?: Record<string, unknown> } }
    const details = response.error.details ?? {}
    const allowed = [row.echoes ?? []].flat()
    if (allowed.length > 0) expect(allowed.some((key) => String(details[key]).includes(S))).toBe(true)
    const kept = Object.fromEntries(Object.entries(details).filter(([key]) => !allowed.includes(key)))
    expect(JSON.stringify({ ...response, error: { ...response.error, details: kept } })).not.toContain(S)
  })

  /** The same rows with a value over the bound: an identifier longer than 256 characters is left out of the details, not truncated. */
  it.each(ROWS.filter((row) => row.echoes !== undefined).map((row) => [row.name, row] as const))('leaves an over-long value out: %s', async (_name, row) => {
    const long = S.repeat(8)
    expect(long.length).toBeGreaterThan(256)
    const error = await raised(() => row.run(long))
    expect(JSON.stringify(error.getResponse())).not.toContain(S)
  })

  /** A row that names an echo must be one: the identifier the caller holds comes back under that key and nowhere else. */
  it('names an echo only for an identifier the caller passed', () => {
    expect([...new Set(ROWS.flatMap((row) => [row.echoes ?? []].flat()))].sort()).toEqual(['budgetId', 'holdId', 'idempotencyKey', 'model', 'provider', 'recordId'])
  })
})
