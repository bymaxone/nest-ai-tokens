/**
 * @fileoverview The guards of a date a caller supplies. A date that is not a valid `Date` (an Invalid Date, a number, a string,
 * `null`) reaches a store as a raw driver error, or is compared as `NaN` and matches nothing, so each entry point refuses it with
 * the typed invalid-configuration error that names the input and never repeats the value.
 * @layer server
 */

import { AiTokensException } from '../errors'
import type { MeteringScope } from '../../shared'
import { assertObject, assertScope, assertText, readDeep, readField } from './argument-guards'
import { AMOUNT_ESTIMATE_FIELDS, RATED_ESTIMATE_FIELDS, SCOPE_FIELDS, TOKEN_ESTIMATE_FIELDS, type FieldList, type Shape } from './input-fields'
import { isDate } from '../../shared/utils/is-date'
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
 * A snapshot of an object read by the names of its type, once: each field the shape lists is read a single time, by its name; an
 * object among them that the shape describes is read the same way, and any other list or object is copied through {@link readDeep}.
 * The named date fields are replaced by {@link readDate} copies. The caller's object is not read again, so a getter or a Proxy trap that
 * answers once and throws afterwards cannot fail after the call has begun. A field the host left out, or set to `undefined`, is absent.
 *
 * @param input The object the caller supplied.
 * @param shape The fields of its type, and of the objects nested in it.
 * @param dates The names of its date fields.
 * @param prefix Text put before a field's name in a refusal.
 * @returns A new object with no prototype, holding the values read.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read or is not a valid date.
 */
export function readShape(input: object, shape: Shape, dates: readonly string[] = [], prefix = ''): Record<string, unknown> {
  // No prototype: a key that another library put on `Object.prototype` is not found on the snapshot, whatever the call reads from it.
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(shape.fields)) {
    const name = `${prefix}${key}`
    const raw = readField(input, key, name)
    const inner = shape.nested?.[key]
    const value = inner !== undefined && isRecord(raw) ? readShape(raw, inner, [], `${name}.`) : readDeep(raw, name, 1)
    // Defined, not assigned: a key that another library put on `Object.prototype` as read-only would make an assignment throw.
    // Enumerable on purpose: the snapshot is the library's own plain data, which the stores spread, so a field that is not enumerable would be dropped downstream.
    if (value !== undefined) Object.defineProperty(copy, key, { value, enumerable: true, writable: true })
  }
  for (const field of dates) {
    if (copy[field] !== undefined) copy[field] = readDate(`${prefix}${field}`, copy[field])
  }
  return copy
}

/** Whether a value is an object that a shape can describe: not `null`, a list or a date. */
function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isDate(value)
}

/**
 * {@link readShape} for an argument that may not be an object: anything else is returned as it is, for the check of the argument to refuse.
 *
 * @param argument What the caller passed.
 * @param shape The fields of its type, and of the objects nested in it.
 * @param dates The names of its date fields.
 * @param prefix Text put before a field's name in a refusal.
 * @returns The snapshot of an object, or `argument` itself.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` as {@link readShape} does.
 */
export function readArgument<T>(argument: T, shape: Shape, dates: readonly string[] = [], prefix = ''): T {
  return isRecord(argument) ? (readShape(argument, shape, dates, prefix) as T) : argument
}

/**
 * The estimate of a hold, read by the names of the variant it is: one that names a provider is rated by model, one that names tokens is
 * sized in tokens, any other in nano-USD, and only the fields of that variant are read, so a getter named like a field of another variant
 * is never run. Anything that is not an object is returned as it is, for the check of the estimate to refuse.
 *
 * @param estimate What the caller passed.
 * @returns The snapshot of an object, or `estimate` itself.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the estimate or the field that cannot be read.
 */
export function readHoldEstimate<T>(estimate: T): T {
  if (!isRecord(estimate)) return estimate
  let fields: object
  try {
    fields = Reflect.has(estimate, 'provider') ? RATED_ESTIMATE_FIELDS : Reflect.has(estimate, 'tokens') ? TOKEN_ESTIMATE_FIELDS : AMOUNT_ESTIMATE_FIELDS
  } catch {
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'estimate could not be read' })
  }
  return readShape(estimate, { fields }, [], 'estimate.') as T
}

/**
 * A snapshot of an input object, read once, by the names in `fields`; see {@link readShape}.
 *
 * @param input The object the caller supplied.
 * @param fields The fields of its type, by name.
 * @param dates The names of its date fields.
 * @param prefix Text put before a field's name in a refusal.
 * @returns A new object with no prototype, holding the values read.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read or is not a valid date.
 */
export function withReadDates<T extends object>(input: T, fields: FieldList<T>, dates: readonly (keyof T & string)[] = [], prefix = ''): T {
  return readShape(input, { fields }, dates, prefix) as T
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

/**
 * The scope of a lookup, read once: the tenant must be a string and the scope an object with a type and an id, and what comes back is
 * the snapshot of the scope, which every later use of the lookup reads.
 *
 * @param tenantId The tenant the caller passed.
 * @param scope The scope the caller passed.
 * @returns The snapshot of the scope.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the argument that is not valid or cannot be read.
 */
export function lookupScope(tenantId: unknown, scope: unknown): MeteringScope {
  assertText('tenantId', tenantId)
  assertObject('scope', scope)
  const own = snapshotOf(scope as object as MeteringScope, SCOPE_FIELDS)
  assertScope('scope', own)
  return own
}
