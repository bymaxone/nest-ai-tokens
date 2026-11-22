/**
 * @fileoverview Refuses to bill beside a realm that something polluted. Whatever sits on the `Object.prototype` of this realm is inherited by
 * every plain object a library reads a name from, and no shadow of ours can cover all of it, so a process that carries a name the engine does
 * not define is not one that money can be trusted to. The guard counts how far that prototype is from the one a fresh realm has, and how many
 * of the built-ins the library relies on are no longer the ones it met when it loaded, and refuses to operate while the count is not zero.
 * It fails closed and reports the count only, never a name or a value. It is checked at boot and before every operation that moves or reports
 * money; the structural reads of the library beneath it stay, for a plant made between the check and the read.
 * @layer server
 */

import { runInNewContext } from 'node:vm'
import { AiTokensException } from '../errors'

/** What a fresh realm holds: the descriptors of its `Object.prototype` and a reader of function text. */
interface Pristine {
  readonly descriptors: Readonly<Record<string | symbol, PropertyDescriptor>>
  readonly sourceOf: (value: unknown) => string
}

/** What the prototype held when this module loaded, so a name swapped for another native function is caught by identity. */
const loaded = Object.getOwnPropertyDescriptors(Object.prototype) as Record<string | symbol, PropertyDescriptor>

/** The built-ins the library calls, by owner and name: each is compared with the function this module met when it loaded. */
const BUILT_INS: readonly (readonly [object, string])[] = [
  [Object, 'hasOwn'], [Object, 'getPrototypeOf'], [Object, 'keys'], [Object, 'getOwnPropertyNames'], [Object, 'create'], [Object, 'entries'],
  [Object, 'defineProperty'], [Object, 'getOwnPropertyDescriptor'], [Object, 'getOwnPropertyDescriptors'], [Object, 'assign'], [Object, 'fromEntries'], [Object, 'freeze'],
  [Reflect, 'get'], [Reflect, 'ownKeys'], [Reflect, 'apply'], [Reflect, 'has'], [Array, 'isArray'], [Array, 'from'],
  [Number, 'isSafeInteger'], [Number, 'isInteger'], [Number, 'isFinite'], [JSON, 'stringify'], [Object.prototype, 'hasOwnProperty'],
  [Array.prototype, 'map'], [Array.prototype, 'filter'], [Array.prototype, 'includes'], [Array.prototype, 'find'], [Array.prototype, 'some'],
  [Array.prototype, 'every'], [Array.prototype, 'sort'], [Array.prototype, 'slice'], [Array.prototype, 'join'], [Array.prototype, 'push'],
  [String.prototype, 'startsWith'], [String.prototype, 'includes'], [Date.prototype, 'getTime'], [Date, 'now'], [Math, 'floor'],
  [ArrayBuffer, 'isView'], [Set.prototype, 'has'], [Map.prototype, 'get'], [WeakMap.prototype, 'get'], [Promise, 'resolve'], [Function.prototype, 'call'],
  [Function.prototype, 'apply'], [Function.prototype, 'bind'],
]

/** The built-ins as this module met them. */
const metBuiltIns: readonly unknown[] = BUILT_INS.map(([owner, name]) => Reflect.get(owner, name) as unknown)

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

/** The flags of a descriptor that make a name easier to change. */
const FLAGS = ['writable', 'configurable'] as const

/** The fields of a descriptor that hold what the name is. */
const CONTENT = ['value', 'get', 'set'] as const

/**
 * A field of a descriptor, as its own property only: a descriptor of this realm inherits from the prototype under test, so a name planted
 * there, an accessor called `get` say, must never run.
 *
 * @param descriptor A descriptor, or `undefined`.
 * @param key The field.
 * @returns The own field, or `undefined`.
 */
function field(descriptor: PropertyDescriptor | undefined, key: keyof PropertyDescriptor): unknown {
  return descriptor !== undefined && Object.hasOwn(descriptor, key) ? (Reflect.get(descriptor, key) as unknown) : undefined
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
 * Counts the names of this realm's `Object.prototype` that a fresh realm's does not hold, that it lacks, or that it holds changed (its flags,
 * or a function whose text is not the engine's, or is not the one this module met), and the built-ins that are no longer the ones it met.
 *
 * @returns Zero for a clean realm.
 */
export function pollutedNames(): number {
  pristine ??= build()
  if (pristine === undefined) return 1
  const { descriptors, sourceOf } = pristine
  const now = Object.getOwnPropertyDescriptors(Object.prototype) as Record<string | symbol, PropertyDescriptor>
  // A symbol counts when it is enumerable, as an assignment through a polluted path plants it; a symbol made with defineProperty and hidden
  // needs code that already runs in the process.
  const names = new Set([...Reflect.ownKeys(now).filter((name) => typeof name === 'string' || field(now[name], 'enumerable') === true), ...Reflect.ownKeys(descriptors)])
  let found = 0
  for (const name of names) {
    // An absent descriptor reads every field as undefined, so a deleted name and a planted one differ at once.
    const have = Object.hasOwn(now, name) ? now[name] : undefined
    const want = Object.hasOwn(descriptors, name) ? descriptors[name] : undefined
    const same =
      field(have, 'enumerable') === field(want, 'enumerable') &&
      // A flag tighter than the engine's, a frozen realm, is safe; a looser one is not.
      FLAGS.every((flag) => field(have, flag) !== true || field(want, flag) === true) &&
      CONTENT.every((key) => alike(field(have, key), field(want, key), sourceOf) && (!Object.hasOwn(loaded, name) || field(have, key) === field(loaded[name], key)))
    if (!same) found += 1
  }
  for (const [index, [owner, name]] of BUILT_INS.entries()) if (Reflect.get(owner, name) !== metBuiltIns[index]) found += 1
  return found
}

/** Whether the guard is on. It is off only for the specs that prove the reads beneath it, through {@link withoutRealmGuard}. */
let active = true

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
  // Stryker disable next-line ObjectLiteral,StringLiteral: the wording is diagnostics; the row asserts the code and that no name is in it
  throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: `the Object.prototype and the built-ins of this process differ from the engine's in ${String(found)} name(s); the library will not bill beside them` })
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
