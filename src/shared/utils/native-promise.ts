/**
 * @fileoverview The check that runs between a host call and the native `await` of what it returned. An `await` of a native promise reads
 * its `constructor`, and when that is not `Promise` it wraps the promise and calls its `then`; a host that plants a one-shot `constructor`
 * getter and `then` on `Promise.prototype` while its call runs, and restores them when they are read, answers for the store with no trace
 * left for a later check of the realm. This check runs synchronously after the host call returns and before the `await`, so nothing of the
 * host runs between the two. It calls only functions it captured when the module loaded, and writes to no promise; what it reads live is the value, the prototypes on its chain and `Promise` itself, always as own descriptors, so no getter of the host runs before it decides. A value whose prototype is not
 * `Promise.prototype` (a query builder, a subclass of `Promise`) is a thenable the host owns: its own answer is what the host gives, and
 * no shared intrinsic decides it.
 * @layer shared
 */

const PROMISE_PROTOTYPE = Promise.prototype
const INTRINSIC_PROMISE = Promise
const getPrototypeOf = Object.getPrototypeOf
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const hasOwn = Object.hasOwn
const defineProperty = Object.defineProperty
const speciesAtLoad = getOwnPropertyDescriptor(INTRINSIC_PROMISE, Symbol.species)
// The module loads before any host code, so the descriptor exists and its own getter is the one read.
const INTRINSIC_SPECIES: unknown = (speciesAtLoad as { get?: unknown }).get
const ARRAY_PROTOTYPE = Array.prototype
const OBJECT_PROTOTYPE = Object.prototype
const ARRAY_ITERATOR_PROTOTYPE = getPrototypeOf([][Symbol.iterator]()) as object
/** What a decision path reads off an array after a host call, by the key it is read with; each is compared with what the module captured. */
interface ArrayRead {
  holder: object
  key: string | symbol
  value: unknown
}
const ARRAY_READS: readonly [ArrayRead, ArrayRead, ArrayRead, ArrayRead, ArrayRead] = [
  { holder: ARRAY_PROTOTYPE, key: 'map', value: ARRAY_PROTOTYPE.map },
  { holder: ARRAY_PROTOTYPE, key: 'filter', value: ARRAY_PROTOTYPE.filter },
  { holder: ARRAY_PROTOTYPE, key: 'push', value: ARRAY_PROTOTYPE.push },
  { holder: ARRAY_PROTOTYPE, key: Symbol.iterator, value: ARRAY_PROTOTYPE[Symbol.iterator] },
  { holder: ARRAY_ITERATOR_PROTOTYPE, key: 'next', value: (ARRAY_ITERATOR_PROTOTYPE as { next: unknown }).next },
]
/** Tells a Proxy from any other value; the shared layer imports no Node built-in, so each layer passes `types.isProxy`. */
export type ProxyProbe = (value: unknown) => boolean
const noProxy: ProxyProbe = () => false
/** The greatest number of prototypes walked for a `then`; a chain longer than any class hierarchy is refused. */
const MAX_CHAIN = 64

/**
 * Whether the arrays and plain objects a decision path reads still answer as they did when the module loaded: the array methods and the
 * iterator the paths use are the engine's, and neither `Array.prototype` nor `Object.prototype` holds a `then`. A host call that plants a
 * one-shot replacement for one of them answers for the store when the library reads it, and leaves nothing behind for a check that runs
 * after the read, so the check runs right after the call returns, before the library reads anything from what came back.
 *
 * @returns `false` when one of them is not what was captured.
 */
export function arrayIntrinsicsIntact(): boolean {
  if (hasOwn(ARRAY_PROTOTYPE, 'then') || hasOwn(OBJECT_PROTOTYPE, 'then')) return false
  // Reads only what the module captured and the own entries of its private tuple: no global, no member of `Array.prototype`, so replacing one leaves the check as it was.
  return unchanged(ARRAY_READS[0]) && unchanged(ARRAY_READS[1]) && unchanged(ARRAY_READS[2]) && unchanged(ARRAY_READS[3]) && unchanged(ARRAY_READS[4])
}

/** Whether `read.holder[read.key]` is still the data property captured at load. */
function unchanged(read: ArrayRead): boolean {
  const descriptor = getOwnPropertyDescriptor(read.holder, read.key)
  return descriptor !== undefined && hasOwn(descriptor, 'value') && descriptor.value === read.value
}

/**
 * Whether `value`, or any prototype of it, has a `then` that is a function or an accessor: the resolution of a promise, or an `await`, with such a value reads it
 * and calls it. Only own descriptors are read, so no getter of the host runs.
 *
 * @param value What a host call returned.
 * @param isProxy Tells a Proxy, whose traps run host code on every read, from an object; one on the chain is refused, since the descriptor it reports is its own.
 * @returns `true` when a `then` is found, the chain is longer than {@link MAX_CHAIN}, or a Proxy is on it.
 */
export function chainHasThen(value: unknown, isProxy: ProxyProbe = noProxy): boolean {
  // A null falls through: it is no holder, so the walk below ends before it reads anything.
  if (typeof value !== 'object' && typeof value !== 'function') return false
  let holder: object | null = value
  for (let depth = 0; holder !== null; depth += 1) {
    if (depth > MAX_CHAIN || isProxy(holder)) return true
    const own = getOwnPropertyDescriptor(holder, 'then')
    // A data `then` that is no function is read as a plain field; an accessor, or a function, is run or read by a resolution.
    if (own !== undefined && (!hasOwn(own, 'value') || typeof own.value === 'function')) return true
    holder = getPrototypeOf(holder) as object | null
  }
  return false
}

