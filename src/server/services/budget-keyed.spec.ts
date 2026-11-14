/**
 * @fileoverview The keyed budget movements of `BudgetService`: a consume, an adjust or a release under a key moves each
 * budget's window once, however many attempts run it, and gives back exactly what the key recorded. Covers the
 * retry that must not double count, the multi-budget retry, the live counter on a replay, and a release of a
 * window that predates keys.
 * @layer test
 */

import type { BudgetDelta, IBudgetCounterStore } from '../interfaces'
import { TENANT, budgetInput, context, expectRejectCode, makeService } from '../../../test/fakes/budget-fixtures'

const MONTH = new Date('2026-06-01T00:00:00.000Z')

/** A live counter held in a map: it increments up to a limit, decrements, and resets. */
class MapCounter implements IBudgetCounterStore {
  readonly values = new Map<string, bigint>()

  incrIfBelow(key: string, amount: bigint, limit: bigint): Promise<boolean> {
    const next = (this.values.get(key) ?? 0n) + amount
    if (next > limit) return Promise.resolve(false)
    this.values.set(key, next)
    return Promise.resolve(true)
  }

  decr(key: string, amount: bigint): Promise<void> {
    this.values.set(key, (this.values.get(key) ?? 0n) - amount)
    return Promise.resolve()
  }

  reset(key: string): Promise<void> {
    this.values.delete(key)
    return Promise.resolve()
  }
}

/** A delta across the three dimensions. */
function delta(nanoUsd: bigint, tokens = 0, count = 0): BudgetDelta {
  return { nanoUsd, tokens, count }
}

/** The cost counter key of a budget's June window. */
function costKey(budgetId: string): string {
  return `ai_tokens:budget:${budgetId}:2026-06-01T00:00:00.000Z:cost`
}

describe('BudgetService.consume under a key', () => {
  /*
   * Invariant: the same key consumed twice moves each window once, and the second run signals nothing new.
   */
  it('moves the window once for one key, however many times it runs', async () => {
    const { service, store, thresholds } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(85n), undefined, 'call-1')
    const crossed = thresholds.length
    await service.consume(context(), delta(85n), undefined, 'call-1')
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(85n)
    expect(thresholds).toHaveLength(crossed)
  })

  /** Two different keys are two consumptions: the second is refused by the limit, as an unkeyed one would be. */
  it('blocks a second key that would exceed the limit', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(80n), undefined, 'call-1')
    await expectRejectCode(service.consume(context(), delta(80n), undefined, 'call-2'), 'AI_TOKENS_BUDGET_EXCEEDED')
  })

  /** A retry of a call whose consumption already filled the limit is not blocked by its own consumption. */
  it('does not block the retry of a call whose own consumption fills the limit', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(100n), undefined, 'call-1')
    await expect(service.consume(context(), delta(100n), undefined, 'call-1')).resolves.toBeUndefined()
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(100n)
  })

  /** A non-blocking budget records the spend once per key as well. */
  it('records the spend of an allow budget once per key', async () => {
    const { service, store, exceeded } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 50n, policy: 'allow' }))
    await service.consume(context(), delta(60n), undefined, 'call-1')
    expect(exceeded).toHaveLength(1)
    await service.consume(context(), delta(60n), undefined, 'call-1')
    expect(exceeded).toHaveLength(1)
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(60n)
  })

  /*
   * Invariant: a retry after a failure part-way through the budgets applies each budget once: the budget that
   * already moved is replayed, the one that did not is applied.
   */
  it('applies each of several budgets once when a retry follows a failure part-way', async () => {
    const { service, store } = makeService()
    const first = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, scope: { type: 'tenant', id: TENANT } }))
    const second = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    const original = store.consumeWindowOnce.bind(store)
    let calls = 0
    jest.spyOn(store, 'consumeWindowOnce').mockImplementation((application, windowStart, change, limits) => {
      calls += 1
      return calls === 2 ? Promise.reject(new Error('store down')) : original(application, windowStart, change, limits)
    })
    await expect(service.consume(context(), delta(30n), undefined, 'call-1')).rejects.toThrow('store down')
    await service.consume(context(), delta(30n), undefined, 'call-1')
    expect((await store.getWindow(first.id, MONTH))?.spentNanoUsd).toBe(30n)
    expect((await store.getWindow(second.id, MONTH))?.spentNanoUsd).toBe(30n)
  })

  /** A block on a later budget gives back what the earlier budgets recorded under the key, so the key can be tried again. */
  it('gives back the earlier budgets under the key when a later budget blocks', async () => {
    const { service, store } = makeService()
    const first = await service.upsertBudget(budgetInput({ limitNanoUsd: 1_000n, scope: { type: 'tenant', id: TENANT } }))
    const second = await service.upsertBudget(budgetInput({ limitNanoUsd: 10n }))
    await expectRejectCode(service.consume(context(), delta(30n), undefined, 'call-1'), 'AI_TOKENS_BUDGET_EXCEEDED')
    expect((await store.getWindow(first.id, MONTH))?.spentNanoUsd ?? 0n).toBe(0n)
    expect((await store.getWindow(second.id, MONTH))?.spentNanoUsd ?? 0n).toBe(0n)
    await store.upsert({ ...(await store.findBudgetById({ tenantId: TENANT, id: second.id }))!, limitNanoUsd: 1_000n })
    await service.consume(context(), delta(30n), undefined, 'call-1')
    expect((await store.getWindow(first.id, MONTH))?.spentNanoUsd).toBe(30n)
  })
})

