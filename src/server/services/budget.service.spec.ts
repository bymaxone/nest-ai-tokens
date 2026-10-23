import { LedgerService } from './ledger.service'
import { BudgetService } from './budget.service'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { runBudgetStoreContract, delta } from '../../../test/contracts/budget-store.contract'
import { NOW, TENANT, USER_SCOPE, budgetInput, context, expectRejectCode, makeService, usageRecord } from '../../../test/fakes/budget-fixtures'

describe('BudgetService — CRUD (§10.5)', () => {
  /** upsertBudget defaults softThresholds/policy from options and emits audit. */
  it('creates a budget with defaults and audits', async () => {
    const { service, audits } = makeService()
    const budget = await service.upsertBudget(budgetInput())
    expect(budget.softThresholds).toEqual([0.8, 1])
    expect(budget.policy).toBe('block')
    expect(audits).toContain('ai_tokens.budget.upserted')
  })

  /** A present limit of 0 is a valid hard block (§10.2). */
  it('accepts a zero limit as a hard block', async () => {
    const { service } = makeService()
    await expect(service.upsertBudget(budgetInput({ limitNanoUsd: 0n }))).resolves.toBeDefined()
  })

  /** Negative limits on any dimension are rejected (§10.2). */
  it('rejects negative limits', async () => {
    const { service } = makeService()
    await expectRejectCode(service.upsertBudget(budgetInput({ limitNanoUsd: -1n })), 'AI_TOKENS_INVALID_CONFIG')
    await expectRejectCode(service.upsertBudget(budgetInput({ limitNanoUsd: undefined, limitTokens: -1 })), 'AI_TOKENS_INVALID_CONFIG')
    await expectRejectCode(service.upsertBudget(budgetInput({ limitNanoUsd: undefined, limitCount: -1 })), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** A budget with no limit dimension is rejected. */
  it('rejects a budget with no limit dimension', async () => {
    const { service } = makeService()
    await expectRejectCode(service.upsertBudget(budgetInput({ limitNanoUsd: undefined })), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** A soft threshold outside (0, 1] is rejected — threshold=0 kills EQ mutation (> 0 → >= 0 would let 0 through). */
  it('rejects an out-of-range soft threshold', async () => {
    const { service } = makeService()
    await expectRejectCode(service.upsertBudget(budgetInput({ softThresholds: [1.5] })), 'AI_TOKENS_INVALID_CONFIG')
    await expectRejectCode(service.upsertBudget(budgetInput({ softThresholds: [0] })), 'AI_TOKENS_INVALID_CONFIG')
    await expectRejectCode(service.upsertBudget(budgetInput({ softThresholds: [-0.1] })), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** removeBudget audits. */
  it('removes a budget and audits', async () => {
    const { service, store, audits } = makeService()
    const budget = await service.upsertBudget(budgetInput())
    await service.removeBudget(budget.id, TENANT)
    expect(await store.findBudgetById(budget.id)).toBeNull()
    expect(audits).toContain('ai_tokens.budget.removed')
  })

  /** list returns applicable budgets, defaulting to tenant-wide. */
  it('lists budgets for a scope and tenant-wide', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ scope: USER_SCOPE }))
    await service.upsertBudget(budgetInput({ scope: { type: 'tenant', id: TENANT } }))
    expect(await service.list(TENANT, USER_SCOPE)).toHaveLength(2) // user + tenant-wide
    expect(await service.list(TENANT)).toHaveLength(1) // tenant-wide only
  })

  /** rotateWindow re-anchors, zeroes the current window, and audits. */
  it('rotates a window and re-anchors', async () => {
    const { service, store, audits } = makeService()
    const budget = await service.upsertBudget(budgetInput())
    await service.consume(context(), delta(40n))
    await service.rotateWindow(budget.id, new Date('2026-06-20T00:00:00.000Z'))
    const rotated = await store.findBudgetById(budget.id)
    expect(rotated?.anchorAt).toEqual(new Date('2026-06-20T00:00:00.000Z'))
    expect((await store.getWindow(budget.id, new Date('2026-06-20T00:00:00.000Z')))?.spentNanoUsd).toBe(0n)
    expect(audits).toContain('ai_tokens.budget.rotated')
  })

  /** rotateWindow defaults the new start to now. */
  it('rotates to now by default', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput())
    await service.rotateWindow(budget.id)
    expect((await store.findBudgetById(budget.id))?.anchorAt).toEqual(NOW)
  })

  /** rotateWindow on a missing budget throws. */
  it('rejects rotate on a missing budget', async () => {
    const { service } = makeService()
    await expectRejectCode(service.rotateWindow('nope'), 'AI_TOKENS_INVALID_CONFIG')
  })
})

describe('BudgetService — enforcement (§10.7/§10.8)', () => {
  /** A block budget within its limit consumes and updates the window. */
  it('consumes within a block budget', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(40n)
  })

  /** A cost-exceeded block budget throws 402 and emits exceeded. */
  it('blocks on the cost dimension (402)', async () => {
    const { service, exceeded } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await expectRejectCode(service.consume(context(), delta(150n)), 'AI_TOKENS_BUDGET_EXCEEDED')
    expect(exceeded[0]?.dimension).toBe('cost')
  })

  /**
   * Consuming exactly AT the limit (spend === limit) is allowed — kills EQ mutation on
   * `failingDimensionOrNull` (spend > limit → spend >= limit would block at-limit spend).
   */
  it('allows a consume that lands exactly at the limit', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, limitTokens: 50, limitCount: 3 }))
    await service.consume(context(), delta(100n, 50, 3)) // exactly at all three limits
    const window = await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z'))
    expect(window?.spentNanoUsd).toBe(100n)
    expect(window?.spentTokens).toBe(50)
    expect(window?.spentCount).toBe(3)
  })

  /** A token-exceeded block budget throws 429. */
  it('blocks on the token dimension (429)', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: undefined, limitTokens: 100 }))
    await expectRejectCode(service.consume(context(), delta(0n, 150)), 'AI_TOKENS_QUOTA_EXCEEDED')
  })

  /** A count-exceeded block budget throws 429. */
  it('blocks on the count dimension (429)', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: undefined, limitCount: 1 }))
    await service.consume(context(), delta(0n, 0, 1))
    await expectRejectCode(service.consume(context(), delta(0n, 0, 1)), 'AI_TOKENS_QUOTA_EXCEEDED')
  })

  /** The feature filter scopes consumption; a non-matching feature is untouched. */
  it('applies the feature filter', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ features: ['workout.generate'] }))
    await service.consume(context({ feature: 'embeddings' }), delta(40n))
    expect(await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z'))).toBeNull()
    await service.consume(context({ feature: 'workout.generate' }), delta(40n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(40n)
  })

  /**
   * An empty features array is a match-all filter — kills the `features.length === 0`
   * clause of `featureMatches` (forcing it false would fall through to `[].includes(...)`,
   * which is always false, wrongly excluding every feature from an empty-filter budget).
   */
  it('treats an empty features filter as matching every feature', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ features: [] }))
    await service.consume(context({ feature: 'anything' }), delta(40n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(40n)
  })

  /** A block failure on one budget rolls back the sibling consumed in the same call. */
  it('rolls back every budget on a partial failure', async () => {
    const { service, store } = makeService()
    const wide = await service.upsertBudget(budgetInput({ scope: { type: 'tenant', id: TENANT }, limitNanoUsd: 1_000n }))
    const tight = await service.upsertBudget(budgetInput({ scope: USER_SCOPE, limitNanoUsd: 10n }))
    await expectRejectCode(service.consume(context(), delta(50n)), 'AI_TOKENS_BUDGET_EXCEEDED')
    const wideWindow = await store.getWindow(wide.id, new Date('2026-06-01T00:00:00.000Z'))
    const tightWindow = await store.getWindow(tight.id, new Date('2026-06-01T00:00:00.000Z'))
    expect(wideWindow?.spentNanoUsd ?? 0n).toBe(0n) // rolled back
    expect(tightWindow?.spentNanoUsd ?? 0n).toBe(0n) // never consumed
  })

  /** A misbehaving store that rejects within limits still throws a typed budget error (fallback). */
  it('throws a budget error when the store rejects within limits', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    jest.spyOn(store, 'conditionalConsume').mockResolvedValue(false)
    await expectRejectCode(service.consume(context(), delta(1n)), 'AI_TOKENS_BUDGET_EXCEEDED')
    void budget
  })

  /** release subtracts the delta from every matching window. */
  it('releases spend across matching budgets', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    await service.release(context(), delta(40n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(0n)
  })
})