/**
 * Appends to a list with no method of `Array.prototype`: a `push` planted for one call would otherwise drop the element.
 *
 * @param list The list to grow.
 * @param element What to append.
 */
export function appendTo<T>(list: T[], element: T): void {
  const descriptor = { __proto__: null, value: element, writable: true, enumerable: true, configurable: true }
  defineProperty(list, list.length, descriptor)
}

/**
 * A list of what `transform` made of each element, built with no method of `Array.prototype`.
 *
 * @param list The elements.
 * @param transform Applied to each element and its index.
 * @returns A new list.
 */
export function mapList<T, U>(list: readonly T[], transform: (element: T, index: number) => U): U[] {
  const mapped: U[] = []
  for (let index = 0; index < list.length; index += 1) appendTo(mapped, transform(list[index] as T, index))
  return mapped
}

/**
 * The elements of a list for which `keep` answers `true`, selected with no method of `Array.prototype`.
 *
 * @param list The elements.
 * @param keep The test.
 * @returns A new list.
 */
export function filterList<T>(list: readonly T[], keep: (element: T) => boolean): T[] {
  const kept: T[] = []
  let index = 0
  while (index < list.length) {
    const element = list[index] as T
    if (keep(element)) appendTo(kept, element)
    index += 1
  }
  return kept
}

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
  return species !== undefined && hasOwn(species, 'get') && species.get === INTRINSIC_SPECIES
}

/**
 * Whether the caller must refuse `value` instead of awaiting or reading it. It refuses when the arrays or objects the library reads are not
 * what it captured ({@link arrayIntrinsicsIntact}), when `value` is a native promise with a `constructor` or `then` of its own or a
 * `Promise.prototype` that is not intact, and, unless `thenables` allows it, when `value` is anything else with a `then` on its chain (a
 * subclass of `Promise`, a class thenable): an `await` of it runs a `then` that is code of the host. Only a value
 * with no `then` at all, or an exact native promise, passes. A refused promise is handed to a throwaway wait that swallows its outcome: it
 * would otherwise reject with no handler, which ends a Node process, and the wait reads whatever the host planted, which decides nothing
 * since the caller has refused. A Proxy, or a value with one on its chain, is refused and not waited for: the wait would run its traps.
 *
 * @param value What a host call returned.
 * @param thenables `true` for a driver, whose lazy query builders are thenables of their own; they are run by the caller, not refused here.
 * @param isProxy Tells a Proxy from an object; a Proxy, or one on the prototype chain, is refused before any property of it is read.
 * @returns `true` when the caller must refuse it.
 */
export function refusesPromise(value: unknown, thenables = false, isProxy: ProxyProbe = noProxy): boolean {
  if (!refused(value, thenables, isProxy)) return false
  if (proxyOnChain(value, isProxy)) return true
  swallow(value)
  return true
}

/**
 * Marks the rejection of a promise as handled, for a caller that refuses to wait for it: a promise the host created and the library does not
 * read would otherwise end a Node process as an unhandled rejection. A native promise is waited for by a native `await` that discards its
 * outcome: that `await` builds no derived promise, so it reads no `Promise[Symbol.species]`, and it looks up no `then`. Any other value is
 * treated as {@link refusesPromise} treats it, and a thenable that call lets through is left alone.
 *
 * @param value What a host call returned.
 * @param thenables As in {@link refusesPromise}.
 * @param isProxy Tells a Proxy from an object.
 */
export function absorbRejection(value: unknown, thenables = false, isProxy: ProxyProbe = noProxy): void {
  if (!isNativePromise(value, isProxy)) {
    refusesPromise(value, thenables, isProxy)
    return
  }
  swallow(value)
}

/** Waits for `value` and discards how it settles, so that a rejection of it is handled. Nothing it settles with is read. */
function swallow(value: unknown): void {
  void (async (): Promise<void> => {
    try {
      await value
    } catch {
      // The caller refused this value; whatever it settles with is not read.
    }
  })()
}

/** Whether `value` is an object whose prototype is the engine's `Promise.prototype` and that is no Proxy, read without running a getter. */
function isNativePromise(value: unknown, isProxy: ProxyProbe): boolean {
  if (typeof value !== 'object' || value === null || isProxy(value)) return false
  return getPrototypeOf(value) === PROMISE_PROTOTYPE
}

/** Whether `value` or a prototype of it is a Proxy: a wait on it would run its traps, so a refused one is not waited for. */
function proxyOnChain(value: unknown, isProxy: ProxyProbe): boolean {
  let holder: unknown = value
  for (let depth = 0; (typeof holder === 'object' || typeof holder === 'function') && holder !== null; depth += 1) {
    if (depth > MAX_CHAIN || isProxy(holder)) return true
    holder = getPrototypeOf(holder)
  }
  return false
}

/** The decision of {@link refusesPromise}, without the throwaway wait. */
function refused(value: unknown, thenables: boolean, isProxy: ProxyProbe): boolean {
  if (!arrayIntrinsicsIntact()) return true
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  if (isProxy(value)) return true
  if (getPrototypeOf(value) === PROMISE_PROTOTYPE) return hasOwn(value, 'then') || hasOwn(value, 'constructor') || !promiseIntrinsicsIntact()
  return !thenables && chainHasThen(value, isProxy)
}
