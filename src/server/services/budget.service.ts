/**
 * @fileoverview `BudgetService` — multi-dimension budget CRUD, enforcement, and
 * the read-side status query (spec §10). Budgets cap spend/tokens/operation-count
 * per scope per window; windows anchor to calendar UTC or a per-subject `anchorAt`
 * with month-end clamping (§10.1). Unlimited semantics are NORMATIVE (§10.2): no
 * budget row / an absent limit = unlimited, a present `0` = a hard block, negatives
 * are rejected at validation. Every matching budget across the scope hierarchy is
 * checked and consumes INDEPENDENTLY (§10.3). Consumption is race-safe: `'block'`
 * budgets go through the atomic §10.8 `conditionalConsume` (never a check-then-write)
 * and roll back on any partial failure; `'allow'`/`'throttle'` record spend and
 * signal. `reconcileWindow` recomputes a window from the ledger with the SAME §10.7
 * predicate. `upsertBudget`/`removeBudget`/`rotateWindow` are admin-plane mutations
 * the host MUST restrict to privileged roles and that emit `ai_tokens.audit` (§14.4).
 * All money is bigint nano-USD.
 * @layer server
 */

import { Injectable, Logger } from '@nestjs/common'
import type {
  Budget,
  BudgetExceededEventData,
  BudgetPolicy,
  BudgetProjectedExceededEventData,
  BudgetStatus,
  BudgetThresholdCrossedEventData,
  MeteringScope,
} from '../../shared'
import type { ResolvedBudgetsOptions } from '../config'
import { AiTokensException } from '../errors'
import type {
  BudgetDelta,
  BudgetLimits,
  BudgetWindowSpend,
  IBudgetCounterStore,
  IBudgetStore,
  MeteringContext,
} from '../interfaces'
import { LedgerService } from './ledger.service'
import { recordConsumesBudget } from './budget-predicate'
import { resetsAtFor, windowStartFor } from '../utils/window-anchor'

/** The resolved budget settings the service consumes (the enabled half of the union). */
export type BudgetServiceOptions = Extract<ResolvedBudgetsOptions, { enabled: true }>

/** Input to {@link BudgetService.upsertBudget}: `softThresholds`/`policy` default from options. */
export type UpsertBudgetInput = Omit<Budget, 'id' | 'createdAt' | 'softThresholds' | 'policy'> & {
  id?: string
  softThresholds?: number[]
  policy?: BudgetPolicy
}

/** A zero window-spend snapshot. */
const ZERO_SPEND: BudgetWindowSpend = { spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 }

/** The event hooks `BudgetService` fires; the module wires them to the dispatcher. */
export interface BudgetEventHooks {
  thresholdCrossed(tenantId: string, scope: MeteringScope, data: BudgetThresholdCrossedEventData): void | Promise<void>
  exceeded(tenantId: string, scope: MeteringScope, data: BudgetExceededEventData): void | Promise<void>
  projectedExceeded(tenantId: string, scope: MeteringScope, data: BudgetProjectedExceededEventData): void | Promise<void>
  audit(action: string, details: Record<string, unknown>): void | Promise<void>
}

/** The no-op hooks used until the event dispatcher is wired. */
const NOOP_BUDGET_HOOKS: BudgetEventHooks = {
  thresholdCrossed: (): void => undefined,
  exceeded: (): void => undefined,
  projectedExceeded: (): void => undefined,
  audit: (): void => undefined,
}

/** A budget window located in time. */
interface LocatedWindow {
  budget: Budget
  windowStart: Date
  windowEnd: Date | null
  limits: BudgetLimits
}

/** A live counter increment made during a guarded consume (kept for rollback). */
interface CounterIncrement {
  key: string
  amount: bigint
}

/** A dimension consumed against the live counter (limited dimension, non-zero delta). */
interface CounterDimension {
  name: 'cost' | 'tokens' | 'count'
  amount: bigint
  limit: bigint
}

/** A recorded consumption, kept for rollback on a partial multi-budget failure. */
interface Consumed {
  budgetId: string
  windowStart: Date
  delta: BudgetDelta
  increments: CounterIncrement[]
}

/** A budget dimension over its limit, carrying the typed §16 block code (spend → 402, tokens/count → 429). */
interface FailingDimension {
  dimension: 'cost' | 'tokens' | 'count'
  code: 'AI_TOKENS_BUDGET_EXCEEDED' | 'AI_TOKENS_QUOTA_EXCEEDED'
}

/** The counter fast-path outcome: a hard reject (with its failing dimension) or a pass to the DB. */
type FastPathResult =
  | { rejected: true; failing: FailingDimension }
  | { rejected: false; increments: CounterIncrement[]; available: boolean }

