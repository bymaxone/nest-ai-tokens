/**
 * @fileoverview What the services hand a store: an input with an own key for every name of its type. A store that copies what it is given
 * into a new object and reads a name the caller did not set then finds `undefined`, and not a key planted on `Object.prototype`. Each row
 * plants the key, runs the call, re-copies the argument the store received as a store may, and reads the name from the copy.
 * @layer server
 */

import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { ResolvedAiTokensOptions } from '../config'
import { BudgetService } from './budget.service'
import { LedgerService } from './ledger.service'
import { PricingService } from './pricing.service'

const SCOPE = { type: 'user', id: 'u1' } as const

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it, whatever `run` does. */
async function planted<T>(key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

/** A budget service over a store that keeps what it was handed to upsert. */
function budgetWorld(): { service: BudgetService; handed: Record<string, unknown>[]; store: InMemoryBudgetStore } {
  const store = new InMemoryBudgetStore()
  const handed: Record<string, unknown>[] = []
  const upsert = store.upsert.bind(store)
  jest.spyOn(store, 'upsert').mockImplementation((input) => {
    handed.push(input)
    return upsert(input)
  })
  const service = new BudgetService(store, new LedgerService(new InMemoryLedgerStore()), { enabled: true, defaultPolicy: 'block', alertThresholds: [1], failClosed: true })
  return { service, handed, store }
}

const BUDGET_NAMES = ['features', 'limitTokens', 'limitCount', 'limitNanoUsd', 'anchorAt', 'expiresAt', 'id'] as const

describe('the budget a service hands a store to write', () => {
  it.each([['limitTokens', 0], ['limitCount', 0], ['limitNanoUsd', 0n], ['features', ['planted.feature']], ['expiresAt', new Date(0)], ['anchorAt', new Date(0)]] as const)('upsertBudget: a %s planted on Object.prototype is not read from a copy of the argument', async (key, value) => {
    const { service, handed } = budgetWorld()
    await planted(key, value, () => service.upsertBudget({ tenantId: 't1', scope: SCOPE, ...(key === 'limitNanoUsd' ? { limitCount: 5 } : { limitNanoUsd: 100n }), window: 'month' }))
    const copy = { ...handed[0]! }
    expect(copy[key]).toBeUndefined()
    for (const name of BUDGET_NAMES) expect(name in copy).toBe(true)
  })

  it('rotateWindow: a limitTokens planted on Object.prototype is not read from a copy of the argument', async () => {
    const { service, handed } = budgetWorld()
    const budget = await service.upsertBudget({ tenantId: 't1', scope: SCOPE, limitNanoUsd: 100n, window: 'month' })
    handed.length = 0
    await planted('limitTokens', 0, () => service.rotateWindow(budget.id, 't1'))
    const copy = { ...handed[0]! }
    // The key is the budget's own, so a store that reads it from the copy is not answered by Object.prototype.
    expect('limitTokens' in copy).toBe(true)
    expect(copy.limitTokens).toBeUndefined()
    expect(copy.limitNanoUsd).toBe(100n)
  })
})

describe('the price a service hands a store to seed', () => {
  /** Most seeded rows set no tier and no unit rates, which a store reads by name: they must be the row's own keys. */
  it.each(['tierThresholdTokens', 'tierInputNanoUsdPerMillion', 'tierOutputNanoUsdPerMillion', 'unitRates'])('seedFromSnapshot: a %s planted on Object.prototype is not read from a copy of the argument', async (key) => {
    const store = new InMemoryPricingStore()
    const handed: Record<string, unknown>[] = []
    const seed = store.seedPrice.bind(store)
    jest.spyOn(store, 'seedPrice').mockImplementation((input) => {
      handed.push({ ...input })
      return seed(input)
    })
    const service = new PricingService({ pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} } } as ResolvedAiTokensOptions, store)
    // The snapshot module is loaded first, so the key is planted after its rows exist.
    await import('@bymax-one/nest-ai-tokens/prices')
    const value = key === 'unitRates' ? { planted_unit: 1n } : 9_999n
    await planted(key, value, () => service.seedFromSnapshot())
    expect(handed.length).toBeGreaterThan(0)
    for (const input of handed) {
      const copy = { ...input }
      expect(key in copy).toBe(true)
      expect(copy[key]).not.toEqual(value)
    }
  })
})
