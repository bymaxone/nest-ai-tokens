/**
 * @fileoverview The boundary between a service and the store it was given. Every argument a service hands the store, and every row the
 * store hands back, passes through {@link ownCopy}, so a service never reads a name a record lacks off the `Object.prototype` of its realm:
 * not on a row a store returned (a stored hold with no `extraUnits`, a record with no `reversesRecordId`, a budget with no `features`), and
 * not on an input a store re-copies and reads by name. It holds for any store, the library's own or the host's, since the copy is made here.
 * A method the store does not define is still not there: only the store's own and its class's methods are found, and a function planted on
 * `Object.prototype` under a method's name is not one.
 * @layer server
 */

import { fieldOf } from './field-names'
import { ownCopy } from './own-copy'

/** Every proxy this module made, so that a store handed to two services is guarded once. */
const GUARDED = new WeakSet()

/** Whether a value is a promise or a thenable, which a store method returns when it is asynchronous. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * The store, with each method wrapped so that its arguments and what it resolves with are copies that hold only what they have.
 *
 * @param store The store a service was given.
 * @returns The guarded store, which answers every property as the store does.
 */
export function guardedStore<T extends object>(store: T): T {
  if (GUARDED.has(store)) return store
  const guarded = new Proxy(store, {
    get(target, property) {
      if (typeof property !== 'string') return Reflect.get(target, property) as unknown
      const value = fieldOf(target, property)
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        const result: unknown = (value as (...parameters: unknown[]) => unknown).apply(target, args.map((argument) => ownCopy(argument)))
        return isThenable(result) ? Promise.resolve(result).then((resolved) => ownCopy(resolved)) : ownCopy(result)
      }
    },
  })
  GUARDED.add(guarded)
  return guarded
}
