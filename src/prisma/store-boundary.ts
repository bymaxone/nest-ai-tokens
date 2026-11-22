/**
 * @fileoverview The boundary of the PostgreSQL store: every public method of it either returns, throws a typed
 * {@link AiTokensException}, or throws one of the signals the store raises on purpose for the service layer. A driver error
 * is none of these, and its message, code and meta can name a host, a statement or a stored value, so it is rethrown as a
 * typed store error with the original on `cause`.
 * @layer prisma
 */

import { ownCopy } from '../server/utils/own-copy'
import { storeError } from './adapter-sql'

/** Whether a value is a promise or a thenable, which a method returns when it is asynchronous. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Wrap the methods of `store` so that what they throw crosses the boundary as a typed error. A method runs with the store
 * itself as its receiver, so a call between two of its own methods does not pass the boundary a second time. Each argument is copied
 * with {@link ownCopy} on the way in, so no method reads a key found only on `Object.prototype` as a name its input did not set.
 * A function installed on the store itself, as a test double a host puts in place of a method, is handed back as it is, with its
 * own members, and what it throws is its own; only the methods the class defines are wrapped.
 *
 * @param store The store to guard.
 * @param isSignal Whether a thrown value is one the store raises on purpose and the caller must receive unchanged.
 * @returns The guarded store, which is the store with every method wrapped.
 */
export function guardStoreErrors<T extends object>(store: T, isSignal: (error: unknown) => boolean): T {
  const cross = (error: unknown): never => {
    throw isSignal(error) ? error : storeError(error)
  }
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || property === 'constructor' || Object.hasOwn(target, property)) return value
      return (...args: unknown[]): unknown => {
        try {
          // A method reads the optional names of its inputs by name, so each input reaches it as a copy that holds only what the caller put in it.
          const result: unknown = (value as (...parameters: unknown[]) => unknown).apply(target, args.map((argument) => ownCopy(argument)))
          return isThenable(result) ? Promise.resolve(result).catch(cross) : result
        } catch (error) {
          return cross(error)
        }
      }
    },
  })
}
