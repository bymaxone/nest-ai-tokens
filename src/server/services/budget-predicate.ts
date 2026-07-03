/**
 * @fileoverview The normative budget-consumption predicate (spec §10.7) — the
 * SINGLE SOURCE OF TRUTH for which usage records consume a budget window, shared by
 * live consumption and `reconcileWindow`. A record consumes a window iff ALL five
 * clauses hold: it was written through the enforcement path (`enforced`), it is not
 * a system cost, its `feature` matches the budget's features filter (empty/absent =
 * all features), its status is `posted` or `reversed` (a reversal nets against its
 * compensating record), and its `occurredAt` falls inside the window. Pure and
 * framework-free; internal (not part of the public barrel).
 * @layer server
 */

import type { Budget, UsageRecord } from '../../shared'

/**
 * Whether a usage record consumes a budget window (§10.7). `windowEnd` is the
 * window's exclusive upper bound, or `null` for a `'total'` window that never ends.
 *
 * @param record The usage record under test.
 * @param budget The budget whose features filter is applied.
 * @param windowStart The window's inclusive start.
 * @param windowEnd The window's exclusive end, or `null` for `'total'`.
 * @returns `true` when the record consumes the window.
 */
export function recordConsumesBudget(
  record: UsageRecord,
  budget: Budget,
  windowStart: Date,
  windowEnd: Date | null,
): boolean {
  if (!record.enforced) return false
  if (record.isSystemCost) return false
  if (!featureMatches(budget.features, record.feature)) return false
  if (record.status !== 'posted' && record.status !== 'reversed') return false
  return record.occurredAt >= windowStart && (windowEnd === null || record.occurredAt < windowEnd)
}

/** Whether a record's feature matches the budget's features filter (empty/absent = all). */
function featureMatches(features: string[] | undefined, feature: string): boolean {
  return features === undefined || features.length === 0 || features.includes(feature)
}
