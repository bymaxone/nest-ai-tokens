/**
 * @fileoverview `BudgetService` paths that go through the live counter: the §10.8
 * fast path and `adjust` (§11.2).
 *
 * These are the paths where the counter store is the authority and the database is
 * the resync source, so they need a counter fake with configurable outage modes;
 * `budget.service.spec.ts` covers the paths that never reach a counter. The subject
 * factories come from `test/fakes/budget-fixtures`.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { IBudgetCounterStore } from '../interfaces'
import { delta } from '../../../test/contracts/budget-store.contract'
import { TENANT, USER_SCOPE, budgetInput, context, expectRejectCode, makeService } from '../../../test/fakes/budget-fixtures'

/** An in-memory budget counter with configurable outage modes. */
class FakeCounter implements IBudgetCounterStore {
  readonly values = new Map<string, bigint>()
  readonly resetKeys: string[] = []
  failIncr = false
  failDecr = false
  failReset = false
  /** When set, an amount or limit beyond this bound throws — modeling the Redis safe-integer signal. */
  safeMax?: bigint

  incrIfBelow(key: string, amount: bigint, limit: bigint, _ttlSeconds: number): Promise<boolean> {
    if (this.failIncr) return Promise.reject(new Error('counter down'))
    const next = (this.values.get(key) ?? 0n) + amount
    if (this.safeMax !== undefined && (amount > this.safeMax || limit > this.safeMax || next > this.safeMax)) {
      return Promise.reject(new Error('counter value exceeds the safe-integer range'))
    }
    if (next > limit) return Promise.resolve(false)
    this.values.set(key, next)
    return Promise.resolve(true)
  }

  decr(key: string, amount: bigint): Promise<void> {
    if (this.failDecr) return Promise.reject(new Error('decr down'))
    const next = (this.values.get(key) ?? 0n) - amount
    this.values.set(key, next < 0n ? 0n : next)
    return Promise.resolve()
  }

  reset(key: string): Promise<void> {
    this.resetKeys.push(key)
    if (this.failReset) return Promise.reject(new Error('reset down'))
    this.values.delete(key)
    return Promise.resolve()
  }
}

/** The cost counter key for a budget's current (calendar-month) window under the fixed clock. */
function costKey(budgetId: string): string {
  return `ai_tokens:budget:${budgetId}:2026-06-01T00:00:00.000Z:cost`
}

/** The count counter key for a budget's current (calendar-month) window under the fixed clock. */
function countKey(budgetId: string): string {
  return `ai_tokens:budget:${budgetId}:2026-06-01T00:00:00.000Z:count`
}

describe('BudgetService.adjust (capture ±delta, §11.2)', () => {
  /** A positive adjust records extra spend and increments the counter unconditionally. */
  it('applies a positive delta to the window and counter', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    await service.adjust(context(), delta(30n))
    expect(counter.values.get(costKey(budget.id))).toBe(70n)
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(70n)
  })

  /** A negative adjust releases window spend and decrements the counter. */
  it('applies a negative delta to the window and counter', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    await service.adjust(context(), delta(-15n))
    expect(counter.values.get(costKey(budget.id))).toBe(25n)
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(25n)
  })

  /**
   * A negative adjust larger than the counter balance decrements (flooring at zero) rather
   * than falling through to the unbounded increment — kills the `amount < 0n` guard mutants
   * (CE→false and empty-block): both would route the negative amount through `incrIfBelow`,
   * whose additive path (no floor) would leave the counter below zero instead of at zero.
   */
  it('decrements the counter on a negative adjust below the balance, flooring at zero', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(10n)) // counter = 10
    await service.adjust(context(), delta(-15n)) // decr 15 → floors at 0; the incrIfBelow fallthrough would land -5
    expect(counter.values.get(costKey(budget.id))).toBe(0n)
  })

  /**
   * A normal positive adjust whose increment fits under the int64 ceiling returns early and
   * never resyncs — kills the CE→false mutant on the `incrIfBelow` guard, which would always
   * fall through to the reset+reseed path even on a successful, non-overflowing increment.
   */
  it('does not resync the counter on a positive adjust that fits under the ceiling', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n)) // counter = 40
    await service.adjust(context(), delta(30n)) // incrIfBelow succeeds → must NOT reset the key
    expect(counter.values.get(costKey(budget.id))).toBe(70n)
    expect(counter.resetKeys).not.toContain(costKey(budget.id))
  })

  /**
   * A counter outage during adjust is logged, never thrown; the DB window still moves.
   * The DB window moves before the counter, so the `spentNanoUsd` assertion holds under the
   * empty-catch mutant too — asserting the `logger.warn` fires is what kills the catch-body
   * BlockStatement mutant (emptying `catch { this.logger.warn(...) }` swallows silently).
   */
  it('logs a counter failure without throwing', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    counter.failIncr = true
    counter.failDecr = true
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await service.adjust(context(), delta(10n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(50n)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to adjust budget counter'))
    warn.mockRestore()
  })

  /** A first-ever adjust (no window row yet) seeds the counter from a zero baseline. */
  it('adjusts from a zero window baseline when none exists yet', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.adjust(context(), delta(30n)) // no prior consume → the window read is null → ZERO_SPEND
    expect(counter.values.get(costKey(budget.id))).toBe(30n)
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(30n)
  })

  /**
   * When incrIfBelow returns false at the int64 ceiling (no throw), the increment cannot
   * land and would leave the counter BELOW the authoritative DB window; adjust discards the
   * diverged value and reseeds it to the window spend so the fast path never trusts a stale
   * number.
   */
  it('resyncs the counter to the database window when incrIfBelow overflows the int64 ceiling', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n)) // window = counter = 40
    counter.values.set(costKey(budget.id), 9_223_372_036_854_775_807n) // counter driven to the int64 ceiling
    await service.adjust(context(), delta(10n)) // DB window → 50; the increment cannot land
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(50n)
    expect(counter.values.get(costKey(budget.id))).toBe(50n) // resynced to the window, not left at the ceiling
    expect(counter.resetKeys).toContain(costKey(budget.id)) // the diverged value was invalidated first
  })

  /** Without a counter, adjust moves only the DB window. */
  it('adjusts the window with no counter configured', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    await service.adjust(context(), delta(-10n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(30n)
  })
})

