/**
 * @fileoverview Type guards for the numbers the library takes at its boundaries: a count that is a whole non-negative number,
 * and a nano-USD amount that is a bigint of a given sign. A comparison such as `value < 0` is false for NaN and for a string, so
 * each guard checks the type first and states what is accepted, never what is refused.
 * @layer server
 */

/** A whole number from 0 to `Number.MAX_SAFE_INTEGER`: a token or call count. Refuses NaN, Infinity, fractions, negatives and non-numbers. */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A bigint of 0 or more: a nano-USD amount that may be zero. */
export function isNonNegativeBigint(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n
}

/** A bigint above 0: a nano-USD amount that moves money. */
export function isPositiveBigint(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n
}

/** A bigint other than 0: an adjustment that moves money in either direction. */
export function isNonZeroBigint(value: unknown): value is bigint {
  return typeof value === 'bigint' && value !== 0n
}
