/**
 * @fileoverview The guards of a date a caller supplies. A date that is not a valid `Date` (an Invalid Date, a number, a string,
 * `null`) reaches a store as a raw driver error, or is compared as `NaN` and matches nothing, so each entry point refuses it with
 * the typed invalid-configuration error that names the input and never repeats the value.
 * @layer server
 */

import { AiTokensException } from '../errors'
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
 * Throw unless `value`, when given, is a valid `Date`; `undefined` is the default and passes.
 *
 * @param name The input the reason names.
 * @param value The date the caller supplied, or `undefined`.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is given and is not a valid `Date`.
 */
export function assertOptionalDate(name: string, value: unknown): void {
  if (value !== undefined) assertDate(name, value)
}
