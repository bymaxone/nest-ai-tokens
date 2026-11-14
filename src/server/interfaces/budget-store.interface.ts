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
  /** A window's current spend, or `null` when it has no row yet. */
  getWindow(budgetId: string, windowStart: Date): Promise<BudgetWindowSpend | null>
  /** Move a budget's active window start (rotateWindow support). */
  setWindowStart(key: BudgetKey, windowStart: Date): Promise<void>
}