describe('BudgetService.consume under a key with a live counter', () => {
  /** The fast path increments the counter before the database says the key was already applied; that increment is given back. */
  it('leaves the counter where one application put it', async () => {
    const counter = new MapCounter()
    const { service, thresholds } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(85n), undefined, 'call-1')
    const crossed = thresholds.length
    expect(crossed).toBeGreaterThan(0)
    await service.consume(context(), delta(85n), undefined, 'call-1')
    expect(counter.values.get(costKey(budget.id))).toBe(85n)
    expect(thresholds).toHaveLength(crossed)
  })

  /** A retry the counter lets through still finds the application in the database: its increment is given back and nothing is signalled. */
  it('gives back the counter increment of a retry the database replays, and signals nothing', async () => {
    const counter = new MapCounter()
    const { service, store, thresholds } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(45n), undefined, 'call-1')
    await service.consume(context(), delta(45n), undefined, 'call-1')
    expect(counter.values.get(costKey(budget.id))).toBe(45n)
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(45n)
    expect(thresholds).toHaveLength(0)
  })

  /** With the counter down the database alone decides, and a replay there touches no counter. */
  it('replays through the database alone when the counter is unavailable', async () => {
    const counter = new MapCounter()
    jest.spyOn(counter, 'incrIfBelow').mockRejectedValue(new Error('counter down'))
    const decr = jest.spyOn(counter, 'decr')
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n), undefined, 'call-1')
    await service.consume(context(), delta(40n), undefined, 'call-1')
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(40n)
    expect(decr).not.toHaveBeenCalled()
  })

  /** A counter that already holds the call's own consumption rejects the retry: the database, which holds the application, decides. */
  it('does not block a retry that the counter rejects but the database has already applied', async () => {
    const counter = new MapCounter()
    const { service, store, thresholds } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(100n), undefined, 'call-1')
    const crossed = thresholds.length
    await expect(service.consume(context(), delta(100n), undefined, 'call-1')).resolves.toBeUndefined()
    expect(counter.values.get(costKey(budget.id))).toBe(100n)
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(100n)
    expect(thresholds).toHaveLength(crossed)
  })

  /** A counter that is stale-high rejects a new key that the database accepts: the database decides, and the spend is new, so it is signalled. */
  it('lets the database accept a new key that a stale-high counter rejects, and signals the new spend', async () => {
    const counter = new MapCounter()
    const { service, store, thresholds } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    counter.values.set(costKey(budget.id), 100n)
    await expect(service.consume(context(), delta(85n), undefined, 'call-1')).resolves.toBeUndefined()
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(85n)
    expect(thresholds.length).toBeGreaterThan(0)
  })

  /** When the counter rejects and the database refuses too, the call is blocked with the counter's dimension. */
  it('still blocks a new key that both the counter and the database refuse', async () => {
    const counter = new MapCounter()
    const { service } = makeService({ options: { counter } })
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(100n), undefined, 'call-1')
    await expectRejectCode(service.consume(context(), delta(10n), undefined, 'call-2'), 'AI_TOKENS_BUDGET_EXCEEDED')
  })
})

describe('BudgetService.release and adjust under a key', () => {
  /** A release with the consume's key gives back what that key recorded, once; the second release changes nothing. */
  it('gives back what the key recorded, once', async () => {
    const counter = new MapCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(30n))
    await service.consume(context(), delta(40n), undefined, 'call-1')
    await service.release(context(), delta(40n), undefined, 'call-1')
    await service.release(context(), delta(40n), undefined, 'call-1')
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(30n)
    expect(counter.values.get(costKey(budget.id))).toBe(30n)
  })

  /** A release of a movement that predates keys has no application to give back, so it subtracts the delta as before. */
  it('subtracts the delta when no application was recorded under the key', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    await service.release(context(), delta(15n), undefined, 'older-hold')
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(25n)
  })

  /** The key can be consumed again after it was given back, which is what a retry after a withdrawn attempt needs. */
  it('lets the key be consumed again after it was given back', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n), undefined, 'call-1')
    await service.release(context(), delta(40n), undefined, 'call-1')
    await service.consume(context(), delta(40n), undefined, 'call-1')
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(40n)
  })

  /** An adjust under a key moves each window once, and its counter with it. */
  it('adjusts once per key, window and counter alike', async () => {
    const counter = new MapCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.adjust(context(), delta(30n), undefined, 'capture:r1')
    expect(counter.values.get(costKey(budget.id))).toBe(30n)
    await service.adjust(context(), delta(30n), undefined, 'capture:r1')
    expect((await store.getWindow(budget.id, MONTH))?.spentNanoUsd).toBe(30n)
    expect(counter.values.get(costKey(budget.id))).toBe(30n)
  })
})
