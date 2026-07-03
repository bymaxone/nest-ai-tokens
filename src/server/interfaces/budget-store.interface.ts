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

/** A window's materialized spend counters. */
export interface BudgetWindowSpend {
  spentNanoUsd: bigint
  spentTokens: number
  spentCount: number
}

/** The budget port. */
export interface IBudgetStore {
  /** Create or replace a budget. */
  upsert(budget: Omit<Budget, 'id' | 'createdAt'> & { id?: string }): Promise<Budget>
  /** Delete a budget. */
  remove(budgetId: string): Promise<void>
  /** Every budget matching the scope AND all ancestor scopes (§10.3) for the tenant. */
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
  setWindowStart(budgetId: string, windowStart: Date): Promise<void>
}