describe('BudgetService — live counter fast path (§10.8)', () => {
  /** The counter fast path increments within the limit, then the DB records the consume. */
  it('consumes through the counter and the database', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    expect(counter.values.get(costKey(budget.id))).toBe(40n)
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(40n)
  })

  /** An over-limit counter reject blocks without touching the database. */
  it('rejects via the counter without a database write', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    counter.values.set(costKey(budget.id), 100n) // counter already full
    await expectRejectCode(service.consume(context(), delta(1n)), 'AI_TOKENS_BUDGET_EXCEEDED')
    expect(await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z'))).toBeNull() // DB untouched
  })

  /**
   * A count-quota block detected on the counter fast path reports the QUOTA code (429), not
   * the spend code — even though the DB window (still zero) would otherwise infer a spend
   * block. The failing dimension is threaded from the fast-path reject into the exception.
   */
  it('reports the quota code for a count block on the counter fast path (429)', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: undefined, limitCount: 1 }))
    counter.values.set(countKey(budget.id), 1n) // count counter already at the limit
    await expectRejectCode(service.consume(context(), delta(0n, 0, 1)), 'AI_TOKENS_QUOTA_EXCEEDED')
    expect(await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z'))).toBeNull() // DB untouched
  })

  /** A partial counter pass on one dimension is rolled back when another rejects. */
  it('rolls back a partial counter increment on a multi-dimension reject', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, limitTokens: 10 }))
    await expectRejectCode(service.consume(context(), delta(50n, 20)), 'AI_TOKENS_QUOTA_EXCEEDED')
    expect(counter.values.get(costKey(budget.id)) ?? 0n).toBe(0n) // cost increment rolled back
  })

  /** A counter pass but a DB shortfall rolls the counter back and blocks. */
  it('rolls back the counter when the database rejects', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    store.forceWindow(budget.id, new Date('2026-06-01T00:00:00.000Z'), { spentNanoUsd: 100n, spentTokens: 0, spentCount: 0 })
    await expectRejectCode(service.consume(context(), delta(1n)), 'AI_TOKENS_BUDGET_EXCEEDED')
    expect(counter.values.get(costKey(budget.id)) ?? 0n).toBe(0n)
  })

  /** An unavailable counter falls back to the authoritative database (fail-closed still consumes). */
  it('falls back to the database when the counter is down', async () => {
    const counter = new FakeCounter()
    counter.failIncr = true
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(40n)
  })

  /**
   * A near-2^53 nano-USD amount is beyond the counter's safe-integer range, so the
   * counter signals unavailable and the service falls back to the exact int64 DB path
   * (which records the full amount without precision loss) rather than a wrong compare.
   */
  it('falls back to the database when the counter value exceeds the safe-integer range', async () => {
    const counter = new FakeCounter()
    counter.safeMax = 9_007_199_254_740_991n // 2^53 - 1, the Redis Lua safe bound
    const limit = 9_007_199_254_740_993n // 2^53 + 1
    const amount = 9_007_199_254_740_992n // 2^53 — beyond the counter's safe range
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: limit }))
    await service.consume(context(), delta(amount))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(amount)
  })

  /** Counter down AND database down with failClosed blocks with a store error. */
  it('blocks when both the counter and database are down (failClosed)', async () => {
    const counter = new FakeCounter()
    counter.failIncr = true
    const { service, store } = makeService({ options: { counter, failClosed: true } })
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    jest.spyOn(store, 'conditionalConsume').mockRejectedValue(new Error('db down'))
    await expectRejectCode(service.consume(context(), delta(40n)), 'AI_TOKENS_STORE_ERROR')
  })

  /** A database outage with failClosed disabled allows the call (fail open) after rolling the counter back. */
  it('allows on a database outage when failClosed is disabled', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter, failClosed: false } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    jest.spyOn(store, 'conditionalConsume').mockRejectedValue(new Error('db down'))
    await expect(service.consume(context(), delta(40n))).resolves.toBeUndefined()
    expect(counter.values.get(costKey(budget.id)) ?? 0n).toBe(0n) // counter rolled back
  })

  /**
   * A block failure rolls back a sibling budget's live counter, best-effort even if decr fails.
   * Asserting the `logger.warn` fires kills the catch-body BlockStatement mutant in
   * `decrCounters` (emptying `catch { this.logger.warn(...) }`): an empty body swallows the
   * failed rollback silently, which the BUDGET_EXCEEDED assertion alone cannot observe.
   */
  it('rolls back a sibling counter on a partial multi-budget failure', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const wide = await service.upsertBudget(budgetInput({ scope: { type: 'tenant', id: TENANT }, limitNanoUsd: 1_000n }))
    await service.upsertBudget(budgetInput({ scope: USER_SCOPE, limitNanoUsd: 10n }))
    counter.failDecr = true // rollback decr fails → logged, never thrown
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await expectRejectCode(service.consume(context(), delta(50n)), 'AI_TOKENS_BUDGET_EXCEEDED')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to roll back budget counter'))
    warn.mockRestore()
    void wide
  })

  /** release decrements the live counter across matching budgets. */
  it('releases the counter on release', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    await service.release(context(), delta(40n))
    expect(counter.values.get(costKey(budget.id)) ?? 0n).toBe(0n)
  })

  /**
   * rotateWindow resets the counter keys for the new window, tolerating a reset failure.
   * Asserting the `logger.warn` fires on the failing reset kills the catch-body BlockStatement
   * mutant (emptying `catch { this.logger.warn(...) }` — a silent swallow that the resolve
   * assertion alone cannot observe, since rotateWindow resolves either way).
   */
  it('resets counter keys on rotation', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.rotateWindow(budget.id, new Date('2026-06-20T00:00:00.000Z'))
    expect(counter.resetKeys.some((key) => key.includes(':cost'))).toBe(true)
    counter.failReset = true
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await expect(service.rotateWindow(budget.id, new Date('2026-06-21T00:00:00.000Z'))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to reset budget counter for'))
    warn.mockRestore()
  })

  /**
   * A non-zero token delta flows through the token counter — kills the token
   * counter-dimension mutants: `delta.tokens !== 0` → `=== 0` would skip the (non-zero)
   * token dimension, and the empty-block mutation would never push it, so the token counter
   * would stay unset instead of holding the incremented amount.
   */
  it('flows the token dimension through the counter', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, limitTokens: 100 }))
    await service.consume(context(), delta(10n, 30)) // non-zero token delta
    const tokenKey = `ai_tokens:budget:${budget.id}:2026-06-01T00:00:00.000Z:tokens`
    expect(counter.values.get(tokenKey)).toBe(30n)
  })

  /** The count dimension flows through the counter; a zero-delta dimension is skipped. */
  it('consumes the count dimension through the counter', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, limitTokens: 100, limitCount: 5 }))
    await service.consume(context(), delta(0n, 0, 1)) // count only; cost and token deltas are 0 → skipped
    const countKey = `ai_tokens:budget:${budget.id}:2026-06-01T00:00:00.000Z:count`
    expect(counter.values.get(countKey)).toBe(1n)
  })

  /** A counter outage followed by a database rejection blocks without a counter rollback. */
  it('blocks when the counter is down and the database rejects', async () => {
    const counter = new FakeCounter()
    counter.failIncr = true
    const { service, store } = makeService({ options: { counter, failClosed: true } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    store.forceWindow(budget.id, new Date('2026-06-01T00:00:00.000Z'), { spentNanoUsd: 100n, spentTokens: 0, spentCount: 0 })
    await expectRejectCode(service.consume(context(), delta(1n)), 'AI_TOKENS_BUDGET_EXCEEDED')
  })

  /**
   * When the counter fast-path succeeds but the authoritative DB consume then rejects,
   * the counter must be rolled back — kills BooleanLiteral mutation on `available: true`
   * (mutation sets available=false so counterAvailable=false → skips decrCounters).
   */
  it('rolls back the counter when the database rejects a consume within limits', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter, failClosed: true } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    // Pre-fill DB window to the limit so the next consume is rejected by the DB
    store.forceWindow(budget.id, new Date('2026-06-01T00:00:00.000Z'), { spentNanoUsd: 100n, spentTokens: 0, spentCount: 0 })
    // Counter is still at 0 (counter and DB are now out of sync — the fast path will succeed then DB rejects)
    await expectRejectCode(service.consume(context(), delta(1n)), 'AI_TOKENS_BUDGET_EXCEEDED')
    // The counter fast-path incremented by 1, then the DB rejection triggered a rollback decrement
    expect(counter.values.get(costKey(budget.id)) ?? 0n).toBe(0n)
  })

  /** A total-window budget uses the long counter TTL without error. */
  it('supports a total-window counter', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ window: 'total', limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    const key = `ai_tokens:budget:${budget.id}:${budget.createdAt.toISOString()}:cost` // total → windowStart = createdAt
    expect(counter.values.get(key)).toBe(40n)
  })
})