/**
 * The result of a guarded consume: whether it passed, the live counter increments
 * it made, and — when a counter fast-path reject decided the block — the failing
 * dimension so the caller raises the correct §16 code (the DB path defers to
 * {@link failingDimension} instead).
 */
interface GuardResult {
  ok: boolean
  increments: CounterIncrement[]
  failing?: FailingDimension
}

/** The window-length grace (seconds) added to a counter key's TTL (§10.8). */
const COUNTER_GRACE_SECONDS = 3_600
/** The counter TTL for a `'total'` window that never resets (≈ 400 days). */
const TOTAL_WINDOW_TTL_SECONDS = 60 * 60 * 24 * 400
/** The int64 ceiling used as the limit for an unconditional counter increment (capture ±delta never re-blocks). */
const UNBOUNDED_COUNTER_LIMIT = 9_223_372_036_854_775_807n

/**
 * Multi-dimension budget CRUD, enforcement, and read-side status queries.
 * Budgets cap spend/tokens/operation-count per scope per window; unlimited
 * semantics are NORMATIVE (no row = no budget; 0 = block all). See file overview.
 */
@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name)
  /** Highest soft-threshold emitted per `(budgetId, windowStartISO)` — per-instance dedupe (§20). */
  private readonly notifiedThreshold = new Map<string, number>()
  /** Windows that have already emitted a projected-exceeded event, per instance. */
  private readonly projected = new Set<string>()

  /**
   * @param store The budget persistence port.
   * @param ledger The ledger service (reconcileWindow reads the source of truth).
   * @param options The resolved budget settings (policy, thresholds, throttle callback).
   * @param now The injected clock.
   * @param events The event hooks; the module wires them to the dispatcher.
   */
  constructor(
    private readonly store: IBudgetStore,
    private readonly ledger: LedgerService,
    private readonly options: BudgetServiceOptions,
    private readonly now: () => Date = (): Date => new Date(),
    private readonly events: BudgetEventHooks = NOOP_BUDGET_HOOKS,
  ) {}

  /**
   * Create or replace a budget (ADMIN PLANE — §14.4; restrict to privileged roles).
   * Applies the §10.2 normative validation and emits `ai_tokens.audit`.
   *
   * @param input The budget definition (`softThresholds`/`policy` default from options).
   * @returns The stored budget.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` on a negative limit, no limit dimension, or a threshold outside `(0, 1]`.
   */
  async upsertBudget(input: UpsertBudgetInput): Promise<Budget> {
    this.assertLimits(input)
    const softThresholds = input.softThresholds ?? [...this.options.alertThresholds]
    for (const threshold of softThresholds) {
      if (!(threshold > 0 && threshold <= 1)) throw invalid(`softThresholds must be within (0, 1], received ${String(threshold)}`)
    }
    const budget = await this.store.upsert({ ...input, softThresholds, policy: input.policy ?? this.options.defaultPolicy })
    await this.events.audit('ai_tokens.budget.upserted', { tenantId: budget.tenantId, budgetId: budget.id })
    return budget
  }

  /**
   * Delete a budget (ADMIN PLANE — §14.4). Emits `ai_tokens.audit`.
   *
   * @param budgetId The budget id.
   * @param tenantId The owning tenant (audit context).
   */
  async removeBudget(budgetId: string, tenantId: string): Promise<void> {
    await this.store.remove(budgetId)
    await this.events.audit('ai_tokens.budget.removed', { tenantId, budgetId })
  }

  /**
   * List budgets applicable to a scope (the exact scope plus tenant-wide budgets).
   * Defaults to the tenant scope when no scope is supplied.
   *
   * @param tenantId The owning tenant.
   * @param scope The scope to list for; defaults to tenant-wide.
   * @returns The applicable budgets.
   */
  list(tenantId: string, scope?: MeteringScope): Promise<Budget[]> {
    return this.store.findMatching(tenantId, scope ?? { type: 'tenant', id: tenantId })
  }

  /**
   * Force a fresh window now (or at `newWindowStart`) and re-anchor the budget so
   * subsequent windows follow the new cycle (ADMIN PLANE — §14.4). Emits
   * `ai_tokens.audit`.
   *
   * @param budgetId The budget id.
   * @param newWindowStart The new window start; defaults to now.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the budget does not exist.
   */
  async rotateWindow(budgetId: string, newWindowStart?: Date): Promise<void> {
    const budget = await this.requireBudget(budgetId)
    const start = newWindowStart ?? this.now()
    const windowStart = windowStartFor({ ...budget, anchorAt: start }, start)
    await this.store.upsert({ ...budget, anchorAt: start })
    await this.store.setWindowStart(budgetId, windowStart)
    const counter = this.options.counter
    if (counter !== undefined) {
      for (const dimension of counterDimensions({ nanoUsd: 1n, tokens: 1, count: 1 }, limitsOf(budget))) {
        try {
          await counter.reset(counterKey(budgetId, windowStart, dimension.name))
        } catch {
          this.logger.warn(`failed to reset budget counter for ${budgetId}`)
        }
      }
    }
    await this.events.audit('ai_tokens.budget.rotated', { tenantId: budget.tenantId, budgetId, windowStart: start.toISOString() })
  }

  /**
   * Consume every matching budget for a metered call (§10.3/§10.8). `'block'`
   * budgets use the atomic conditional consume and roll back all prior consumption
   * on a shortfall (throwing the dimension's typed error); `'allow'`/`'throttle'`
   * budgets record the spend and signal. Called by the hold/record enforcement paths.
   *
   * @param context The metering context (payer scope, feature — trusted input).
   * @param delta The spend to consume across the three dimensions.
   * @throws {AiTokensException} `AI_TOKENS_BUDGET_EXCEEDED` (402, cost) or `AI_TOKENS_QUOTA_EXCEEDED` (429, tokens/count) when a `'block'` budget is exhausted.
   */
  async consume(context: MeteringContext, delta: BudgetDelta): Promise<void> {
    const windows = await this.matchingWindows(context.tenantId, context.scope, context.feature)
    const consumed: Consumed[] = []
    for (const located of windows) {
      const before = (await this.store.getWindow(located.budget.id, located.windowStart)) ?? ZERO_SPEND
      await this.applyConsumption(context, located, delta, before, consumed)
    }
  }

  /**
   * Release a previously-consumed delta across every matching budget (capture
   * delta, hold release, reversal). Best-effort signed subtraction.
   *
   * @param context The metering context.
   * @param delta The spend to release.
   */
  async release(context: MeteringContext, delta: BudgetDelta): Promise<void> {
    const windows = await this.matchingWindows(context.tenantId, context.scope, context.feature)
    const counter = this.options.counter
    for (const located of windows) {
      await this.store.adjustWindow(located.budget.id, located.windowStart, negate(delta))
      if (counter !== undefined) {
        for (const dimension of counterDimensions(delta, located.limits)) {
          await this.decrCounters(counter, [{ key: counterKey(located.budget.id, located.windowStart, dimension.name), amount: dimension.amount }])
        }
      }
    }
  }

  /**
   * Apply a SIGNED spend delta to every matching budget window WITHOUT enforcement
   * — the capture settlement ±delta (§11.2). A positive delta records extra spend
   * (actual above the hold estimate), a negative delta releases (actual below);
   * capture NEVER re-blocks, so this never throws a budget/quota error. Keeps the
   * live counter in sync (increment/decrement per dimension sign).
   *
   * @param context The metering context (payer scope, feature).
   * @param delta The signed spend delta across the three dimensions.
   */
  async adjust(context: MeteringContext, delta: BudgetDelta): Promise<void> {
    const windows = await this.matchingWindows(context.tenantId, context.scope, context.feature)
    const counter = this.options.counter
    for (const located of windows) {
      const before = (await this.store.getWindow(located.budget.id, located.windowStart)) ?? ZERO_SPEND
      await this.store.adjustWindow(located.budget.id, located.windowStart, delta)
      if (counter === undefined) continue
      const spends = dimensionSpends(addSpend(before, delta))
      const ttl = counterTtlSeconds(located.windowStart, located.windowEnd)
      for (const dimension of counterDimensions(delta, located.limits)) {
        const key = counterKey(located.budget.id, located.windowStart, dimension.name)
        await this.adjustCounter(counter, key, dimension.amount, spends[dimension.name], ttl)
      }
    }
  }

  /**
   * Unconditionally move a live counter by a signed capture ±delta (never re-blocks).
   * A positive move uses `incrIfBelow` against the int64 ceiling; a `false` result
   * means the increment would overflow int64 (or the backend treats the ceiling as a
   * hard cap), so the counter has DIVERGED from the authoritative DB window — it is
   * then resynced to `authoritative` (the post-adjust window spend) rather than left
   * holding a stale value the fast path would trust. A negative move decrements.
   */
  private async adjustCounter(counter: IBudgetCounterStore, key: string, amount: bigint, authoritative: bigint, ttl: number): Promise<void> {
    try {
      if (amount < 0n) {
        await counter.decr(key, -amount)
        return
      }
      if (await counter.incrIfBelow(key, amount, UNBOUNDED_COUNTER_LIMIT, ttl)) return
      await this.resyncCounter(counter, key, authoritative, ttl)
    } catch {
      this.logger.warn(`failed to adjust budget counter ${key}`)
    }
  }

  /** Discard a diverged counter and reseed it to the authoritative DB window spend (§10.8). */
  private async resyncCounter(counter: IBudgetCounterStore, key: string, authoritative: bigint, ttl: number): Promise<void> {
    await counter.reset(key)
    // The reset cleared the key to zero and the authoritative window spend is a real accumulated
    // value always within the int64 counter range, so this seed can never be rejected — its boolean
    // is intentionally not checked (unlike the overflowing increment that got us here). It restores
    // counter == DB-window instead of trusting the overflowed fast-path value.
    await counter.incrIfBelow(key, authoritative, UNBOUNDED_COUNTER_LIMIT, ttl)
    this.logger.warn(`budget counter ${key} overflowed the int64 ceiling; resynced to the database window spend`)
  }

  /**
   * Recompute a window's counters from the ledger using the §10.7 predicate — the
   * ledger is the reconcilable source of truth; the window row is a cache.
   *
   * @param budgetId The budget id.
   * @param windowStart A window start for the budget.
   */
  async reconcileWindow(budgetId: string, windowStart: Date): Promise<void> {
    const budget = await this.requireBudget(budgetId)
    const windowEnd = resetsAtFor(budget, windowStart)
    const filter = { tenantId: budget.tenantId, from: windowStart, ...(windowEnd !== null ? { to: windowEnd } : {}) }
    const records = await this.ledger.query(filter)
    const computed: BudgetWindowSpend = { spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 }
    for (const record of records) {
      if (!recordConsumesBudget(record, budget, windowStart, windowEnd)) continue
      computed.spentNanoUsd += record.billedCostNanoUsd
      computed.spentTokens += record.totalTokens
      computed.spentCount += 1
    }
    const current = (await this.store.getWindow(budgetId, windowStart)) ?? ZERO_SPEND
    await this.store.adjustWindow(budgetId, windowStart, {
      nanoUsd: computed.spentNanoUsd - current.spentNanoUsd,
      tokens: computed.spentTokens - current.spentTokens,
      count: computed.spentCount - current.spentCount,
    })
  }

  /**
   * The read-side "how much is left" query across every matching budget (§10.6) —
   * the usage-meter data source. Reads live window rows (documented freshness
   * trade-off; no counter read).
   *
   * @param tenantId The owning tenant.
   * @param scope The scope to report for.
   * @returns One {@link BudgetStatus} per matching budget.
   * @example
   * const budgets = await budgetService.status(tenantId, scope)
   * res.json(toJsonSafe(budgets)) // bigint fields become decimal strings (§15.5)
   */
  async status(tenantId: string, scope: MeteringScope): Promise<BudgetStatus[]> {
    const budgets = await this.store.findMatching(tenantId, scope)
    const statuses: BudgetStatus[] = []
    for (const budget of budgets) {
      const windowStart = windowStartFor(budget, this.now())
      const spend = (await this.store.getWindow(budget.id, windowStart)) ?? ZERO_SPEND
      statuses.push(buildStatus(budget, windowStart, resetsAtFor(budget, windowStart), spend))
    }
    return statuses
  }

  /** Apply consumption for one located window (throws through {@link blockExceeded} on a hard shortfall). */
  private async applyConsumption(
    context: MeteringContext,
    located: LocatedWindow,
    delta: BudgetDelta,
    before: BudgetWindowSpend,
    consumed: Consumed[],
  ): Promise<void> {
    let increments: CounterIncrement[] = []
    if (located.budget.policy === 'block') {
      const result = await this.guardedConsume(located, delta)
      if (!result.ok) {
        await this.rollback(consumed)
        await this.blockExceeded(context, located, before, delta, result.failing)
      }
      increments = result.increments
    } else {
      await this.store.adjustWindow(located.budget.id, located.windowStart, delta)
      await this.softOverLimit(context, located, before, delta)
    }
    consumed.push({ budgetId: located.budget.id, windowStart: located.windowStart, delta, increments })
    await this.signalThresholds(context, located, before, addSpend(before, delta))
  }

  /**
   * The atomic §10.8 consume with the optional live-counter fast path and
   * fail-closed fallback. With a counter bound, each limited dimension is checked
   * cheaply via `incrIfBelow` FIRST (a reject touches no DB); on pass the DB
   * conditional consume remains authoritative and rolls the counter back on a DB
   * shortfall. A counter that is UNAVAILABLE falls back to the DB alone; if the DB
   * is also down, `failClosed` blocks (else it allows with a warning). Without a
   * counter it is the plain DB conditional consume.
   */
  private async guardedConsume(located: LocatedWindow, delta: BudgetDelta): Promise<GuardResult> {
    const counter = this.options.counter
    if (counter === undefined) {
      return { ok: await this.store.conditionalConsume(located.budget.id, located.windowStart, delta, located.limits), increments: [] }
    }
    const fast = await this.counterFastPath(counter, located, delta)
    if (fast.rejected) return { ok: false, increments: [], failing: fast.failing }
    return this.databaseConsume(counter, located, delta, fast.increments, fast.available)
  }

  /**
   * Try the live-counter fast path. On a hard reject it reports the FAILING dimension
   * (whose `incrIfBelow` returned `false`) so the block raises the correct §16 code
   * — a count/token quota is a 429, not the spend 402 the DB-window default would
   * infer when the counter is ahead of the window row. Otherwise it reports the
   * increments made and whether the counter was available (an outage falls back to DB).
   */
  private async counterFastPath(
    counter: IBudgetCounterStore,
    located: LocatedWindow,
    delta: BudgetDelta,
  ): Promise<FastPathResult> {
    const ttl = counterTtlSeconds(located.windowStart, located.windowEnd)
    const increments: CounterIncrement[] = []
    try {
      for (const dimension of counterDimensions(delta, located.limits)) {
        const key = counterKey(located.budget.id, located.windowStart, dimension.name)
        if (await counter.incrIfBelow(key, dimension.amount, dimension.limit, ttl)) {
          increments.push({ key, amount: dimension.amount })
          continue
        }
        await this.decrCounters(counter, increments)
        return { rejected: true, failing: dimensionCode(dimension.name) }
      }
      return { rejected: false, increments, available: true }
    } catch {
      await this.decrCounters(counter, increments)
      this.logger.warn(`budget counter unavailable for ${located.budget.id}; falling back to the database`)
      return { rejected: false, increments: [], available: false }
    }
  }

  /** Run the authoritative DB consume, rolling the counter back on a shortfall and failing closed on an outage. */
  private async databaseConsume(
    counter: IBudgetCounterStore,
    located: LocatedWindow,
    delta: BudgetDelta,
    increments: CounterIncrement[],
    counterAvailable: boolean,
  ): Promise<GuardResult> {
    try {
      const ok = await this.store.conditionalConsume(located.budget.id, located.windowStart, delta, located.limits)
      if (!ok) {
        if (counterAvailable) await this.decrCounters(counter, increments)
        return { ok: false, increments: [] }
      }
      return { ok: true, increments: counterAvailable ? increments : [] }
    } catch {
      if (counterAvailable) await this.decrCounters(counter, increments)
      if (this.options.failClosed) throw new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {})
      this.logger.warn(`budget store unavailable for ${located.budget.id}; allowing (failClosed disabled)`)
      return { ok: true, increments: [] }
    }
  }

  /** Best-effort counter decrement (rollback); failures are logged, never thrown. */
  private async decrCounters(counter: IBudgetCounterStore, increments: CounterIncrement[]): Promise<void> {
    for (const increment of increments) {
      try {
        await counter.decr(increment.key, increment.amount)
      } catch {
        this.logger.warn(`failed to roll back budget counter ${increment.key}`)
      }
    }
  }

  /**
   * Emit `exceeded` and throw the dimension's typed error for a blocked budget. The
   * failing dimension is threaded from the counter fast-path reject when it decided
   * the block; the DB conditional-consume path passes none, so it defaults to the
   * over-limit dimension of the DB window spend — both routes map to the same §16 code.
   */
  private async blockExceeded(
    context: MeteringContext,
    located: LocatedWindow,
    before: BudgetWindowSpend,
    delta: BudgetDelta,
    failing: FailingDimension = failingDimension(addSpend(before, delta), located.limits),
  ): Promise<never> {
    await this.events.exceeded(context.tenantId, located.budget.scope, {
      budgetId: located.budget.id,
      policy: 'block',
      dimension: failing.dimension,
      limit: limitSnapshot(located.limits),
      spent: spendSnapshot(before),
      resetsAt: located.windowEnd,
    })
    throw new AiTokensException(failing.code, undefined, { budgetId: located.budget.id, dimension: failing.dimension })
  }

  /** Signal an over-limit `'allow'`/`'throttle'` budget (records spend, never throws). */
  private async softOverLimit(
    context: MeteringContext,
    located: LocatedWindow,
    before: BudgetWindowSpend,
    delta: BudgetDelta,
  ): Promise<void> {
    const failing = failingDimensionOrNull(addSpend(before, delta), located.limits)
    if (failing === null) return
    if (located.budget.policy === 'throttle') {
      await this.throttle(context, located, before)
      return
    }
    await this.events.exceeded(context.tenantId, located.budget.scope, {
      budgetId: located.budget.id,
      policy: 'allow',
      dimension: failing.dimension,
      limit: limitSnapshot(located.limits),
      spent: spendSnapshot(before),
      resetsAt: located.windowEnd,
    })
  }

  /** Invoke the host throttle callback (or warn + allow when none is configured). */
  private async throttle(context: MeteringContext, located: LocatedWindow, before: BudgetWindowSpend): Promise<void> {
    const status = buildStatus(located.budget, located.windowStart, located.windowEnd, before)
    if (this.options.onThrottle === undefined) {
      this.logger.warn(`budget ${located.budget.id} exceeded with policy 'throttle' but no onThrottle callback is configured`)
      return
    }
    await this.options.onThrottle({ context, budget: located.budget, status })
  }

  /** Emit each soft threshold crossed by this delta, once per window (per-instance dedupe). */
  private async signalThresholds(
    context: MeteringContext,
    located: LocatedWindow,
    before: BudgetWindowSpend,
    after: BudgetWindowSpend,
  ): Promise<void> {
    const key = windowKey(located.budget.id, located.windowStart)
    const fractionBefore = usedFraction(before, located.limits)
    const fractionAfter = usedFraction(after, located.limits)
    const emitted = this.notifiedThreshold.get(key) ?? 0
    let highest = emitted
    for (const threshold of [...located.budget.softThresholds].sort((a, b) => a - b)) {
      if (threshold > emitted && threshold > fractionBefore && threshold <= fractionAfter) {
        await this.emitThreshold(context, located, threshold, fractionAfter, after)
        highest = threshold
      }
    }
    if (highest > emitted) this.notifiedThreshold.set(key, highest)
    await this.signalProjection(context, located, fractionAfter)
  }

  /** Emit one `threshold_crossed` event. */
  private emitThreshold(
    context: MeteringContext,
    located: LocatedWindow,
    threshold: number,
    fraction: number,
    after: BudgetWindowSpend,
  ): void | Promise<void> {
    return this.events.thresholdCrossed(context.tenantId, located.budget.scope, {
      budgetId: located.budget.id,
      threshold,
      usedFraction: fraction,
      limit: limitSnapshot(located.limits),
      spent: spendSnapshot(after),
      remaining: remainingSnapshot(located.limits, after),
      resetsAt: located.windowEnd,
    })
  }

  /** Emit `projected_exceeded` once per window when the burn rate projects crossing before reset. */
  private async signalProjection(context: MeteringContext, located: LocatedWindow, fraction: number): Promise<void> {
    if (located.windowEnd === null || fraction <= 0 || fraction >= 1) return
    const key = windowKey(located.budget.id, located.windowStart)
    if (this.projected.has(key)) return
    const elapsedMs = this.now().getTime() - located.windowStart.getTime()
    if (elapsedMs <= 0) return
    const projectedAt = new Date(located.windowStart.getTime() + elapsedMs / fraction)
    if (projectedAt >= located.windowEnd) return
    this.projected.add(key)
    await this.events.projectedExceeded(context.tenantId, located.budget.scope, {
      budgetId: located.budget.id,
      projectedAt,
      usedFraction: fraction,
      resetsAt: located.windowEnd,
    })
  }

  /** The matching, feature-relevant budgets located in the current window. */
  private async matchingWindows(tenantId: string, scope: MeteringScope, feature: string): Promise<LocatedWindow[]> {
    const budgets = await this.store.findMatching(tenantId, scope)
    const now = this.now()
    return budgets
      .filter((budget) => featureMatches(budget.features, feature))
      .map((budget) => {
        const windowStart = windowStartFor(budget, now)
        return { budget, windowStart, windowEnd: resetsAtFor(budget, windowStart), limits: limitsOf(budget) }
      })
  }

  /** Undo every recorded consumption (signed DB subtraction + live-counter decrement). */
  private async rollback(consumed: Consumed[]): Promise<void> {
    const counter = this.options.counter
    for (const entry of consumed) {
      await this.store.adjustWindow(entry.budgetId, entry.windowStart, negate(entry.delta))
      if (counter !== undefined) await this.decrCounters(counter, entry.increments)
    }
  }

  /** Load a budget by id or throw an invalid-config error. */
  private async requireBudget(budgetId: string): Promise<Budget> {
    const budget = await this.store.findBudgetById(budgetId)
    if (budget === null) throw invalid(`budget ${budgetId} does not exist`)
    return budget
  }

  /** Validate the §10.2 limit rules: no negatives and at least one limit dimension. */
  private assertLimits(input: UpsertBudgetInput): void {
    for (const [name, value] of [
      ['limitNanoUsd', input.limitNanoUsd],
      ['limitTokens', input.limitTokens],
      ['limitCount', input.limitCount],
    ] as const) {
      if (value !== undefined && value < 0) throw invalid(`${name} must not be negative (§10.2)`)
    }
    if (input.limitNanoUsd === undefined && input.limitTokens === undefined && input.limitCount === undefined) {
      throw invalid('a budget must define at least one limit dimension')
    }
  }
}

