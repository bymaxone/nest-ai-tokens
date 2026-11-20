/**
 * @fileoverview Type guards for the numbers the library takes at its boundaries: a count that is a whole non-negative number,
 * and a nano-USD amount that is a bigint of a given sign. A comparison such as `value < 0` is false for NaN and for a string, so
 * each guard checks the type first and states what is accepted, never what is refused.
 * @layer server
 */

import { isDate } from '../../shared/utils/is-date'

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

/** A number above 0 and at most 1: an alert threshold, the fraction of a limit at which it fires. */
export function isFraction(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && value <= 1
}

/**
 * A valid `Date`: one whose internal slot says so, which a `Date` from another realm and a subclass of `Date` have and a Proxy of one
 * does not, and whose time is a number, not an `Invalid Date`, whose comparisons are all false. A subclass whose own `getTime`,
 * `valueOf` or `toISOString` throws is not one, because the library or a store would call it and fail with the host's own error.
 */
export function isValidDate(value: unknown): value is Date {
  if (!isDate(value)) return false
  try {
    return Number.isFinite(value.getTime()) && Number.isFinite(Date.prototype.getTime.call(value)) && Number.isFinite(value.valueOf()) && typeof value.toISOString() === 'string'
  } catch {
    return false
  }
}
