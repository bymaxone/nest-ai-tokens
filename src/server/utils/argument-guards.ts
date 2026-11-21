/**
 * @fileoverview The guards of the arguments a caller passes to a public method. An argument of the wrong kind (a symbol, a bigint,
 * an object where a string belongs, a string where a count belongs) reaches a template string, a `BigInt()` conversion, a
 * `JSON.stringify` or a store, and there it fails with a raw `TypeError`, `RangeError` or `SyntaxError` whose message repeats the
 * value. Each method refuses it first with the typed invalid-configuration error that names the argument and never repeats the
 * value. The checks are of type only: what a string or a count means is each method's own rule.
 * @layer server
 */

import { AiTokensException } from '../errors'
import { isCount, isNonNegativeBigint } from './numeric-guards'

/** The typed refusal of an argument, naming it and never repeating a value. */
function refused(reason: string): AiTokensException {
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check the code and the argument name
  return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
}

/**
 * The value of a field of an argument. A getter, or a Proxy trap, that throws would put the host's own error, with its own text, in the
 * caller's hands, so it is refused as an argument that cannot be read.
 *
 * @param value The argument object.
 * @param key The field to read.
 * @param name What the refusal calls the field.
 * @returns The value of the field.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field when reading it throws.
 */
export function readField(value: object, key: string, name: string): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    throw refused(`${name} could not be read`)
  }
}

/** The longest prototype chain read as the fields of an argument: a class hierarchy is a handful of levels, so a longer chain is refused. */
const MAX_PROTOTYPE_DEPTH = 32

/**
 * The fields of an argument object: its own enumerable keys, and the accessors and data its class or prototype chain defines up to
 * `Object.prototype`, which an instance of a class holds as getters. A Proxy whose trap throws would put the host's own error in the
 * caller's hands, so it is refused as an argument that cannot be read.
 *
 * @param value The argument object.
 * @param name What the refusal calls the object.
 * @returns The names of the fields.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the object when listing its fields throws.
 */
export function keysOf(value: object, name: string): string[] {
  try {
    const keys = new Set(Object.keys(value))
    let proto = Object.getPrototypeOf(value) as object | null
    for (let depth = 0; proto !== null && proto !== Object.prototype; depth += 1) {
      // A chain this long is no class hierarchy: it is refused, not walked, which also ends a Proxy whose prototype loops.
      if (depth === MAX_PROTOTYPE_DEPTH) throw new RangeError()
      for (const key of Object.getOwnPropertyNames(proto)) if (key !== 'constructor') keys.add(key)
      proto = Object.getPrototypeOf(proto) as object | null
    }
    return [...keys]
  } catch {
    throw refused(`${name} could not be read`)
  }
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
  // A NUL character is a string a text column of PostgreSQL cannot hold, so it is refused here, naming the argument, and not by the store.
  if (value.includes('\u0000')) throw refused(`${name} must not contain a NUL character`)
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
 * Throw unless `value`, when given, is a bigint from 0 to 2^63 - 1; `undefined` is the default and passes.
 *
 * @param name The argument the reason names.
 * @param value What the caller passed, or `undefined`.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is given and is not a bigint from 0 to 2^63 - 1.
 */
export function assertOptionalAmount(name: string, value: unknown): asserts value is bigint | undefined {
  if (value !== undefined && !isNonNegativeBigint(value)) throw refused(`${name} must be a bigint from 0 to 9223372036854775807`)
}

/**
 * Throw unless every value is a string, naming the first that is not by its key.
 *
 * @param values The arguments by name.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the first argument that is not a string.
 */
export function assertTexts(values: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(values)) assertText(name, value)
}

/**
 * Throw unless the arguments of a lookup are a tenant id and a scope.
 *
 * @param tenantId The tenant the caller passed.
 * @param scope The scope the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the argument that is not valid.
 */
export function assertLookup(tenantId: unknown, scope: unknown): void {
  assertText('tenantId', tenantId)
  assertScope('scope', scope)
}

/**
 * Throw unless `tenantId` is a non-empty string, so a plain-JavaScript caller never reaches the store with a coerced key.
 *
 * @param tenantId What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a non-empty string.
 */
export function assertTenant(tenantId: unknown): asserts tenantId is string {
  // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
  if (typeof tenantId !== 'string' || tenantId === '') throw refused('tenantId must be a non-empty string')
  assertText('tenantId', tenantId)
}

/**
 * Throw unless `value`, a snapshot of a budget definition, has a scope, and an id and features that are text when given.
 *
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the first field that is not valid.
 */
export function assertBudgetShape(value: Record<string, unknown>): void {
  assertScope('scope', value.scope)
  assertOptionalText('id', value.id)
  if (value.features !== undefined) assertTextList('features', value.features)
}

/**
 * Throw unless `value` is a list of strings.
 *
 * @param name The argument the reason names.
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not an array or an element is not a string.
 */
export function assertTextList(name: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !(value as unknown[]).every((item) => typeof item === 'string')) throw refused(`${name} must be a list of strings`)
}

/**
 * Throw unless `value` is a hold: an object whose `id` is a string. Only the id is read.
 *
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a hold.
 */
export function assertHold(value: unknown): void {
  assertObject('hold', value)
  assertText('hold.id', readField(value, 'id', 'hold.id'))
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
  assertText(`${name}.type`, readField(value, 'type', `${name}.type`))
  assertText(`${name}.id`, readField(value, 'id', `${name}.id`))
}

/**
 * Throw unless `value` is the reference of a wallet: an object whose `tenantId`, `ownerType` and `ownerId` are strings.
 *
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a wallet reference.
 */
export function assertWalletRef(value: unknown): void {
  assertObject('wallet', value)
  assertText('wallet.tenantId', readField(value, 'tenantId', 'wallet.tenantId'))
  assertText('wallet.ownerType', readField(value, 'ownerType', 'wallet.ownerType'))
  assertText('wallet.ownerId', readField(value, 'ownerId', 'wallet.ownerId'))
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
  assertText('context.tenantId', readField(value, 'tenantId', 'context.tenantId'))
  assertScope('context.scope', readField(value, 'scope', 'context.scope'))
  const beneficiary = readField(value, 'beneficiary', 'context.beneficiary')
  if (beneficiary !== undefined) assertScope('context.beneficiary', beneficiary)
  assertText('context.feature', readField(value, 'feature', 'context.feature'))
  for (const field of CONTEXT_TEXT_FIELDS) assertOptionalText(`context.${field}`, readField(value, field, `context.${field}`))
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
  for (const field of ['provider', 'model', 'operation'] as const) assertText(field, readField(value, field, field))
  assertOptionalText('feature', readField(value, 'feature', 'feature'))
  const scope = readField(value, 'scope', 'scope')
  if (scope !== undefined) assertScope('scope', scope)
  assertCount('inputTokens', readField(value, 'inputTokens', 'inputTokens'))
  assertCount('maxOutputTokens', readField(value, 'maxOutputTokens', 'maxOutputTokens'))
}
