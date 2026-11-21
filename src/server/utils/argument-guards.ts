/**
 * @fileoverview The guards of the arguments a caller passes to a public method. An argument of the wrong kind (a symbol, a bigint,
 * an object where a string belongs, a string where a count belongs) reaches a template string, a `BigInt()` conversion, a
 * `JSON.stringify` or a store, and there it fails with a raw `TypeError`, `RangeError` or `SyntaxError` whose message repeats the
 * value. Each method refuses it first with the typed invalid-configuration error that names the argument and never repeats the
 * value. The checks are of type only: what a string or a count means is each method's own rule.
 * @layer server
 */

import { AiTokensException } from '../errors'
import { isDate } from '../../shared/utils/is-date'
import { isCount, isNonNegativeBigint } from './numeric-guards'

/** The typed refusal of an argument, naming it and never repeating a value. */
function refused(reason: string): AiTokensException {
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check the code and the argument name
  return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
}

/** The longest prototype chain read as the fields of an argument: a class hierarchy is a handful of levels, so a longer chain is refused. */
const MAX_PROTOTYPE_DEPTH = 32

/**
 * Whether `value` is the `Object.prototype` of some realm: the object that ends every ordinary chain, whose own `constructor` is a function
 * whose `prototype` is that object. A null-prototype object a host built is not, so its fields are the host's own.
 */
function isRealmRoot(value: object): boolean {
  const constructor = Object.getOwnPropertyDescriptor(value, 'constructor')?.value as { prototype?: unknown } | undefined
  return typeof constructor === 'function' && constructor.prototype === value
}

/**
 * The value of a field of an argument, read by its name. The field is the host's own, or one its class or prototype chain defines up to
 * the root of the chain (the `Object.prototype` of whichever realm the object comes from, which is skipped so that a key another library
 * planted there is not read as a field of the input); an accessor runs with the argument as `this`. A getter, or a Proxy trap, that throws
 * would put the host's own error, with its own text, in the caller's hands, so it is refused as an argument that cannot be read, and so
 * is a chain too long to be a class hierarchy.
 *
 * @param value The argument object.
 * @param key The field to read.
 * @param name What the refusal calls the field.
 * @returns The value of the field, or `undefined` when the object has no such field.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field when reading it throws.
 */
export function readField(value: object, key: string, name: string): unknown {
  try {
    let holder: object = value
    for (let depth = 0; ; depth += 1) {
      if (depth === MAX_PROTOTYPE_DEPTH) throw new RangeError()
      const next = Object.getPrototypeOf(holder) as object | null
      // A key found solely on the root of the chain, built in or planted by another library, is not a field of the argument; a key found
      // nowhere at all is still asked of the object, which a Proxy answers by its `get` trap without having a key of its own.
      if (next === null) return depth > 0 && isRealmRoot(holder) && Object.hasOwn(holder, key) ? undefined : Reflect.get(value, key)
      if (Object.hasOwn(holder, key)) return Reflect.get(value, key)
      holder = next
    }
  } catch {
    throw refused(`${name} could not be read`)
  }
}

/**
 * The fields of an argument object whose names the library cannot know, such as the keys of a record: its own keys, enumerable or not
 * (a field defined with `enumerable: false` is read by name by the services, so it is a field), and the accessors and data its class or
 * prototype chain defines up to the root of the chain. A Proxy whose trap throws would put the host's own error in the caller's hands,
 * so it is refused as an argument that cannot be read.
 *
 * @param value The argument object.
 * @param name What the refusal calls the object.
 * @returns The names of the fields.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the object when listing its fields throws.
 */
export function keysOf(value: object, name: string): string[] {
  try {
    const keys = new Set(Object.getOwnPropertyNames(value))
    let proto = Object.getPrototypeOf(value) as object | null
    for (let depth = 0; proto !== null; depth += 1) {
      // A chain this long is no class hierarchy: it is refused, not walked, which also ends a Proxy whose prototype loops.
      if (depth === MAX_PROTOTYPE_DEPTH) throw new RangeError()
      const next = Object.getPrototypeOf(proto) as object | null
      // The `Object.prototype` of whichever realm adds nothing; a null-prototype object of the host's own that ends the chain does.
      if (next === null && isRealmRoot(proto)) break
      for (const key of Object.getOwnPropertyNames(proto)) if (key !== 'constructor') keys.add(key)
      proto = next
    }
    return [...keys]
  } catch {
    throw refused(`${name} could not be read`)
  }
}

/** A key that can be written in a refusal as it is: letters and digits, starting with a letter, of a bounded length. */
const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/

/**
 * How a key of the host's object is written in a refusal. A key is the host's, or an end user's through the host, so it can hold line
 * breaks, control or bidirectional characters, or be of any length: only a plain key is written, and every other one is a fixed marker.
 *
 * @param key A key of an object the host supplied.
 * @returns The key, or `<key>`.
 */
export function labelOf(key: string): string {
  return PLAIN_KEY.test(key) ? key : '<key>'
}