describe('BudgetService — soft policies (§10.4)', () => {
  /** An allow budget records spend and emits exceeded past its limit, never throwing. */
  it('allows and alerts past the limit', async () => {
    const { service, store, exceeded } = makeService()
    const budget = await service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: 100n }))
    await service.consume(context(), delta(150n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(150n)
    expect(exceeded[0]?.policy).toBe('allow')
  })

  /** An allow budget within its limit records spend without an exceeded event. */
  it('allows within the limit without alerting', async () => {
    const { service, exceeded } = makeService()
    await service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    expect(exceeded).toHaveLength(0)
  })

  /**
   * An allow budget whose spend lands EXACTLY at every limit fires no exceeded event —
   * kills the boundary mutants on `failingDimensionOrNull`: `spend > limit` → `>=` (or a
   * forced-true condition) would treat at-limit spend on any of the three dimensions as
   * over-limit and wrongly emit exceeded.
   */
  it('does not flag an allow budget whose spend lands exactly at every limit', async () => {
    const { service, exceeded } = makeService()
    await service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: 100n, limitTokens: 50, limitCount: 3 }))
    await service.consume(context(), delta(100n, 50, 3)) // exactly at all three limits — over none
    expect(exceeded).toHaveLength(0)
  })

  /** A throttle budget invokes the host callback past its limit and allows the call. */
  it('invokes the throttle callback past the limit', async () => {
    const seen: string[] = []
    const { service } = makeService({ options: { onThrottle: (ctx): void => void seen.push(ctx.budget.id) } })
    const budget = await service.upsertBudget(budgetInput({ policy: 'throttle', limitNanoUsd: 100n }))
    await service.consume(context(), delta(150n))
    expect(seen).toEqual([budget.id])
  })

  /** A throttle budget with no callback warns and allows. */
  it('warns and allows when no throttle callback is configured', async () => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ policy: 'throttle', limitNanoUsd: 100n }))
    await expect(service.consume(context(), delta(150n))).resolves.toBeUndefined()
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(150n)
  })
})

