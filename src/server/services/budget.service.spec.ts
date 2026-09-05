import { Logger } from '@nestjs/common'
import type {
  AiTokensErrorResponse,
  BudgetExceededEventData,
  BudgetProjectedExceededEventData,
  BudgetThresholdCrossedEventData,
  MeteringScope,
  NewUsageRecord,
} from '../../shared'
import type { IBudgetCounterStore, MeteringContext } from '../interfaces'
import { AiTokensException } from '../errors'
import { LedgerService } from './ledger.service'
import { BudgetService, COUNTER_DIMENSIONS, counterKey, windowKey, type BudgetEventHooks, type BudgetServiceOptions, type UpsertBudgetInput } from './budget.service'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { runBudgetStoreContract, delta } from '../../../test/contracts/budget-store.contract'

const TENANT = 't1'
const USER_SCOPE: MeteringScope = { type: 'user', id: 'u1' }
const NOW = new Date('2026-06-15T00:00:00.000Z')

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** Assert a promise rejects with a specific `AiTokensException` code. */
async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AiTokensException)
  expect(codeOf(thrown)).toBe(code)
}

/** A metering context (trusted input). */
function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: TENANT, scope: USER_SCOPE, feature: 'workout.generate', ...over }
}

/** A budget upsert input scoped to the user with a cost limit; explicit `undefined` overrides drop the key. */
function budgetInput(over: { [K in keyof UpsertBudgetInput]?: UpsertBudgetInput[K] | undefined } = {}): UpsertBudgetInput {
  const merged: Record<string, unknown> = { tenantId: TENANT, scope: USER_SCOPE, limitNanoUsd: 100n, window: 'month', ...over }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as UpsertBudgetInput
}

/** A recording budget event-hooks double. */
function recordingHooks(): {
  hooks: BudgetEventHooks
  thresholds: BudgetThresholdCrossedEventData[]
  exceeded: BudgetExceededEventData[]
  projected: BudgetProjectedExceededEventData[]
  audits: string[]
} {
  const thresholds: BudgetThresholdCrossedEventData[] = []
  const exceeded: BudgetExceededEventData[] = []
  const projected: BudgetProjectedExceededEventData[] = []
  const audits: string[] = []
  return {
    thresholds,
    exceeded,
    projected,
    audits,
    hooks: {
      thresholdCrossed: (_t, _s, data): void => void thresholds.push(data),
      exceeded: (_t, _s, data): void => void exceeded.push(data),
      projectedExceeded: (_t, _s, data): void => void projected.push(data),
      audit: (action): void => void audits.push(action),
    },
  }
}

/** A fresh service over in-memory fakes with an injected clock. */
function makeService(over: { options?: Partial<BudgetServiceOptions>; now?: () => Date } = {}): {
  service: BudgetService
  store: InMemoryBudgetStore
  ledgerStore: InMemoryLedgerStore
  thresholds: BudgetThresholdCrossedEventData[]
  exceeded: BudgetExceededEventData[]
  projected: BudgetProjectedExceededEventData[]
  audits: string[]
} {
  const now = over.now ?? ((): Date => NOW)
  const store = new InMemoryBudgetStore({ now })
  const ledgerStore = new InMemoryLedgerStore()
  const ledger = new LedgerService(ledgerStore)
  const rec = recordingHooks()
  const options: BudgetServiceOptions = {
    enabled: true,
    defaultPolicy: 'block',
    alertThresholds: [0.8, 1],
    failClosed: true,
    ...over.options,
  }
  const service = new BudgetService(store, ledger, options, now, rec.hooks)
  return { service, store, ledgerStore, ...rec }
}

