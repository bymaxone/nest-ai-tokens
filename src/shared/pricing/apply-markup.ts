/**
 * @fileoverview Markup / margin math (spec §7.2). The multiplier is validated
 * (finite, > 0) and rounded to 4 decimal places to match the persisted
 * `Decimal(10,4)`; the billed amount is exact bigint with truncation toward zero
 * on the final division. Markup applies in BOTH rating modes.
 * @layer shared
 */

/** The 4-decimal-place fixed-point scale for the markup multiplier. */
const MARKUP_SCALE = 10_000n

/** Assert the multiplier is finite and strictly positive. */
function assertValidMultiplier(multiplier: number): void {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    // Stryker disable next-line StringLiteral: error message text is internal diagnostics; tests check error type (RangeError), not the message
    throw new RangeError(`applyMarkup: multiplier must be finite and > 0, received ${String(multiplier)}`)
  }
}

/**
 * Validate and round a markup multiplier to 4 decimal places — the value that is
 * persisted on each usage record.
 *
 * @param multiplier The raw multiplier.
 * @returns The multiplier rounded to 4 decimal places.
 * @throws {RangeError} When the multiplier is not finite or not > 0.
 * @example
 * resolveMultiplier4dp(1.23456) // 1.2346
 */
export function resolveMultiplier4dp(multiplier: number): number {
  assertValidMultiplier(multiplier)
  return Math.round(multiplier * 10_000) / 10_000
}

/**
 * Apply a markup multiplier to a raw provider cost, in exact bigint nano-USD.
 *
 * @param rawCostNanoUsd The provider cost in nano-USD.
 * @param multiplier The markup multiplier (e.g. `4.0` for 4× resale).
 * @returns The billed cost in nano-USD (division truncates toward zero).
 * @throws {RangeError} When the multiplier is not finite or not > 0.
 * @example
 * applyMarkup(5_000_000n, 4.0) // 20_000_000n
 */
export function applyMarkup(rawCostNanoUsd: bigint, multiplier: number): bigint {
  assertValidMultiplier(multiplier)
  return (rawCostNanoUsd * BigInt(Math.round(multiplier * 10_000))) / MARKUP_SCALE
}
