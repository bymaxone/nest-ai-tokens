/**
 * @fileoverview Budget types: the budget definition, its window/policy unions,
 * and the read-side status DTOs a usage meter renders (see spec §10).
 * @layer shared
 */

import type { MeteringScope } from './catalogs'

/** How a budget's window repeats. `{ customSeconds }` is a fixed-length rolling window. */
export type BudgetWindowKind = 'day' | 'week' | 'month' | 'total' | { customSeconds: number }

/** What happens when a budget is exceeded. */
export type BudgetPolicy = 'block' | 'throttle' | 'allow'

/** A spend/token/count cap for a scope over a window. */
export interface Budget {
  id: string
  tenantId: string
  scope: MeteringScope
  /** Restrict which usage counts; empty/absent = all features. */
  features?: string[]
  /** Billed-spend cap. */
  limitNanoUsd?: bigint
  /** Total-token cap. */
  limitTokens?: number
  /** Operation-count cap (posted, enforced, non-reversed records). */
  limitCount?: number
  window: BudgetWindowKind
  /**
   * Per-budget window anchor. Absent → calendar UTC anchoring. Month windows
   * clamp short months (a Jan 31 anchor yields Feb 28/29, Mar 31, …).
   */
  anchorAt?: Date
  /** Optional budget lifetime: enforcement ignores the budget after this instant. */
  expiresAt?: Date
  /** Fractions of the limit that trigger soft alert events. */
  softThresholds: number[]
  policy: BudgetPolicy
  createdAt: Date
}

/** The read-side status of one budget window — powers a usage meter. */
export interface BudgetStatus {
  budgetId: string
  features?: string[]
  window: BudgetWindowKind
  windowStart: Date
  /** `null` for `'total'`. */
  resetsAt: Date | null
  policy: BudgetPolicy
  limit: { nanoUsd?: bigint; tokens?: number; count?: number }
  spent: { nanoUsd: bigint; tokens: number; count: number }
  /** Absent dimension = unlimited. */
  remaining: { nanoUsd?: bigint; tokens?: number; count?: number }
  /** Max across limited dimensions. */
  usedFraction: number
}

/** Aggregate access status for a scope (wallet + all matching budgets). */
export interface AccessStatus {
  hasAccess: boolean
  blockedBy?: 'wallet' | 'budget'
  wallet?: { balanceNanoUsd: bigint; credits: number; overdraftRemainingNanoUsd: bigint }
  budgets: BudgetStatus[]
}