describe('BudgetService — thresholds & projection (§10.4)', () => {
  /** Crossing 80% then 100% emits each threshold once per window across separate consumes. */
  it('emits each threshold once per window', async () => {
    const { service, thresholds } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, softThresholds: [0.8, 1] }))
    await service.consume(context(), delta(80n)) // crosses 0.8
    await service.consume(context(), delta(19n)) // 0.99, no new threshold
    await service.consume(context(), delta(1n)) // crosses 1.0
    expect(thresholds.map((t) => t.threshold)).toEqual([0.8, 1])
  })

  /**
   * Threshold dedupe is per-budget-window, not global — kills the empty-string mutation of
   * `windowKey`: collapsing every budget's dedupe key to "" would let the first budget's
   * emitted threshold suppress the second budget crossing the same threshold in one call.
   */
  it('dedupes thresholds per budget window, not globally', async () => {
    const { service, thresholds } = makeService()
    await service.upsertBudget(budgetInput({ scope: { type: 'tenant', id: TENANT }, limitNanoUsd: 100n, softThresholds: [0.8] }))
    await service.upsertBudget(budgetInput({ scope: USER_SCOPE, limitNanoUsd: 100n, softThresholds: [0.8] }))
    await service.consume(context(), delta(80n)) // both budgets cross 0.8 in the same call
    expect(thresholds).toHaveLength(2) // one per budget; a shared "" key would suppress the second
  })

  /** A single delta that leaps past both thresholds emits both, once. */
  it('emits both thresholds crossed by one delta', async () => {
    const { service, thresholds } = makeService()
    await service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: 100n, softThresholds: [0.8, 1] }))
    await service.consume(context(), delta(120n))
    expect(thresholds.map((t) => t.threshold)).toEqual([0.8, 1])
  })

  /** A burn rate projecting past the limit before reset fires projected_exceeded once. */
  it('projects overage before reset', async () => {
    const { service, projected } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, softThresholds: [0.95] }))
    await service.consume(context(), delta(50n)) // 0.5 at day 14 of 30 → projects over before reset
    await service.consume(context(), delta(1n)) // dedupe: no second projection
    expect(projected).toHaveLength(1)
  })

  /** A slow burn that will not cross before reset fires no projection. */
  it('does not project a slow burn', async () => {
    const { service, projected } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, softThresholds: [0.95] }))
    await service.consume(context(), delta(20n)) // 0.2 at day 14 → projected past reset
    expect(projected).toHaveLength(0)
  })

  /** A total-window budget never projects (no reset boundary). */
  it('does not project a total window', async () => {
    const { service, projected } = makeService()
    await service.upsertBudget(budgetInput({ window: 'total', limitNanoUsd: 100n, softThresholds: [0.95] }))
    await service.consume(context(), delta(50n))
    expect(projected).toHaveLength(0)
  })

  /** A zero-cost consume neither crosses a threshold nor projects. */
  it('is inert for a zero-fraction consume', async () => {
    const { service, thresholds, projected } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(0n))
    expect(thresholds).toHaveLength(0)
    expect(projected).toHaveLength(0)
  })

  /** A consume exactly at window start (zero elapsed) does not project. */
  it('does not project at zero elapsed time', async () => {
    let clock = new Date('2026-06-01T00:00:00.000Z') // exactly the calendar month start
    const { service, projected } = makeService({ now: () => clock })
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, softThresholds: [0.95] }))
    clock = new Date('2026-06-01T00:00:00.000Z')
    await service.consume(context(), delta(50n))
    expect(projected).toHaveLength(0)
  })

  /** fraction >= 1 (fully used) does not project — kills EQ mutation (fraction > 1 would let fraction=1 through). */
  it('does not project when fraction is exactly 1', async () => {
    const { service, projected } = makeService()
    await service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: 100n, softThresholds: [0.95] }))
    await service.consume(context(), delta(100n)) // fraction = 1.0 exactly
    expect(projected).toHaveLength(0)
  })

  /** A burn rate exactly matching the elapsed fraction projects to windowEnd — does NOT emit (kills EQ >= → >). */
  it('does not project when projected crossing is exactly at the window end', async () => {
    // 15 days in, 50% spent → projectedAt = windowStart + 30days = windowEnd exactly.
    // Original (>=): projectedAt >= windowEnd → returns early (no projection).
    // Mutation (>):  projectedAt > windowEnd → false → would emit projection.
    const midMonth = new Date('2026-06-16T00:00:00.000Z')
    const { service, projected } = makeService({ now: () => midMonth })
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, softThresholds: [0.95] }))
    await service.consume(context(), delta(50n)) // 50% at 50% of window → projects exactly at reset
    expect(projected).toHaveLength(0)
  })
})

