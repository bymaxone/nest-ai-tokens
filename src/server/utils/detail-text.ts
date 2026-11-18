/**
 * @fileoverview The bound on a supplied value that an error's `details` may carry. A runtime error may name a value the
 * caller supplied so the caller can correlate it, but only when it is a string of a bounded length; anything else is left out, because `details` is serialised into an HTTP body.
 * @layer server
 */

/** The longest supplied string a `details` field may carry, in characters. */
export const MAX_DETAIL_CHARS = 256

/**
 * The fields whose value is a string of at most {@link MAX_DETAIL_CHARS} characters, and only those.
 *
 * @param fields The supplied values, by the name of the `details` field that would carry each.
 * @returns The fields that may be carried; a missing, non-string or over-long value is left out.
 */
export function suppliedDetails(fields: Readonly<Record<string, unknown>>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.length <= MAX_DETAIL_CHARS) kept[name] = value
  }
  return kept
}
