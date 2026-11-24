/**
 * @fileoverview The check that runs between a host call and the native `await` of what it returned. An `await` of a native promise reads
 * its `constructor`, and when that is not `Promise` it wraps the promise and calls its `then`; a host that plants a one-shot `constructor`
 * getter and `then` on `Promise.prototype` while its call runs, and restores them when they are read, answers for the store with no trace
 * left for a later check of the realm. This check runs synchronously after the host call returns and before the `await`, so nothing of the
 * host runs between the two. It reads only what it captured when the module loaded and writes to no promise. A value whose prototype is not
 * `Promise.prototype` (a query builder, a subclass of `Promise`) is a thenable the host owns: its own answer is what the host gives, and
 * no shared intrinsic decides it.
 * @layer shared
 */

const PROMISE_PROTOTYPE = Promise.prototype
const INTRINSIC_PROMISE = Promise
const INTRINSIC_SPECIES: unknown = (Object.getOwnPropertyDescriptor(INTRINSIC_PROMISE, Symbol.species) as { get?: unknown } | undefined)?.get
const getPrototypeOf = Object.getPrototypeOf
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const hasOwn = Object.hasOwn

/**
 * Whether `Promise.prototype` still holds the engine's `constructor` as a data property, and `then` as a data property that is a function.
 * `then` is not compared with the engine's: tracing agents wrap it after load on healthy hosts, and a wrapped `then` is a data property
 * all the same, while an accessor, which is what answers once and restores itself, is not.
 *
 * @returns `false` when `constructor` is not the engine's, or when either property is an accessor or `then` is no function.
 */
export function promiseIntrinsicsIntact(): boolean {
  const made = getOwnPropertyDescriptor(PROMISE_PROTOTYPE, 'constructor')
  const then = getOwnPropertyDescriptor(PROMISE_PROTOTYPE, 'then')
  return made !== undefined && hasOwn(made, 'value') && made.value === INTRINSIC_PROMISE && then !== undefined && hasOwn(then, 'value') && typeof then.value === 'function'
}

/**
 * Whether `Promise[Symbol.species]` is still the engine's getter. A `then` that a driver calls on its own promise reads it to choose the
 * constructor of the promise it returns, so a getter of the host's decides which promise the driver hands the store.
 *
 * @returns `false` when the property is gone, a plain value, or an accessor whose getter is not the engine's.
 */
export function promiseSpeciesIntact(): boolean {
  const species = getOwnPropertyDescriptor(INTRINSIC_PROMISE, Symbol.species)
  return species !== undefined && species.get === INTRINSIC_SPECIES
}

/**
 * Whether a native `await` of `value` runs no code of the host: it is not a promise of this realm, or it is one whose `constructor` and
 * `then` are the engine's, with no own `constructor` or `then` of its own that differs.
 *
 * @param value What a host call returned.
 * @returns `false` when the `await` would read a `constructor` or call a `then` the host controls on a shared promise.
 */
export function isPristinePromise(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true
  if (getPrototypeOf(value) !== PROMISE_PROTOTYPE) return true
  if (hasOwn(value, 'then') || hasOwn(value, 'constructor')) return false
  return promiseIntrinsicsIntact()
}

/**
 * Whether the caller must refuse `value` instead of awaiting it, and when it must, hands the promise to a throwaway wait that swallows its
 * outcome. A refused promise that rejects would otherwise reject with no handler, and an unhandled rejection ends a Node process; the
 * throwaway wait reads whatever the host planted, which decides nothing, since the caller has already refused.
 *
 * @param value What a host call returned.
 * @returns `true` when the caller must refuse it.
 */
export function refusesPromise(value: unknown): boolean {
  if (isPristinePromise(value)) return false
  void (async (): Promise<void> => {
    try {
      await value
    } catch {
      // The caller refused this promise; whatever it settles with is not read.
    }
  })()
  return true
}
