/**
 * @fileoverview Refuses to bill beside a realm that something polluted. Whatever sits on the `Object.prototype` of this realm is inherited by
 * every plain object a library reads a name from, and no shadow of ours can cover all of it, so a process that carries a name the engine does
 * not define is not one that money can be trusted to. The guard counts how far that prototype is from the one a fresh realm has, and how many
 * of the built-ins the library relies on are no longer the ones it met when it loaded, and refuses to operate while the count is not zero.
 * It fails closed and reports the count only, never a name or a value. It is checked at boot and before every operation that moves or reports
 * money; the structural reads of the library beneath it stay, for a plant made between the check and the read.
 * @layer server
 */

import nodeCrypto from 'node:crypto'
import { types } from 'node:util'
import { runInNewContext } from 'node:vm'
import { AiTokensException } from '../errors'
import { AI_TOKENS_ERROR_MESSAGES } from '../errors/ai-tokens-error-messages'
import { AI_TOKENS_ERROR_STATUS } from '../errors/ai-tokens-error-status'

/** What a fresh realm holds: the descriptors of its `Object.prototype` and a reader of function text. */
interface Pristine {
  readonly descriptors: Readonly<Record<string | symbol, PropertyDescriptor>>
  readonly sourceOf: (value: unknown) => string
}

/**
 * The one hidden symbol a test runner puts on `Object.prototype` of every test it runs, and which no code of the library or of a host reads:
 * counting it would refuse every host whose specs run under it. It is exempt only while it is not enumerable.
 */
const RUNNER_MARK = Symbol.for('$$jest-protect-from-deletion')

/** What the prototype held when this module loaded, so a name swapped for another native function is caught by identity. */
const loaded = Object.getOwnPropertyDescriptors(Object.prototype) as Record<string | symbol, PropertyDescriptor>

/**
 * The standard namespaces and constructors the library's call sites rely on. Every function-valued data property of each of them, and of its
 * prototype, is recorded when the module loads and compared by identity at every check, so no list of the functions the library calls has to be
 * kept: a function replaced after import, whichever it is, is counted. `Object.prototype` is left out, because it is compared by descriptor.
 */
const STANDARD = 'Object Reflect Array JSON Math Number String Boolean Promise Set Map WeakMap WeakSet ArrayBuffer DataView TextEncoder BigInt Date Symbol Error RegExp Function Uint8Array Proxy'

/**
 * The global names the call sites resolve when they run. A name rebound to another object leaves every function recorded above as it was and
 * changes every call that goes through the name. `Date` is in the list: a fake-timer library replaces it, so a spec that installs one turns the
 * guard off through the test seam for as long as it runs.
 */
const BOUND = 'Object Reflect Array JSON Math Number String Boolean Promise Set Map WeakMap WeakSet ArrayBuffer DataView TextEncoder BigInt Date Symbol Error RegExp Function Uint8Array Proxy'

/** What the baseline compares: an owner, a name on it, and the function or object that name held when this module loaded. */
interface Met {
  readonly owner: Record<string | symbol, unknown>
  readonly name: string | symbol
  readonly met: unknown
}

/**
 * Records the function-valued data properties of each owner, own names and symbols alike. Only descriptors are read, so no getter of a module
 * or a prototype runs (`crypto.fips`, for one, warns when it is read).
 *
 * @param owners The objects whose functions are recorded.
 * @returns One entry for each function.
 */
export function recordFunctions(owners: readonly object[]): Met[] {
  const found: Met[] = []
  for (const owner of owners) {
    for (const name of Reflect.ownKeys(owner)) {
      const value: unknown = Object.getOwnPropertyDescriptor(owner, name)?.value
      if (typeof value === 'function') found.push({ owner: owner as Met['owner'], name, met: value })
    }
  }
  return found
}

/**
 * Everything the baseline compares: the functions of {@link STANDARD}, of the iterator intrinsics that `for...of` and spreads go through, of the
 * Node modules the money path calls (the type tests of `util.types`, `crypto.randomUUID`), then the bindings of {@link BOUND}. Exported for the
 * specs only; no entry of the package re-exports it.
 */