/** The deepest nesting of lists and objects read from an argument: a longer one is a cycle or not an argument. */
const MAX_NESTING = 8

/** The deepest nesting read from the usage of a provider, whose response can carry the JSON arguments of a tool call. */
export const MAX_USAGE_NESTING = 64

/** The longest list, and the most keys of one object, read from an argument. */
const MAX_LIST_LENGTH = 100_000

/** The most different lists and objects one read copies; each costs the reads of its keys, about 30 microseconds. */
const MAX_CONTAINERS = 10_000

/** The most other values one read visits: a batch of 100 embeddings of 3072 numbers is 307_200. */
const MAX_LEAVES = 1_000_000

/** What one read of an argument has used up: the lists and objects being copied above the value, the copies made so far, and how many of each kind of value it has visited. */
interface Visit {
  readonly path: Set<object>
  readonly copies: Map<object, unknown>
  containers: number
  leaves: number
}

/**
 * A copy of a value read once, all the way down: a list or an object nested in an argument is copied element by element through
 * {@link readField}, so a Proxy list whose `get` or `length` throws, or a nested getter that answers once, cannot fail the call after
 * it has begun. A date, a primitive and a function are returned as they are; an object is copied to one with no prototype. A list or an
 * object reached again, through another branch, is not read again: the copy already made is the one returned, so the work follows the
 * number of different values and a value that shares a child between its branches costs no more than a tree of its size. A value that
 * contains itself is refused, whatever the limit, and so is a read of more different lists and objects, or of more other values, than a
 * batch of provider responses holds.
 * The copy is only read, never changed, by the consumers of an argument, which read fields by name, so a child shared by two branches may
 * be one object in it.
 *
 * @param value The value to copy.
 * @param name What the refusal calls the value.
 * @param depth How deep in the argument the value is, counted from the argument itself as 0.
 * @param limit The depth at which a nested value is refused.
 * @param visit What the read has used up, shared by every value of one read.
 * @returns The copy.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the value when it cannot be read, contains itself, is nested too deep, is too long or is too large.
 */
export function readDeep(value: unknown, name: string, depth: number, limit = MAX_NESTING, visit: Visit = { path: new Set<object>(), copies: new Map<object, unknown>(), containers: 0, leaves: 0 }): unknown {
  if (typeof value !== 'object' || value === null || isDate(value)) {
    visit.leaves += 1
    if (visit.leaves > MAX_LEAVES) throw refused(`${name} could not be read`)
    return value
  }
  if (visit.path.has(value)) throw refused(`${name} could not be read`)
  if (visit.copies.has(value)) return visit.copies.get(value)
  visit.containers += 1
  if (visit.containers > MAX_CONTAINERS || depth >= limit) throw refused(`${name} could not be read`)
  visit.path.add(value)
  try {
    if (Array.isArray(value)) {
      const length = readField(value, 'length', name)
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_LIST_LENGTH) throw refused(`${name} could not be read`)
      const items = Array.from({ length }, (_, index) => readDeep(readField(value, String(index), `${name}[${String(index)}]`), `${name}[${String(index)}]`, depth + 1, limit, visit))
      visit.copies.set(value, items)
      return items
    }
    const keys = keysOf(value, name)
    if (keys.length > MAX_LIST_LENGTH) throw refused(`${name} could not be read`)
    const copy = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      Object.defineProperty(copy, key, { value: readDeep(readField(value, key, `${name}.${labelOf(key)}`), `${name}.${labelOf(key)}`, depth + 1, limit, visit), enumerable: true })
    }
    visit.copies.set(value, copy)
    return copy
  } finally {
    visit.path.delete(value)
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
  assertText('hold.id', value.id)
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
  assertText(`${name}.type`, value.type)
  assertText(`${name}.id`, value.id)
}

/**
 * Throw unless `value` is the reference of a wallet: an object whose `tenantId`, `ownerType` and `ownerId` are strings.
 *
 * @param value What the caller passed.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when it is not a wallet reference.
 */
export function assertWalletRef(value: unknown): void {
  assertObject('wallet', value)
  assertText('wallet.tenantId', value.tenantId)
  assertText('wallet.ownerType', value.ownerType)
  assertText('wallet.ownerId', value.ownerId)
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
  assertText('context.tenantId', value.tenantId)
  assertScope('context.scope', value.scope)
  if (value.beneficiary !== undefined) assertScope('context.beneficiary', value.beneficiary)
  assertText('context.feature', value.feature)
  for (const field of CONTEXT_TEXT_FIELDS) assertOptionalText(`context.${field}`, value[field])
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
  for (const field of ['provider', 'model', 'operation'] as const) assertText(field, value[field])
  assertOptionalText('feature', value.feature)
  if (value.scope !== undefined) assertScope('scope', value.scope)
  assertCount('inputTokens', value.inputTokens)
  assertCount('maxOutputTokens', value.maxOutputTokens)
}
