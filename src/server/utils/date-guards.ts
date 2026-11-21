/**
 * @fileoverview The guards of a date a caller supplies. A date that is not a valid `Date` (an Invalid Date, a number, a string,
 * `null`) reaches a store as a raw driver error, or is compared as `NaN` and matches nothing, so each entry point refuses it with
 * the typed invalid-configuration error that names the input and never repeats the value.
 * @layer server
 */

import { AiTokensException } from '../errors'
import { readDeep, readField } from './argument-guards'
import type { FieldList } from './input-fields'
import { isValidDate } from './numeric-guards'

/** The first instant of the supported range, 0001-01-01T00:00:00.000Z, in milliseconds since the epoch. */
const FIRST_SUPPORTED_MS = -62_135_596_800_000

/** The last instant of the supported range, 9999-12-31T23:59:59.999Z, in milliseconds since the epoch. */
const LAST_SUPPORTED_MS = 253_402_300_799_999

/** The typed refusal of an input that is not a valid date. */
function notADate(name: string): AiTokensException {
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check the code and the input name
  return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: `${name} must be a valid date` })
}

/**
 * Throw unless `value` is a valid `Date`.
 *
 * @param name The input the reason names.
 * @param value The date the caller supplied.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a valid `Date`, or is before the year 1 or after the year 9999.
 */
export function assertDate(name: string, value: unknown): void {
  if (!isValidDate(value)) throw notADate(name)
  const time = Date.prototype.getTime.call(value)
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check the code and the input name
  if (time < FIRST_SUPPORTED_MS || time > LAST_SUPPORTED_MS) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: `${name} must be a date from the year 1 to the year 9999` })
}

/**
 * Validate a date a caller supplied and return a native `Date` of the same instant, read once. Every later use works on the copy, so a
 * subclass whose methods answer once and throw afterwards, or a getter that changes, cannot fail after the call has begun.
 *
 * @param name The input the reason names.
 * @param value The date the caller supplied.
 * @returns A new `Date` for the instant of `value`.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` as {@link assertDate} does.
 */
export function readDate(name: string, value: unknown): Date {
  assertDate(name, value)
  return new Date(Date.prototype.getTime.call(value))
}

/**
 * {@link readDate} for a date that may be left out; `undefined` stays `undefined`.
 *
 * @param name The input the reason names.
 * @param value The date the caller supplied, or `undefined`.
 * @returns A new `Date`, or `undefined`.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is given and is not a valid date.
 */
export function readOptionalDate(name: string, value: unknown): Date | undefined {
  return value === undefined ? undefined : readDate(name, value)
}

/**
 * A snapshot of an input object, read once: each field named in `fields` is read a single time, by its name, and a list or an object
 * nested in a field is copied the same way; the named date fields are replaced by {@link readDate} copies. The caller's object is not
 * read again, so a getter or a Proxy trap that answers once and throws afterwards cannot fail after the call has begun, and every check
 * and every use works on the same values. A field the host left out, or set to `undefined`, is absent from the snapshot.
 *
 * @param input The object the caller supplied.
 * @param fields The fields of its type, by name.
 * @param dates The names of its date fields.
 * @param prefix Text put before a field's name in a refusal.
 * @returns A new object with no prototype, holding the values read.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read or is not a valid date.
 */
export function withReadDates<T extends object>(input: T, fields: FieldList<T>, dates: readonly (keyof T & string)[] = [], prefix = ''): T {
  // No prototype: a key that another library put on `Object.prototype` is not found on the snapshot, whatever the call reads from it.
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    const value = readDeep(readField(input, key, `${prefix}${key}`), `${prefix}${key}`, 1)
    // Defined, not assigned: a key that another library put on `Object.prototype` as read-only would make an assignment throw.
    if (value !== undefined) Object.defineProperty(copy, key, { value, enumerable: true, writable: true })
  }
  for (const field of dates) {
    if (copy[field] !== undefined) copy[field] = readDate(`${prefix}${field}`, copy[field])
  }
  return copy as T
}

/**
 * A snapshot of an input object that holds no date: each field of `fields` is read once, as {@link withReadDates} does.
 *
 * @param input The object the caller supplied.
 * @param fields The fields of its type, by name.
 * @returns A new object holding the values read.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read.
 */
export function snapshotOf<T extends object>(input: T, fields: FieldList<T>): T {
  return withReadDates(input, fields)
}