export const BUILT_INS: readonly Met[] = (() => {
  const owners: object[] = []
  const typedArray = Object.getPrototypeOf(Uint8Array) as { prototype: object }
  for (const name of STANDARD.split(' ')) {
    const constructor = Reflect.get(globalThis, name) as { prototype?: unknown }
    owners.push(constructor)
    if (typeof constructor.prototype === 'object' && constructor.prototype !== null && constructor.prototype !== Object.prototype) owners.push(constructor.prototype)
  }
  owners.push(typedArray, typedArray.prototype)
  const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]()) as object
  // A generator is started once, so that its body is a function the engine has run; only its prototypes are read.
  const generated = function* (): Generator { yield 0 }
  const started = generated()
  started.next()
  owners.push(
    arrayIterator,
    Object.getPrototypeOf(arrayIterator) as object,
    Object.getPrototypeOf(new Set()[Symbol.iterator]()) as object,
    Object.getPrototypeOf(new Map()[Symbol.iterator]()) as object,
    Object.getPrototypeOf(''[Symbol.iterator]()) as object,
    Object.getPrototypeOf(''.matchAll(/a/g)) as object,
    Object.getPrototypeOf(generated) as object,
    Object.getPrototypeOf(Object.getPrototypeOf(started)) as object,
    types,
    nodeCrypto,
  )
  const found = recordFunctions(owners)
  for (const name of BOUND.split(' ')) {
    const bound: unknown = Reflect.get(globalThis, name)
    found.push({ owner: globalThis, name, met: bound })
  }
  return found
})()

/**
 * Builds a fresh realm and reads its `Object.prototype` and a reader of function text. The `vm` module reads its options from objects it
 * makes itself, so a name the prototype under test holds can make it throw: the realm is therefore built when this module loads, while the
 * process is normally still clean, and a build that fails is retried at the first use and, if it fails again, leaves the realm unable to be
 * compared, which counts as polluted.
 *
 * @returns The fresh realm's descriptors and text reader, or `undefined` when it could not be built.
 */
function build(): Pristine | undefined {
  try {
    return runInNewContext(
      '({ descriptors: Object.getOwnPropertyDescriptors(Object.prototype), sourceOf: (value) => Function.prototype.toString.call(value) })',
    ) as Pristine
  } catch {
    return undefined
  }
}

let pristine: Pristine | undefined = build()

/** The fields of a descriptor that hold what the name is. */
const CONTENT = ['value', 'get', 'set'] as const

// What the scan itself calls, captured when the module loads: a built-in replaced afterwards, a `Set` that forgets what it is given or an
// iterator that stops early, cannot blind the check that is meant to find it. The scan uses these references, plain loops over arrays and
// plain property reads, and nothing else of the realm.
const getDescriptors = Object.getOwnPropertyDescriptors
const ownKeysOf = Reflect.ownKeys
const hasOwn = Object.hasOwn
const getOf = Reflect.get
const root = Object.prototype
const stringOf = String
const createObject = Object.create
const define = Object.defineProperty
const captureStack = Error.captureStackTrace.bind(Error)

/** The item of a list at an index, read by a plain property read, so that no iterator of the realm is run to reach it. */
function item<T>(list: ArrayLike<T>, index: number): T {
  const value: unknown = getOf(list, index)
  return value as T
}

/**
 * A field of a descriptor, as its own property only: a descriptor of this realm inherits from the prototype under test, so a name planted
 * there, an accessor called `get` say, must never run.
 *
 * @param descriptor A descriptor, or `undefined`.
 * @param key The field.
 * @returns The own field, or `undefined`.
 */
function field(descriptor: PropertyDescriptor | undefined, key: keyof PropertyDescriptor): unknown {
  return descriptor !== undefined && hasOwn(descriptor, key) ? (getOf(descriptor, key) as unknown) : undefined
}

/**
 * Whether a value of `now` is the one of `was`: the same text for a function, else the same value.
 *
 * @param now A value of this realm.
 * @param was The value of the fresh realm.
 * @param sourceOf Reads function text.
 * @returns `true` when they are alike.
 */
function alike(now: unknown, was: unknown, sourceOf: Pristine['sourceOf']): boolean {
  return typeof was === 'function' ? typeof now === 'function' && sourceOf(now) === sourceOf(was) : now === was
}

/**
 * Whether the descriptor a name has now is the one the engine gives it: the same enumerability and the same content, which for a name this
 * module met is also the very same function or value. Its writable and configurable flags are not compared: the engine gives every name of
 * this prototype both, so a frozen realm is safe and no name can be looser.
 */
function unchanged(have: PropertyDescriptor | undefined, want: PropertyDescriptor | undefined, name: string | symbol, sourceOf: Pristine['sourceOf']): boolean {
  if (field(have, 'enumerable') !== field(want, 'enumerable')) return false
  for (let index = 0; index < CONTENT.length; index += 1) {
    const key = item(CONTENT, index)
    if (!alike(field(have, key), field(want, key), sourceOf)) return false
    if (hasOwn(loaded, name) && field(have, key) !== field(loaded[name], key)) return false
  }
  return true
}