/** Build the invalid-config exception with an actionable reason. */
function invalid(reason: string): AiTokensException {
  return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
}

/** Whether a record's feature matches a budget's features filter (empty/absent = all). */
function featureMatches(features: string[] | undefined, feature: string): boolean {
  return features === undefined || features.length === 0 || features.includes(feature)
}

/** The limits object for a budget (only defined dimensions). */
function limitsOf(budget: Budget): BudgetLimits {
  return {
    ...(budget.limitNanoUsd !== undefined ? { nanoUsd: budget.limitNanoUsd } : {}),
    ...(budget.limitTokens !== undefined ? { tokens: budget.limitTokens } : {}),
    ...(budget.limitCount !== undefined ? { count: budget.limitCount } : {}),
  }
}

/** Negate a delta across all three dimensions. */
function negate(delta: BudgetDelta): BudgetDelta {
  return { nanoUsd: -delta.nanoUsd, tokens: -delta.tokens, count: -delta.count }
}

/** Add a delta to a window's spend (non-mutating). */
function addSpend(spend: BudgetWindowSpend, delta: BudgetDelta): BudgetWindowSpend {
  return {
    spentNanoUsd: spend.spentNanoUsd + delta.nanoUsd,
    spentTokens: spend.spentTokens + delta.tokens,
    spentCount: spend.spentCount + delta.count,
  }
}