describe('BudgetService — reconcile & status (§10.6/§10.7)', () => {
  /** reconcileWindow recomputes the window from the ledger, including a reversal net. */
  it('reconciles a window from the ledger', async () => {
    const { service, store, ledgerStore } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 1_000n }))
    await ledgerStore.append(usageRecord({ idempotencyKey: 'a', billedCostNanoUsd: 25n }), 'ha')
    await ledgerStore.append(usageRecord({ idempotencyKey: 'b', billedCostNanoUsd: 30n }), 'hb')
    await ledgerStore.append(usageRecord({ idempotencyKey: 'sys', billedCostNanoUsd: 99n, isSystemCost: true }), 'hs')
    const windowStart = new Date('2026-06-01T00:00:00.000Z')
    await service.reconcileWindow(budget.id, windowStart)
    const window = await store.getWindow(budget.id, windowStart)
    expect(window?.spentNanoUsd).toBe(55n) // 25 + 30; system cost excluded
    expect(window?.spentCount).toBe(2)
    // spentTokens: 100 + 100 = 200 (each usageRecord defaults to totalTokens: 100)
    expect(window?.spentTokens).toBe(200)
  })

  /** A second reconcile recomputes the delta correctly (kills ArithmeticOperator + vs - mutations on delta calc). */
  it('reconcile called twice produces the correct idempotent window — delta must subtract, not add, the prior window', async () => {
    const { service, store, ledgerStore } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 1_000n, limitTokens: 10_000 }))
    const windowStart = new Date('2026-06-01T00:00:00.000Z')

    // First reconcile: one record → window should reflect just that record.
    await ledgerStore.append(usageRecord({ idempotencyKey: 'a', billedCostNanoUsd: 25n, totalTokens: 100 }), 'ha')
    await service.reconcileWindow(budget.id, windowStart)
    expect((await store.getWindow(budget.id, windowStart))?.spentNanoUsd).toBe(25n)

    // Second reconcile: same + one more record → window should reflect both, NOT be inflated.
    // With the + mutation (computed + current instead of computed - current), the delta would be
    // 55 + 25 = 80 added to the existing 25 → 105, not the correct 55.
    await ledgerStore.append(usageRecord({ idempotencyKey: 'b', billedCostNanoUsd: 30n, totalTokens: 200 }), 'hb')
    await service.reconcileWindow(budget.id, windowStart)
    const window = await store.getWindow(budget.id, windowStart)
    expect(window?.spentNanoUsd).toBe(55n)   // 25 + 30 total, not 25 + 80
    expect(window?.spentTokens).toBe(300)     // 100 + 200 total
    expect(window?.spentCount).toBe(2)
  })

  /** reconcileWindow handles a 'total' window (no upper bound). */
  it('reconciles a total window', async () => {
    const { service, store, ledgerStore } = makeService()
    const budget = await service.upsertBudget(budgetInput({ window: 'total', limitNanoUsd: 1_000n }))
    await ledgerStore.append(usageRecord({ idempotencyKey: 'a', billedCostNanoUsd: 25n }), 'ha')
    const windowStart = new Date('2026-06-01T00:00:00.000Z')
    await service.reconcileWindow(budget.id, windowStart)
    expect((await store.getWindow(budget.id, windowStart))?.spentNanoUsd).toBe(25n)
  })

  /** reconcileWindow on a missing budget throws. */
  it('rejects reconcile on a missing budget', async () => {
    const { service } = makeService()
    await expectRejectCode(service.reconcileWindow('nope', NOW), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** remaining is floored at 0n when an allow-policy budget is over-consumed — kills CE→false on max0. */
  it('reports remaining as 0 (not negative) when an allow budget is over-consumed', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: 100n, limitTokens: 50 }))
    await service.consume(context(), delta(120n, 70, 1)) // over all limits
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.remaining.nanoUsd).toBe(0n) // max0(100-120=-20) = 0n, not -20n
    expect(status?.remaining.tokens).toBe(0)   // max(0, 50-70=-20) = 0
  })

  /** status reports live spend, remaining (limited dims only), and usedFraction. */
  it('reports status across dimensions', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, limitTokens: 1_000 }))
    await service.consume(context(), delta(40n, 200, 1))
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.spent).toEqual({ nanoUsd: 40n, tokens: 200, count: 1 })
    expect(status?.remaining).toEqual({ nanoUsd: 60n, tokens: 800 }) // count unlimited → absent
    expect(status?.usedFraction).toBeCloseTo(0.4) // max(0.4, 0.2)
    expect(status?.resetsAt).toEqual(new Date('2026-07-01T00:00:00.000Z'))
  })

  /**
   * The count remaining is `max(0, limit - spent)` — kills the count-dimension mutants on
   * `remainingSnapshot`: `Math.max` → `Math.min` (would report 0), the `-` → `+` operator
   * (would report limit + spent), and the `{ count }` object literal → `{}` (would drop the
   * field entirely).
   */
  it('reports the count remaining as limit minus spend', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: undefined, limitCount: 5 }))
    await service.consume(context(), delta(0n, 0, 2)) // 2 of 5 used
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.remaining.count).toBe(3) // max(0, 5 - 2)
  })

  /** A budget with no limit dimensions reports an empty remaining and zero usedFraction. */
  it('reports an unlimited budget as zero used', async () => {
    const { service, store } = makeService()
    const budget = await store.upsert({
      tenantId: TENANT,
      scope: USER_SCOPE,
      window: 'month',
      softThresholds: [],
      policy: 'allow',
    })
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.budgetId).toBe(budget.id)
    expect(status?.limit).toEqual({})
    expect(status?.remaining).toEqual({})
    expect(status?.usedFraction).toBe(0)
  })
})

