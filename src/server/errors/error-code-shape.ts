/**
 * @fileoverview The one test of whether a failure's `code` is safe to repeat: it has the shape of a code (`P2010`,
 * `ECONNREFUSED`), which a sentence, a value or a secret does not. It is shared by the typed error of the PostgreSQL store and
 * the log line of the hold reaper, so the two agree on what a driver may say.
 * @layer server
 */

/** The shape of a driver error's code: an upper-case identifier of at most 32 characters. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,31}$/

/** Whether `value` is a string with the shape of an error code. */
export function isCodeShaped(value: unknown): value is string {
  return typeof value === 'string' && CODE_SHAPE.test(value)
}