/** Map a limited budget/counter dimension to its typed §16 block code: spend → 402, tokens/count → 429. */
function dimensionCode(name: 'cost' | 'tokens' | 'count'): FailingDimension {
  return name === 'cost' ? { dimension: 'cost', code: 'AI_TOKENS_BUDGET_EXCEEDED' } : { dimension: name, code: 'AI_TOKENS_QUOTA_EXCEEDED' }
}

/** The first dimension whose spend exceeds its limit, with the typed error code (spend fallback). */
function failingDimension(spend: BudgetWindowSpend, limits: BudgetLimits): FailingDimension {
  return failingDimensionOrNull(spend, limits) ?? dimensionCode('cost')
}

/** The first over-limit dimension, or `null` when every dimension is within its limit. */
function failingDimensionOrNull(spend: BudgetWindowSpend, limits: BudgetLimits): FailingDimension | null {
  if (limits.nanoUsd !== undefined && spend.spentNanoUsd > limits.nanoUsd) return dimensionCode('cost')
  if (limits.tokens !== undefined && spend.spentTokens > limits.tokens) return dimensionCode('tokens')
  if (limits.count !== undefined && spend.spentCount > limits.count) return dimensionCode('count')
  return null
}

/** Fixed-point scale for the used fraction (six decimal digits) — see {@link ratio}. */
const USED_FRACTION_SCALE = 1_000_000n