/**
 * Counts the names of this realm's `Object.prototype` that a fresh realm's does not hold, that it lacks, or that it holds changed (its
 * enumerability, or a function whose text is not the engine's, or is not the one this module met), and the built-ins that are no longer the
 * ones it met.
 *
 * @returns Zero for a clean realm.
 */
export function pollutedNames(): number {
  pristine ??= build()
  if (pristine === undefined) return 1
  const { descriptors, sourceOf } = pristine
  const now = getDescriptors(root) as Record<string | symbol, PropertyDescriptor>
  const nowKeys = ownKeysOf(now)
  const wantKeys = ownKeysOf(descriptors)
  let found = 0
  // The scan builds no list and writes no array: an element assigned to an array goes through the setters of its prototype chain, where an
  // index accessor planted on `Object.prototype` or `Array.prototype` would swallow it. A name is counted once: the names of this realm first,
  // then the names of the fresh realm that this realm lacks.
  for (let index = 0; index < nowKeys.length; index += 1) {
    const name = item(nowKeys, index)
    if (name === RUNNER_MARK && field(now[name], 'enumerable') !== true) continue
    if (!unchanged(now[name], hasOwn(descriptors, name) ? descriptors[name] : undefined, name, sourceOf)) found += 1
  }
  for (let index = 0; index < wantKeys.length; index += 1) {
    // A name the fresh realm has and this one lacks is a standard name that was deleted.
    if (!hasOwn(now, item(wantKeys, index))) found += 1
  }
  for (let index = 0; index < BUILT_INS.length; index += 1) {
    const entry = item(BUILT_INS, index)
    if (entry.owner[entry.name] !== entry.met) found += 1
  }
  return found
}

/** Whether the guard is on. It is off only for the specs that prove the reads beneath it, through {@link withoutRealmGuard}. */
let active = true

/**
 * The refusal: an `AiTokensException` built without running the constructor of `HttpException`, which assigns `response`, `status`, `options`,
 * `message` and `name` on the new instance and so reads and writes through the prototype chain a planted key lives on (a text planted as
 * `message` becomes the exception's text, an accessor under `response` swallows the body, a key that is read-only makes the constructor throw
 * and name it). The fields are defined as the instance's own, from references captured when the module loaded, and the body has no prototype.
 *
 * @param found The count of names the realm differs in.
 * @returns The exception, with the code `AI_TOKENS_INVALID_CONFIG` and no name or value of the realm.
 */
function refusal(found: number): AiTokensException {
  const code = 'AI_TOKENS_INVALID_CONFIG'
  const message = AI_TOKENS_ERROR_MESSAGES[code]
  const details = createObject(null) as Record<string, unknown>
  details.reason = `the Object.prototype and the built-ins of this process differ from the engine's in ${stringOf(found)} name(s); the library will not bill beside them`
  const fields = createObject(null) as { code: string; message: string; details: unknown }
  fields.code = code
  fields.message = message
  fields.details = details
  const body = createObject(null) as { error: unknown }
  body.error = fields
  const error = createObject(AiTokensException.prototype) as AiTokensException
  // A descriptor with no prototype, built by assignment: nothing the realm adds is read as part of it.
  const own = (value: unknown): PropertyDescriptor => {
    const made = createObject(null) as PropertyDescriptor
    made.value = value
    made.writable = true
    made.configurable = true
    made.enumerable = false
    return made
  }
  define(error, 'response', own(body))
  define(error, 'status', own(AI_TOKENS_ERROR_STATUS[code]))
  define(error, 'message', own(message))
  define(error, 'name', own('AiTokensException'))
  captureStack(error, refusal)
  return error
}

/**
 * Refuses, with the library's error and a count, while this realm's prototypes are not the engine's. Called at boot and before every
 * operation that moves or reports money.
 *
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` carrying the count of names, never a name or a value.
 */
export function assertCleanRealm(): void {
  if (!active) return
  const found = pollutedNames()
  if (found === 0) return
  throw refusal(found)
}

/**
 * Turns the guard on or off for a whole spec file, which plants keys on purpose to prove what the library reads beneath the guard. Internal:
 * it is not exported from any entry of the package, and a published-package check holds that.
 *
 * @param on Whether the guard is on.
 */
export function setRealmGuard(on: boolean): void {
  active = on
}

/**
 * Runs `run` with the guard off, for the specs that prove what the library reads beneath it. Internal: it is not exported from any entry of
 * the package, and a published-package check holds that.
 *
 * @param run The work to run, synchronous or not.
 * @returns What `run` returns.
 */
export function withoutRealmGuard<T>(run: () => T): T {
  const was = active
  active = false
  let result: T
  try {
    result = run()
  } catch (error) {
    active = was
    throw error
  }
  if (result instanceof Promise) return result.finally(() => void (active = was)) as T
  active = was
  return result
}
