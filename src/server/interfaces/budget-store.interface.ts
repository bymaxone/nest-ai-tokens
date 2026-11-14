/**
 * @fileoverview The budget persistence port (spec §15.1). Multi-dimension
 * budgets with atomic conditional consume, signed window adjustment, and window
 * rotation. Only validated at init when the budget feature is enabled.
 * @layer server
 */

import type { Budget, MeteringScope } from '../../shared'

/** A signed or absolute per-window spend delta across the three budget dimensions. */
export interface BudgetDelta {
  nanoUsd: bigint
  tokens: number
  count: number
}

/** Limits checked by {@link IBudgetStore.conditionalConsume} (absent = unlimited). */
export interface BudgetLimits {
  nanoUsd?: bigint
  tokens?: number
  count?: number
}

/**
 * The identity of a budget on the admin paths: its id AND its owning tenant, passed as one object so that a store
 * still declaring a bare `budgetId: string` no longer type-checks and cannot silently ignore the tenant. A store
 * answers a key whose tenant does not own the id exactly as it answers an id that does not exist.
 */
export interface BudgetKey {
  tenantId: string
  id: string
}

/** A window's materialized spend counters. */
export interface BudgetWindowSpend {
  spentNanoUsd: bigint
  spentTokens: number
  spentCount: number
}

/**
 * What caused a movement of a budget window, and the budget it moved. A store keeps one record per application, and
 * the pair is unique: a second movement under the same application moves nothing.
 */
export interface BudgetApplication {
  /** What caused the movement, deterministic for the cause (a call key, or an operation and a record id). */
  key: string
  budgetId: string
  /**
   * The attempt that applies it, unique per attempt. Recorded with the application so that {@link IBudgetStore.unapplyWindow}
   * called with an owner gives back only what that attempt applied; without one, an application is given back whoever applied it.
   */
  owner?: string
}

/**
 * The verdict of a keyed consume: moved now, already moved by this key with this very delta, refused by a limit (nothing
 * moved), or already moved by this key with a different delta (nothing moved: the key names another call).
 */
export type ApplicationOutcome = 'applied' | 'replayed' | 'refused' | 'mismatch'

/**
 * The verdict of giving a keyed movement back: given back now, given back before, no such movement, or still applied by
 * another attempt than the owner asked for (nothing moved).
 */
export type UnapplyOutcome = 'unapplied' | 'already' | 'absent' | 'foreign'

/** The budget port. */
export interface IBudgetStore {
  /**
   * Create or replace a budget. `createdAt` is the creation instant on the caller's clock, the one the records the
   * budget counts are stamped by: a store writes it as given, never from a clock of its own, and keeps the stored value
   * when the budget already exists. An `id` that belongs to another tenant MUST NOT be overwritten: the store throws
   * instead, without naming the other tenant.
   */
  upsert(budget: Omit<Budget, 'id' | 'createdAt'> & { id?: string; createdAt?: Date }): Promise<Budget>
  /** Delete a budget of the tenant; a no-op when the tenant owns no such id. */
  remove(key: BudgetKey): Promise<void>
  /** Load one budget of the tenant by id — the rotateWindow/reconcileWindow paths read it (§10.5); `null` when the tenant owns no such id. */
  findBudgetById(key: BudgetKey): Promise<Budget | null>
  /**
   * Every budget for the tenant scoped to the EXACT scope or tenant-wide (§10.3). A
   * single {@link MeteringScope} carries no team/user lineage, so the tenant is the
   * only ancestor resolvable — intermediate ancestors are not matched. Each budget
   * returned consumes independently; a subject-level budget never exempts the tenant cap.
   */
  findMatching(tenantId: string, scope: MeteringScope): Promise<Budget[]>
  /**
   * Atomic multi-dimension conditional consume (§10.8). `false` = a limit would be
   * exceeded. Creates the window row on first touch.
   */
  conditionalConsume(
    budgetId: string,
    windowStart: Date,
    delta: BudgetDelta,
    limits: BudgetLimits,
  ): Promise<boolean>
  /** Signed release/adjust of a window's counters (capture delta, release, reverse). */
  adjustWindow(budgetId: string, windowStart: Date, delta: BudgetDelta): Promise<void>
  /**
   * {@link conditionalConsume} once per application: `'replayed'` when this application already moved the window and
   * has not been given back since and moved it by this very delta (nothing moves), `'mismatch'` when it moved it by another
   * delta (nothing moves), `'refused'` when a limit would be exceeded (nothing moves and no application is recorded). Concurrent attempts with one application move the window once; the uniqueness of the
   * application, never a read followed by a write, decides which attempt does.
   */
  consumeWindowOnce(application: BudgetApplication, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Promise<ApplicationOutcome>
  /** {@link adjustWindow} once per application; `'replayed'` and `'mismatch'` as for {@link consumeWindowOnce}. */
  adjustWindowOnce(application: BudgetApplication, windowStart: Date, delta: BudgetDelta): Promise<'applied' | 'replayed' | 'mismatch'>
  /**
   * Give back what an application moved: subtract its delta from the window it moved, and mark it given back so that
   * the same application can be applied again. `'already'` when it was given back before, `'absent'` when no such
   * application was ever recorded, `'foreign'` when it is applied but its owner is not the one asked for.
   */
  unapplyWindow(application: BudgetApplication): Promise<UnapplyOutcome>
  /** A window's current spend, or `null` when it has no row yet. */
  getWindow(budgetId: string, windowStart: Date): Promise<BudgetWindowSpend | null>
  /** Move a budget's active window start (rotateWindow support). */
  setWindowStart(key: BudgetKey, windowStart: Date): Promise<void>
}