/** The maximum used fraction across the limited dimensions (bounded float; 0 when unlimited). */
function usedFraction(spend: BudgetWindowSpend, limits: BudgetLimits): number {
  const fractions: number[] = []
  if (limits.nanoUsd !== undefined) fractions.push(ratio(spend.spentNanoUsd, limits.nanoUsd))
  if (limits.tokens !== undefined) fractions.push(ratio(BigInt(spend.spentTokens), BigInt(limits.tokens)))
  if (limits.count !== undefined) fractions.push(ratio(BigInt(spend.spentCount), BigInt(limits.count)))
  return fractions.length === 0 ? 0 : Math.max(...fractions)
}

/**
 * The used fraction of one dimension, computed with bigint math so nano-USD spend/limits
 * above `Number.MAX_SAFE_INTEGER` never lose precision — a raw `Number()` on either
 * operand would round and could report a full or over-limit budget as under (or vice
 * versa), corrupting thresholds, projection, and `status.usedFraction`. Scales by a fixed
 * factor, divides as bigint, then converts the small scaled quotient to a float. A zero
 * limit is a hard block (§10.2) — fully used at zero spend, over beyond it.
 */
function ratio(spent: bigint, limit: bigint): number {
  if (limit === 0n) return spent > 0n ? Number.POSITIVE_INFINITY : 1
  return Number((spent * USED_FRACTION_SCALE) / limit) / Number(USED_FRACTION_SCALE)
}