describe('BudgetService — defaults & edge fractions', () => {
  /** The default no-op hooks let audit/threshold/exceeded/projection run without a dispatcher. */
  it('runs with default no-op hooks', async () => {
    let clock = new Date('2026-06-15T00:00:00.000Z')
    const store = new InMemoryBudgetStore({ now: () => clock })
    const ledger = new LedgerService(new InMemoryLedgerStore())
    const service = new BudgetService(store, ledger, {
      enabled: true,
      defaultPolicy: 'allow',
      alertThresholds: [0.8],
      failClosed: true,
    }, () => clock)
    await service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: 100n, softThresholds: [0.8] }))
    await service.consume(context(), delta(90n)) // 0.9 → threshold + projection no-ops
    clock = new Date('2026-06-15T00:00:00.000Z')
    await expect(service.consume(context(), delta(50n))).resolves.toBeUndefined() // over → exceeded no-op
  })

  /** The constructor's default clock and hooks are used when both are omitted. */
  it('constructs with default clock and hooks', async () => {
    const store = new InMemoryBudgetStore()
    const ledger = new LedgerService(new InMemoryLedgerStore())
    const service = new BudgetService(store, ledger, {
      enabled: true,
      defaultPolicy: 'block',
      alertThresholds: [0.8, 1],
      failClosed: true,
    })
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    const statuses = await service.status(TENANT, USER_SCOPE) // uses the default wall-clock now()
    expect(statuses).toHaveLength(1)
  })

  /** A zero-limit budget is fully used at zero spend and over-used beyond it (§10.2). */
  it('treats a zero limit as a hard block in usedFraction', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 0n, softThresholds: [1] }))
    const [blocked] = await service.status(TENANT, USER_SCOPE)
    expect(blocked?.usedFraction).toBe(1)

    const allow = makeService()
    await allow.service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: 0n, softThresholds: [1] }))
    await allow.service.consume(context(), delta(10n))
    const [over] = await allow.service.status(TENANT, USER_SCOPE)
    expect(over?.usedFraction).toBe(Number.POSITIVE_INFINITY)
  })

  /** status echoes a budget's features filter. */
  it('includes the features filter in status', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ features: ['workout.generate'] }))
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.features).toEqual(['workout.generate'])
  })

  /**
   * A nano-USD budget above `Number.MAX_SAFE_INTEGER` keeps full precision: a spend one
   * nano below the limit reports just under 1, where a lossy `Number()` on the operands
   * would round both to the same double and wrongly report the budget as 100% used.
   */
  it('computes usedFraction without nano-USD precision loss above 2^53', async () => {
    const { service } = makeService()
    const limit = 9_007_199_254_740_993n // 2^53 + 1 — beyond Number.MAX_SAFE_INTEGER
    await service.upsertBudget(budgetInput({ policy: 'allow', limitNanoUsd: limit, softThresholds: [1] }))
    await service.consume(context(), delta(limit - 1n)) // one nano below the cap
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.usedFraction).toBeLessThan(1) // a lossy Number() ratio would report exactly 1
    expect(status?.usedFraction).toBeGreaterThan(0.999)
  })
})

runBudgetStoreContract('in-memory fake', () => new InMemoryBudgetStore())
