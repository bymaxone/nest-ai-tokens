/**
 * @fileoverview The one test of whether a value is a `Date`. `instanceof Date` is false for a valid date from another realm (a
 * `vm` context, an iframe), which every place that tells a date from an object would then read as an object, and true for a Proxy
 * of a date, which every method of `Date` then refuses, so each of them asks here. The test is the date's own brand, read by calling
 * `getTime` of the intrinsic on it, which a Date of any realm and a subclass of one pass and a Proxy of a date, an object that only
 * claims the tag, and everything else fail. It uses no Node built-in.
 * @layer shared
 */

/**
 * Whether `value` is a `Date` of any realm, valid or not.
 *
 * @param value Any value.
 * @returns `true` for a `Date`, a subclass of `Date` and a `Date` from another realm, whose time may be invalid.
 */
export function isDate(value: unknown): value is Date {
  if (typeof value !== 'object' || value === null) return false
  try {
    Date.prototype.getTime.call(value)
    return true
  } catch {
    return false
  }
}