/** The limit snapshot (present dimensions only) for an event payload. */
function limitSnapshot(limits: BudgetLimits): { nanoUsd?: bigint; tokens?: number; count?: number } {
  return {
    ...(limits.nanoUsd !== undefined ? { nanoUsd: limits.nanoUsd } : {}),
    ...(limits.tokens !== undefined ? { tokens: limits.tokens } : {}),
    ...(limits.count !== undefined ? { count: limits.count } : {}),
  }
}

/** The spend snapshot (all three dimensions) for an event payload. */
function spendSnapshot(spend: BudgetWindowSpend): { nanoUsd: bigint; tokens: number; count: number } {
  return { nanoUsd: spend.spentNanoUsd, tokens: spend.spentTokens, count: spend.spentCount }
}

/** The remaining snapshot (limited dimensions only, floored at zero) for an event payload. */
function remainingSnapshot(limits: BudgetLimits, spend: BudgetWindowSpend): { nanoUsd?: bigint; tokens?: number; count?: number } {
  return {
    ...(limits.nanoUsd !== undefined ? { nanoUsd: max0(limits.nanoUsd - spend.spentNanoUsd) } : {}),
    ...(limits.tokens !== undefined ? { tokens: Math.max(0, limits.tokens - spend.spentTokens) } : {}),
    ...(limits.count !== undefined ? { count: Math.max(0, limits.count - spend.spentCount) } : {}),
  }
}

