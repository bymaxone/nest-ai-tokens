/**
 * @fileoverview The boundary between a service and the store it was given. Every argument a service hands the store, and every row the
 * store hands back, passes through {@link ownCopy}, so a service never reads a name a record lacks off the `Object.prototype` of its realm:
 * not on a row a store returned (a stored hold with no `extraUnits`, a record with no `reversesRecordId`, a budget with no `features`), and
 * not on an input a store re-copies and reads by name. It holds for any store, the library's own or the host's, since the copy is made here.
 * A method the store does not define is still not there: only the store's own and its class's methods are found, and a function planted on
 * `Object.prototype` under a method's name is not one.
 * @layer server
 */

import { types } from 'node:util'
import { AiTokensException } from '../errors'
import { fieldOf } from './field-names'
import { isPlain, ownCopy } from './own-copy'
import { assertCleanRealm } from './prototype-guard'

/** Every proxy this module made, so that a store handed to two services is guarded once. */
const GUARDED = new WeakSet()

/**
 * Whether a value is what an asynchronous store method returns: a promise, or an object that is no record and has a `then` of its own or its
 * class's (a query builder of a client). A row is a record, so a row with a `then` of its own is a row and is never awaited.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) return false
  return types.isPromise(value) || (!isPlain(value) && typeof fieldOf(value, 'then') === 'function')
}

/**
 * The copy of an argument or a row. A record nested deeper than a store takes, or a class chain longer than a class hierarchy, is refused with
 * the library's error and is never handed on uncopied.
 */
function copied<T>(value: T): T {
  try {
    return ownCopy(value)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    // Stryker disable next-line ObjectLiteral,StringLiteral: error context is internal diagnostics; tests check the error code only
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'a record a store takes or returns is nested too deep, or its class chain is too long' })
  }
}

/**
 * The store, with each method wrapped so that its arguments and what it resolves with are copies that hold only what they have.
 *
 * The proxy stands on an empty object of its own, not on the store, so that a store whose properties cannot be changed (a frozen object, a
 * property that is not configurable) can still be given a wrapper for a method: a proxy may not answer a property of its target with another
 * value when that property is neither writable nor configurable. Every other question about the store (its keys, its prototype, whether it has
 * a name) is put to the store itself, so a method it lacks is still absent.
 *
 * @param store The store a service was given.
 * @returns The guarded store, which answers every property as the store does.
 */
export function guardedStore<T extends object>(store: T): T {
  if (GUARDED.has(store)) return store
  const guarded = new Proxy({} as T, {
    get(_target, property) {
      if (typeof property !== 'string') return Reflect.get(store, property) as unknown
      const value = fieldOf(store, property)
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        // No call reaches a store beside a polluted realm, so nothing is written or reported there.
        assertCleanRealm()
        const result: unknown = Reflect.apply(value as (...parameters: unknown[]) => unknown, store, args.map((argument) => copied(argument)))
        return isThenable(result) ? Promise.resolve(result).then((resolved) => copied(resolved)) : copied(result)
      }
    },
    has: (_target, property) => Reflect.has(store, property),
    ownKeys: () => Reflect.ownKeys(store),
    getPrototypeOf: () => Reflect.getPrototypeOf(store),
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(store, property)
      // No prototype: the engine reads `get`, `set`, `value` and the flags of what a trap returns through its prototype chain.
      return descriptor === undefined ? undefined : Object.assign(Object.create(null) as PropertyDescriptor, descriptor, { configurable: true })
    },
  })
  GUARDED.add(guarded)
  return guarded
}
