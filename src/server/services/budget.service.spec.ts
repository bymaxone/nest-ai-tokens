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
import { BudgetService, type BudgetEventHooks, type BudgetServiceOptions, type UpsertBudgetInput } from './budget.service'
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

  /** A soft threshold outside (0, 1] is rejected. */
  it('rejects an out-of-range soft threshold', async () => {
    const { service } = makeService()
    await expectRejectCode(service.upsertBudget(budgetInput({ softThresholds: [1.5] })), 'AI_TOKENS_INVALID_CONFIG')
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

  /** A counter outage during adjust is logged, never thrown; the DB window still moves. */
  it('logs a counter failure without throwing', async () => {
    const counter = new FakeCounter()
    const { service, store } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(40n))
    counter.failIncr = true
    counter.failDecr = true
    await service.adjust(context(), delta(10n))
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(50n)
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

  /** A block failure rolls back a sibling budget's live counter, best-effort even if decr fails. */
  it('rolls back a sibling counter on a partial multi-budget failure', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const wide = await service.upsertBudget(budgetInput({ scope: { type: 'tenant', id: TENANT }, limitNanoUsd: 1_000n }))
    await service.upsertBudget(budgetInput({ scope: USER_SCOPE, limitNanoUsd: 10n }))
    counter.failDecr = true // rollback decr fails → logged, never thrown
    await expectRejectCode(service.consume(context(), delta(50n)), 'AI_TOKENS_BUDGET_EXCEEDED')
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

  /** rotateWindow resets the counter keys for the new window, tolerating a reset failure. */
  it('resets counter keys on rotation', async () => {
    const counter = new FakeCounter()
    const { service } = makeService({ options: { counter } })
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.rotateWindow(budget.id, new Date('2026-06-20T00:00:00.000Z'))
    expect(counter.resetKeys.some((key) => key.includes(':cost'))).toBe(true)
    counter.failReset = true
    await expect(service.rotateWindow(budget.id, new Date('2026-06-21T00:00:00.000Z'))).resolves.toBeUndefined()
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