/** Assemble a {@link BudgetStatus} from a budget and its located window (§10.6). */
function buildStatus(budget: Budget, windowStart: Date, resetsAt: Date | null, spend: BudgetWindowSpend): BudgetStatus {
  const limits = limitsOf(budget)
  return {
    budgetId: budget.id,
    ...(budget.features !== undefined ? { features: budget.features } : {}),
    window: budget.window,
    windowStart,
    resetsAt,
    policy: budget.policy,
    limit: limitSnapshot(limits),
    spent: spendSnapshot(spend),
    remaining: remainingSnapshot(limits, spend),
    usedFraction: usedFraction(spend, limits),
  }
}

/** Compose the per-window dedupe key. */
function windowKey(budgetId: string, windowStart: Date): string {
  return `${budgetId}|${windowStart.toISOString()}`
}

/** The live-counter key for one dimension (§10.8 scheme). */
function counterKey(budgetId: string, windowStart: Date, dimension: 'cost' | 'tokens' | 'count'): string {
  return `ai_tokens:budget:${budgetId}:${windowStart.toISOString()}:${dimension}`
}

/** The counter TTL: the window length plus a grace hour, or a long fixed TTL for `'total'`. */
function counterTtlSeconds(windowStart: Date, windowEnd: Date | null): number {
  if (windowEnd === null) return TOTAL_WINDOW_TTL_SECONDS
  return Math.ceil((windowEnd.getTime() - windowStart.getTime()) / 1_000) + COUNTER_GRACE_SECONDS
}

/** The authoritative window spend per counter dimension, as int64 counter values (resync source). */
function dimensionSpends(spend: BudgetWindowSpend): Record<'cost' | 'tokens' | 'count', bigint> {
  return { cost: spend.spentNanoUsd, tokens: BigInt(spend.spentTokens), count: BigInt(spend.spentCount) }
}

/** The limited dimensions a delta touches, as int64 counter amounts/limits. */
function counterDimensions(delta: BudgetDelta, limits: BudgetLimits): CounterDimension[] {
  const dimensions: CounterDimension[] = []
  if (limits.nanoUsd !== undefined && delta.nanoUsd !== 0n) {
    dimensions.push({ name: 'cost', amount: delta.nanoUsd, limit: limits.nanoUsd })
  }
  if (limits.tokens !== undefined && delta.tokens !== 0) {
    dimensions.push({ name: 'tokens', amount: BigInt(delta.tokens), limit: BigInt(limits.tokens) })
  }
  if (limits.count !== undefined && delta.count !== 0) {
    dimensions.push({ name: 'count', amount: BigInt(delta.count), limit: BigInt(limits.count) })
  }
  return dimensions
}

/** Floor a bigint at zero. */
function max0(value: bigint): bigint {
  return value < 0n ? 0n : value
}
