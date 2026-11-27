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
import { refusesPromise } from '../../shared/utils/native-promise'

/** Every proxy this module made, so that a store handed to two services is guarded once. */
const GUARDED = new WeakSet()

/**
 * Whether a value is what an asynchronous store method returns: a promise, or an object that is no record and has a `then` of its own or its
 * class's (a query builder of a client). A row is a record and is never awaited here; one whose `then` is a function is refused by {@link accepted}.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) return false
  if (types.isPromise(value)) return true
  if (!isPlain(value)) return typeof fieldOf(value, 'then') === 'function'
  // A plain object is a thenable only by a data `then` of its own, found without a read: a getter or a Proxy trap would run before {@link accepted}
  // refuses the row, and one that changes the row and answers nothing would get it through. One on `Object.prototype` is the realm's, checked there.
  if (types.isProxy(value)) return false
  const own = Object.getOwnPropertyDescriptor(value, 'then')
  return own !== undefined && Object.hasOwn(own, 'value') && typeof own.value === 'function'
}

/**
 * What a store returned, once it is certain that reading or awaiting it runs no code the host planted for that one read: a native promise whose
 * `constructor` or `then` was planted, a Proxy, and arrays whose methods were replaced are refused, since the answer they would give is the
 * host's; so is a row with a `then` on its chain. A promise (`pending`) may be a subclass of `Promise` or a thenable, whose `then` is the store's own.
 */
function accepted(result: unknown, pending: boolean): void {
  if (refusesPromise(result, pending, types.isProxy)) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'what a store returned reads a constructor or then of its own, or the arrays the library reads were replaced' })
}

/** The copy of what a store resolved with, checked once more right before the value is resolved into the promise the caller awaits. */
function returned(value: unknown): unknown {
  const copy = copied(value)
  accepted(copy, false)
  return copy
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
        if (isThenable(result)) {
          // The check runs in the body of the async function, before its first await: a refusal is a rejection, as for any failed call.
          return (async (): Promise<unknown> => {
            accepted(result, true)
            return returned(await result)
          })()
        }
        accepted(result, false)
        return returned(result)
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
