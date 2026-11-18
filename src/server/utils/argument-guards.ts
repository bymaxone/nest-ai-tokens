/**
 * @fileoverview The guards of the arguments a caller passes to a public method. An argument of the wrong kind (a symbol, a bigint,
 * an object where a string belongs, a string where a count belongs) reaches a template string, a `BigInt()` conversion, a
 * `JSON.stringify` or a store, and there it fails with a raw `TypeError`, `RangeError` or `SyntaxError` whose message repeats the
 * value. Each method refuses it first with the typed invalid-configuration error that names the argument and never repeats the
 * value. The checks are of type only: what a string or a count means is each method's own rule.
 * @layer server
 */

import { AiTokensException } from '../errors'
import { isCount } from './numeric-guards'

/** The typed refusal of an argument, naming it and never repeating a value. */
function refused(reason: string): AiTokensException {
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check the code and the argument name
  return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
}

/** Whether a value is a plain object: an object that is neither `null` nor an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Throw unless `value` is an object (not `null`, not an array).
 *
 * @param name The argument the reason names.
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not an object.
 */
export function assertObject(name: string, value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw refused(`${name} must be an object`)
}

/**
 * Throw unless `value` is a string.
 *
 * @param name The argument the reason names.
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a string.
 */
export function assertText(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') throw refused(`${name} must be a string`)
}

/**
 * Throw unless `value`, when given, is a string; `undefined` is the default and passes.
 *
 * @param name The argument the reason names.
 * @param value What the caller passed, or `undefined`.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is given and is not a string.
 */
export function assertOptionalText(name: string, value: unknown): asserts value is string | undefined {
  if (value !== undefined) assertText(name, value)
}

/**
 * Throw unless `value` is a whole number of 0 or more.
 *
 * @param name The argument the reason names.
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a count.
 */
export function assertCount(name: string, value: unknown): asserts value is number {
  if (!isCount(value)) throw refused(`${name} must be a whole number of 0 or more`)
}

/**
 * Throw unless `value`, when given, is a whole number of 0 or more; `undefined` is the default and passes.
 *
 * @param name The argument the reason names.
 * @param value What the caller passed, or `undefined`.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is given and is not a count.
 */
export function assertOptionalCount(name: string, value: unknown): asserts value is number | undefined {
  if (value !== undefined) assertCount(name, value)
}

/**
 * Throw unless `value` is a scope: an object whose `type` and `id` are strings.
 *
 * @param name The argument the reason names.
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a scope.
 */
export function assertScope(name: string, value: unknown): void {
  assertObject(name, value)
  assertText(`${name}.type`, Reflect.get(value, 'type'))
  assertText(`${name}.id`, Reflect.get(value, 'id'))
}

/**
 * Throw unless `value` is the reference of a wallet: an object whose `tenantId`, `ownerType` and `ownerId` are strings.
 *
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a wallet reference.
 */
export function assertWalletRef(value: unknown): void {
  assertObject('wallet', value)
  assertText('wallet.tenantId', Reflect.get(value, 'tenantId'))
  assertText('wallet.ownerType', Reflect.get(value, 'ownerType'))
  assertText('wallet.ownerId', Reflect.get(value, 'ownerId'))
}

/** The optional text fields of a metering context. */
const CONTEXT_TEXT_FIELDS = ['requestedBy', 'baseModel', 'idempotencyKey', 'correlationId', 'systemCostCategory'] as const

/**
 * Throw unless `value` is a metering context whose identifying fields are strings and whose scopes are scopes.
 *
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the first field that is not valid.
 */
export function assertMeteringContext(value: unknown): void {
  assertObject('context', value)
  assertText('context.tenantId', Reflect.get(value, 'tenantId'))
  assertScope('context.scope', Reflect.get(value, 'scope'))
  if (Reflect.get(value, 'beneficiary') !== undefined) assertScope('context.beneficiary', Reflect.get(value, 'beneficiary'))
  assertText('context.feature', Reflect.get(value, 'feature'))
  for (const field of CONTEXT_TEXT_FIELDS) assertOptionalText(`context.${field}`, Reflect.get(value, field))
}

/**
 * Throw unless `value` is the input of a cost estimate: the identity of the call is text, the token counts are whole numbers, and the
 * optional feature and scope are what they should be. The optional tier is checked where the rate is resolved.
 *
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the first field that is not valid.
 */
export function assertEstimateCostInput(value: unknown): void {
  assertObject('input', value)
  for (const field of ['provider', 'model', 'operation'] as const) assertText(field, Reflect.get(value, field))
  assertOptionalText('feature', Reflect.get(value, 'feature'))
  const scope: unknown = Reflect.get(value, 'scope')
  if (scope !== undefined) assertScope('scope', scope)
  assertCount('inputTokens', Reflect.get(value, 'inputTokens'))
  assertCount('maxOutputTokens', Reflect.get(value, 'maxOutputTokens'))
}
