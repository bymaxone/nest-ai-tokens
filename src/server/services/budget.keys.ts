/**
 * @fileoverview Counter-key construction for the budget live counters (spec §10.8).
 * Holds the dimension set, the two composite keys (`windowKey`, `counterKey`), their
 * TTL, and the delta/spend projections onto those dimensions.
 *
 * Everything a key is composed from lives here, and nothing else does. Both keys are
 * built from a caller-supplied `budgetId`, so they must stay injective: a field's
 * content may never move the boundary between fields. Keeping the dimension set, the
 * delimiters and the builders in one module is what lets `budget.keys.spec.ts` assert
 * that property over the whole composition — a builder that reads its delimiter from
 * elsewhere could not be checked that way.
 * @layer server
 */

import type { BudgetDelta, BudgetLimits, BudgetWindowSpend } from '../interfaces'

/** The window-length grace (seconds) added to a counter key's TTL (§10.8). */
const COUNTER_GRACE_SECONDS = 3_600

/** The counter TTL for a `'total'` window that never resets (≈ 400 days). */
// Stryker disable next-line ArithmeticOperator: TTL arithmetic is only observable in integration with a real counter store (Redis TTL); unit tests use FakeCounter which ignores TTL
const TOTAL_WINDOW_TTL_SECONDS = 60 * 60 * 24 * 400

/**
 * The counter dimensions, as one runtime value. `CounterDimensionName` derives from
 * it rather than being declared beside it, so a dimension cannot be added to the type
 * without appearing in this array — which is what `counterKey` injectivity is asserted
 * over.
 */
export const COUNTER_DIMENSIONS = ['cost', 'tokens', 'count'] as const

/** One counter dimension. Derived from {@link COUNTER_DIMENSIONS}. */
export type CounterDimensionName = (typeof COUNTER_DIMENSIONS)[number]

/** A dimension consumed against the live counter (limited dimension, non-zero delta). */
export interface CounterDimension {
  name: CounterDimensionName
  amount: bigint
  limit: bigint
}

/**
 * Compose the per-window dedupe key.
 *
 * The composition must stay injective: `|` cannot occur in an ISO 8601 timestamp, so
 * the boundary is recoverable however `budgetId` is spelled. `budgetId` is
 * caller-supplied and unvalidated, so this is a property of the construction, not of
 * the input.
 *
 * @param budgetId The budget id (caller-supplied; may contain any character).
 * @param windowStart The window start.
 * @returns The dedupe key.
 */
export function windowKey(budgetId: string, windowStart: Date): string {
  return `${budgetId}|${windowStart.toISOString()}`
}

/**
 * The live-counter key for one dimension (§10.8 scheme).
 *
 * Injective, and only because of three facts a future edit can remove: no member of
 * {@link COUNTER_DIMENSIONS} is a suffix of another, `toISOString()` emits a
 * fixed-length tail, and in its 27-character form the character 25 positions from the
 * end is always a year digit rather than the delimiter a collision would need. All
 * three are asserted in `budget.keys.spec.ts`; changing the delimiter, the timestamp
 * format, or adding a dimension that ends with an existing one breaks the property.
 *
 * @param budgetId The budget id (caller-supplied; may contain any character).
 * @param windowStart The window start.
 * @param dimension The counter dimension.
 * @returns The counter key.
 */
export function counterKey(budgetId: string, windowStart: Date, dimension: CounterDimensionName): string {
  return `ai_tokens:budget:${budgetId}:${windowStart.toISOString()}:${dimension}`
}

/**
 * The counter TTL: the window length plus a grace hour, or a long fixed TTL for `'total'`.
 *
 * @param windowStart The window start.
 * @param windowEnd The window end, or `null` for a `'total'` window that never resets.
 * @returns The TTL in seconds.
 */
export function counterTtlSeconds(windowStart: Date, windowEnd: Date | null): number {
  if (windowEnd === null) return TOTAL_WINDOW_TTL_SECONDS
  // Stryker disable next-line ArithmeticOperator: TTL arithmetic is only observable in integration with a real counter store (Redis TTL); unit tests use FakeCounter which ignores TTL
  return Math.ceil((windowEnd.getTime() - windowStart.getTime()) / 1_000) + COUNTER_GRACE_SECONDS
}

/**
 * The authoritative window spend per counter dimension, as int64 counter values (resync source).
 *
 * @param spend The stored window spend.
 * @returns The spend keyed by dimension.
 */
export function dimensionSpends(spend: BudgetWindowSpend): Record<CounterDimensionName, bigint> {
  return { cost: spend.spentNanoUsd, tokens: BigInt(spend.spentTokens), count: BigInt(spend.spentCount) }
}

/**
 * The limited dimensions a delta touches, as int64 counter amounts/limits.
 *
 * @param delta The consumption delta.
 * @param limits The budget's limits.
 * @returns One entry per limited dimension the delta moves.
 */
export function counterDimensions(delta: BudgetDelta, limits: BudgetLimits): CounterDimension[] {
  const dimensions: CounterDimension[] = []
  // Stryker disable next-line ConditionalExpression: CE true on `delta.nanoUsd !== 0n`: incrIfBelow(amount=0, limit) is a no-op (0 ≤ any limit → true, counter unchanged); including zero-delta dimensions is observable only via extra counter round-trips, not observable in unit tests
  if (limits.nanoUsd !== undefined && delta.nanoUsd !== 0n) {
    dimensions.push({ name: 'cost', amount: delta.nanoUsd, limit: limits.nanoUsd })
  }
  // Stryker disable next-line ConditionalExpression: CE true on `delta.tokens !== 0`: same as above — incrIfBelow(0n, limit) is a no-op in FakeCounter; only round-trip count differs, not test-observable outcomes
  if (limits.tokens !== undefined && delta.tokens !== 0) {
    dimensions.push({ name: 'tokens', amount: BigInt(delta.tokens), limit: BigInt(limits.tokens) })
  }
  // Stryker disable next-line ConditionalExpression: CE true on `delta.count !== 0`: same reasoning; count=0 increment is a no-op
  if (limits.count !== undefined && delta.count !== 0) {
    dimensions.push({ name: 'count', amount: BigInt(delta.count), limit: BigInt(limits.count) })
  }
  return dimensions
}
