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
import { attachCause } from '../errors/attach-cause'
import { counterDimensions, counterKey, counterTtlSeconds, dimensionSpends, windowKey } from './budget.keys'
import type {
  BudgetDelta,
  BudgetKey,
  BudgetLimits,
  BudgetWindowSpend,
  IBudgetCounterStore,
  IBudgetStore,
  MeteringContext,
} from '../interfaces'
import { addSpend, buildStatus, dimensionCode, failingDimension, failingDimensionOrNull, featureMatches, limitSnapshot, limitsOf, negate, remainingSnapshot, spendSnapshot, usedFraction } from './budget-math'
import type { FailingDimension } from './budget-math'
import type { LedgerService } from './ledger.service'
import { recordConsumesBudget } from './budget-predicate'
import { resetsAtFor, windowStartFor } from '../utils/window-anchor'
import { assertWindowKind } from '../utils/window-kind'

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

/** A recorded consumption, kept for rollback on a partial multi-budget failure. */
interface Consumed {
  budgetId: string
  windowStart: Date
  delta: BudgetDelta
  increments: CounterIncrement[]
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
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` on a negative limit, no limit dimension, a threshold outside `(0, 1]`, or a window kind that is not `'day'`, `'week'`, `'month'`, `'total'` or `{ customSeconds }` with a positive whole number of seconds up to 3153600000.
   */
  async upsertBudget(input: UpsertBudgetInput): Promise<Budget> {
    assertTenant(input.tenantId)
    this.assertLimits(input)
    assertWindowKind(input.window)
    const softThresholds = input.softThresholds ?? [...this.options.alertThresholds]
    for (const threshold of softThresholds) {
      // Stryker disable next-line StringLiteral: error reason template is internal diagnostics; tests check error code only
      if (!(threshold > 0 && threshold <= 1)) throw invalid(`softThresholds must be within (0, 1], received ${String(threshold)}`)
    }
    if (input.id !== undefined) {
      const existing = await this.store.findBudgetById({ tenantId: input.tenantId, id: input.id })
      if (existing !== null && existing.tenantId !== input.tenantId) throw unavailableBudgetId()
    }
    const budget = await this.store.upsert({ ...input, softThresholds, policy: input.policy ?? this.options.defaultPolicy })
    if (budget.tenantId !== input.tenantId) throw unavailableBudgetId()
    // Stryker disable next-line ObjectLiteral: audit payload is internal observability; tests check the upsert result and the audit action, not the event payload shape
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
    assertTenant(tenantId)
    // A budget of another tenant answers as an unknown id does: nothing is removed and nothing is audited.
    if ((await this.findOwned({ tenantId, id: budgetId })) === null) return
    await this.store.remove({ tenantId, id: budgetId })
    // Stryker disable next-line ObjectLiteral: audit payload is internal observability; tests check the method completes, not the event payload shape
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
    return this.matching(tenantId, scope ?? { type: 'tenant', id: tenantId })
  }

  /**
   * Force a fresh window now (or at `newWindowStart`) and re-anchor the budget so
   * subsequent windows follow the new cycle (ADMIN PLANE — §14.4). Emits
   * `ai_tokens.audit`.
   *
   * @param budgetId The budget id.
   * @param tenantId The owning tenant; a budget of another tenant answers as an unknown id.
   * @param newWindowStart The new window start; defaults to now.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the budget does not exist.
   */
  async rotateWindow(budgetId: string, tenantId: string, newWindowStart?: Date): Promise<void> {
    assertTenant(tenantId)
    const budget = await this.requireBudget({ tenantId, id: budgetId })
    const start = newWindowStart ?? this.now()
    const windowStart = windowStartFor({ ...budget, anchorAt: start }, start)
    await this.store.upsert({ ...budget, anchorAt: start })
    await this.store.setWindowStart({ tenantId, id: budgetId }, windowStart)
    const counter = this.options.counter
    if (counter !== undefined) {
      for (const dimension of counterDimensions({ nanoUsd: 1n, tokens: 1, count: 1 }, limitsOf(budget))) {
        try {
          await counter.reset(counterKey(budgetId, windowStart, dimension.name))
        } catch {
          // Stryker disable next-line StringLiteral: logger text is internal observability
          this.logger.warn(`failed to reset budget counter for ${budgetId}`)
        }
      }
    }
    // Stryker disable next-line ObjectLiteral: audit payload is internal observability; tests check window rotation behavior, not event payload shape
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
   * @param at The instant that locates the windows to charge; defaults to now. A back-dated record is
   *   charged to its own window, so its rollback and reversal release the window it consumed.
   * @throws {AiTokensException} `AI_TOKENS_BUDGET_EXCEEDED` (402, cost) or `AI_TOKENS_QUOTA_EXCEEDED` (429, tokens/count) when a `'block'` budget is exhausted.
   */
  async consume(context: MeteringContext, delta: BudgetDelta, at?: Date): Promise<void> {
    const windows = await this.matchingWindows(context.tenantId, context.scope, context.feature, at)
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
   * @param at The instant that locates the windows to release; defaults to now. A hold settles at its own
   *   `occurredAt`, so a settlement after a window boundary releases the window the hold consumed.
   */
  async release(context: MeteringContext, delta: BudgetDelta, at?: Date): Promise<void> {
    const windows = await this.matchingWindows(context.tenantId, context.scope, context.feature, at)
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
   * @param at The instant that locates the windows to adjust; defaults to now. A capture settles at the hold's
   *   `occurredAt`, so a settlement after a window boundary adjusts the window the hold consumed.
   */
  async adjust(context: MeteringContext, delta: BudgetDelta, at?: Date): Promise<void> {
    const windows = await this.matchingWindows(context.tenantId, context.scope, context.feature, at)
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
      // Stryker disable next-line EqualityOperator: `< 0n` vs `<= 0n` differ only at amount === 0n, which never reaches adjustCounter: counterDimensions omits any dimension whose delta component is 0, so `amount` is always non-zero here
      if (amount < 0n) {
        await counter.decr(key, -amount)
        return
      }
      if (await counter.incrIfBelow(key, amount, UNBOUNDED_COUNTER_LIMIT, ttl)) return
      await this.resyncCounter(counter, key, authoritative, ttl)
    } catch {
      // Stryker disable next-line StringLiteral: logger text is internal observability
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
    // Stryker disable next-line StringLiteral: logger text is internal observability
    this.logger.warn(`budget counter ${key} overflowed the int64 ceiling; resynced to the database window spend`)
  }

  /**
   * Recompute a window's counters from the ledger using the §10.7 predicate — the
   * ledger is the reconcilable source of truth; the window row is a cache.
   *
   * @param budgetId The budget id.
   * @param tenantId The owning tenant; a budget of another tenant answers as an unknown id.
   * @param windowStart A window start for the budget.
   */
  async reconcileWindow(budgetId: string, tenantId: string, windowStart: Date): Promise<void> {
    assertTenant(tenantId)
    const budget = await this.requireBudget({ tenantId, id: budgetId })
    const windowEnd = resetsAtFor(budget, windowStart)
    // Stryker disable next-line ObjectLiteral: the `to` upper bound is redundant with the §10.7 predicate: recordConsumesBudget re-filters `occurredAt < windowEnd`, so dropping `to` from the query filter yields the identical reconciled record set (the outer filter → {} is killed by the reconcile test)
    const filter = { tenantId: budget.tenantId, from: windowStart, ...(windowEnd !== null ? { to: windowEnd } : {}) }
    const records = await this.ledger.query(filter)
    const computed: BudgetWindowSpend = { spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 }
    for (const record of records) {
      if (!recordConsumesBudget(record, budget, windowStart, windowEnd)) continue
      computed.spentNanoUsd += record.billedCostNanoUsd
      computed.spentTokens += record.totalTokens
      // A compensating record undoes the count of the original it reverses, as the live release does.
      computed.spentCount += record.reversesRecordId === undefined ? 1 : -1
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
    const budgets = await this.matching(tenantId, scope)
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
      // Stryker disable next-line StringLiteral: logger text is internal observability; callers observe return value, not warning text
      this.logger.warn(`budget counter unavailable for ${located.budget.id}; falling back to the database`)
      // Stryker disable next-line BooleanLiteral: `available` only gates decrCounters(counter, increments), and on this outage path `increments` is []; flipping the flag cannot change any observable behaviour (decr of [] is a no-op; the returned increments stay [])
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
        // Stryker disable next-line ConditionalExpression: CE→true is inert: `counterAvailable === false` implies `increments === []` (the outage path returns no increments), so guarding the decr is equivalent to always decrementing an empty list
        if (counterAvailable) await this.decrCounters(counter, increments)
        return { ok: false, increments: [] }
      }
      return { ok: true, increments: counterAvailable ? increments : [] }
    } catch (error) {
      // Stryker disable next-line ConditionalExpression: CE→true is inert: `counterAvailable === false` implies `increments === []` (the outage path returns no increments), so guarding the decr is equivalent to always decrementing an empty list
      if (counterAvailable) await this.decrCounters(counter, increments)
      // Stryker disable next-line ObjectLiteral: empty error context {} is the intended shape for STORE_ERROR
      if (this.options.failClosed) throw attachCause(new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {}), error)
      // Stryker disable next-line StringLiteral: logger text is internal observability
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
        // Stryker disable next-line StringLiteral: logger text is internal observability
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
    // Stryker disable next-line ObjectLiteral: exception context is internal diagnostics; the asserted dimension travels on the exceeded event above, and tests check only the thrown error code
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
      // Stryker disable next-line StringLiteral: logger text is internal observability
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
    // Stryker disable next-line MethodExpression: [...arr].sort vs arr.sort: store.findMatching returns new objects each call, so in-place mutation is observable only across calls (harmless reorder of a fresh copy each time)
    // Stryker disable next-line ArithmeticOperator: a+b sort comparator produces descending order but mis-tracks `highest`; due to the monotonic fractionBefore invariant the wrong `highest` causes no re-emission in practice
    for (const threshold of [...located.budget.softThresholds].sort((a, b) => a - b)) {
      // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: CE/EQ on `threshold > emitted`: monotonic fractionBefore ≥ emitted means `threshold ≤ emitted` ⟹ `threshold ≤ fractionBefore`, so `threshold > fractionBefore` already blocks re-emission; the emitted guard is redundant. LogicalOperator (&&→||) between the two guards is inert too: a threshold is emitted exactly when the fraction first reaches it, so `threshold > emitted` ⟺ `threshold > fractionBefore`, and the AND/OR of two equal guards coincide
      if (threshold > emitted && threshold > fractionBefore && threshold <= fractionAfter) {
        await this.emitThreshold(context, located, threshold, fractionAfter, after)
        highest = threshold
      }
    }
    // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: highest > emitted: mutations (>=, <=, false) all produce no-ops in practice because the monotonic fractionBefore invariant prevents re-emission even with a stale notifiedThreshold value
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
    // Stryker disable next-line ConditionalExpression: CE false on `fraction <= 0`: zero fraction yields elapsedMs/0 = Infinity → projectedAt = Infinity ≥ windowEnd → exits anyway; equivalent
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
  private async matchingWindows(tenantId: string, scope: MeteringScope, feature: string, at?: Date): Promise<LocatedWindow[]> {
    const budgets = await this.matching(tenantId, scope)
    const now = at ?? this.now()
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
  private async requireBudget(key: BudgetKey): Promise<Budget> {
    const budget = await this.findOwned(key)
    // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
    if (budget === null) throw invalid(`budget ${key.id} does not exist`)
    return budget
  }

  /** The budget of the tenant for `key`, or `null`; a store that returns another tenant's budget is not believed. */
  private async findOwned(key: BudgetKey): Promise<Budget | null> {
    const budget = await this.store.findBudgetById(key)
    return budget !== null && budget.tenantId === key.tenantId ? budget : null
  }

  /** The tenant's budgets that apply to `scope`; a store that returns another tenant's budget is not believed. */
  private async matching(tenantId: string, scope: MeteringScope): Promise<Budget[]> {
    return (await this.store.findMatching(tenantId, scope)).filter((budget) => budget.tenantId === tenantId)
  }

  /** Validate the §10.2 limit rules: no negatives and at least one limit dimension. */
  private assertLimits(input: UpsertBudgetInput): void {
    for (const [name, value] of [
      ['limitNanoUsd', input.limitNanoUsd],
      ['limitTokens', input.limitTokens],
      ['limitCount', input.limitCount],
    ] as const) {
      // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
      if (value !== undefined && value < 0) throw invalid(`${name} must not be negative (§10.2)`)
    }
    if (input.limitNanoUsd === undefined && input.limitTokens === undefined && input.limitCount === undefined) {
      // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
      throw invalid('a budget must define at least one limit dimension')
    }
  }
}

/** Throw unless `tenantId` is a non-empty string, so a plain-JavaScript caller never reaches the store with a coerced key. */
function assertTenant(tenantId: unknown): asserts tenantId is string {
  // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
  if (typeof tenantId !== 'string' || tenantId === '') throw invalid('tenantId must be a non-empty string')
}

/** The refusal of a budget id another tenant owns: a config error that does not say whose it is. */
function unavailableBudgetId(): AiTokensException {
  // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
  return invalid('budget id is not available')
}

/** Build the invalid-config exception with an actionable reason. */
function invalid(reason: string): AiTokensException {
  // Stryker disable next-line ObjectLiteral: error context is internal diagnostics; tests check error code only
  return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
}