/** Build a full usage record for ledger seeding. */
function usageRecord(over: Partial<NewUsageRecord> = {}): NewUsageRecord {
  return {
    tenantId: TENANT,
    scope: USER_SCOPE,
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    feature: 'workout.generate',
    tags: [],
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
    totalTokens: 100,
    priceVersionId: null,
    rawCostNanoUsd: 0n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 25n,
    markupMultiplier: 1,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    idempotencyKey: 'seed',
    isSystemCost: false,
    enforced: true,
    occurredAt: new Date('2026-06-10T00:00:00.000Z'),
    ...over,
  }
}

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

runBudgetStoreContract('in-memory fake', () => new InMemoryBudgetStore())

describe('composite key injectivity', () => {
  // `budgetId` is caller-supplied (`UpsertBudgetInput.id`) and unvalidated, and the
  // Prisma adapter honours it, so both keys are built from a field an attacker
  // controls. These assert the construction, not the input: the property must hold
  // however the id is spelled. Each `it` pins one of the three facts the property
  // rests on, so removing a fact fails here rather than silently opening a
  // cross-budget counter collision.

  /** A budget id that embeds both delimiters and a whole well-formed key tail. */
  const ADVERSARIAL = ['x', 'x:', 'x|', 'x:cost', 'x:tokens', 'x:2026-06-15T00:00:00.000Z', 'x:2026-06-15T00:00:00.000Z:cost', 'x|2026-06-15T00:00:00.000Z']
  const WINDOWS = [new Date('2026-06-15T00:00:00.000Z'), new Date('2026-07-15T00:00:00.000Z'), new Date('0000-01-01T00:00:00.000Z')]

  /** The dimension set is the one the key is built from; a change here must reach these tests. */
  it('exposes exactly the three counter dimensions', () => {
    expect([...COUNTER_DIMENSIONS]).toEqual(['cost', 'tokens', 'count'])
  })

  /** Fact 1: a dimension that ends with another makes the trailing field ambiguous. `discount` would. */
  it('keeps the dimension literals prefix-free at the tail', () => {
    for (const a of COUNTER_DIMENSIONS) {
      for (const b of COUNTER_DIMENSIONS) {
        if (a !== b) expect(a.endsWith(b)).toBe(false)
      }
    }
  })

  /** Fact 2: an equal-length timestamp tail forces the remaining fields equal. */
  it('emits a fixed-length timestamp for every in-range year', () => {
    for (const year of [0, 1970, 2026, 9999]) {
      const at = new Date(0)
      at.setUTCFullYear(year, 0, 1)
      expect(at.toISOString()).toHaveLength(24)
    }
  })

  /** Fact 3: the out-of-range 27-character form cannot align, because the character a
   * collision would need to be the delimiter is always a year digit. */
  it('cannot align an out-of-range timestamp against an in-range one', () => {
    for (const year of [10000, -1]) {
      const at = new Date(0)
      at.setUTCFullYear(year, 0, 1)
      const iso = at.toISOString()
      expect(iso).toHaveLength(27)
      expect(iso[iso.length - 25]).not.toBe(':')
    }
  })

  /** The property itself: no two distinct triples may produce one counter key. */
  it('never maps two distinct budget/window/dimension triples to one counter key', () => {
    const seen = new Map<string, string>()
    for (const id of ADVERSARIAL) {
      for (const at of WINDOWS) {
        for (const dimension of COUNTER_DIMENSIONS) {
          const key = counterKey(id, at, dimension)
          const triple = JSON.stringify([id, at.toISOString(), dimension])
          expect(seen.get(key) ?? triple).toBe(triple)
          seen.set(key, triple)
        }
      }
    }
  })

  /** The same property for the dedupe key, whose delimiter cannot occur in a timestamp. */
  it('never maps two distinct budget/window pairs to one window key', () => {
    const seen = new Map<string, string>()
    for (const id of ADVERSARIAL) {
      for (const at of WINDOWS) {
        const key = windowKey(id, at)
        const pair = JSON.stringify([id, at.toISOString()])
        expect(seen.get(key) ?? pair).toBe(pair)
        seen.set(key, pair)
      }
    }
  })
})
