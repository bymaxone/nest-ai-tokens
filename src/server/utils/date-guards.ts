/**
 * @fileoverview The guards of a date a caller supplies. A date that is not a valid `Date` (an Invalid Date, a number, a string,
 * `null`) reaches a store as a raw driver error, or is compared as `NaN` and matches nothing, so each entry point refuses it with
 * the typed invalid-configuration error that names the input and never repeats the value.
 * @layer server
 */

import { AiTokensException } from '../errors'
import { isValidDate } from './numeric-guards'

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
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a valid `Date`.
 */
export function assertDate(name: string, value: unknown): void {
  if (!isValidDate(value)) throw notADate(name)
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
