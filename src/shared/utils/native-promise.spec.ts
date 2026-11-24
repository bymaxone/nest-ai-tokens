/**
 * @fileoverview The check that runs between a host call and the native `await` of what it returned: a promise of this realm whose
 * `constructor` or `then` a host controls is refused, anything else goes on, and a refused promise is waited for once so that a rejection of it is handled.
 * @layer shared
 */

import {
  appendTo,
  arrayIntrinsicsIntact,
  chainHasThen,
  filterList,
  mapList,
  promiseIntrinsicsIntact,
  promiseSpeciesIntact,
  refusesPromise,
} from './native-promise'

describe('a promise a native await runs alone', () => {
  const constructorKept = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor')!
  const speciesKept = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!
  const thenKept = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')!
  afterEach(() => {
    Reflect.defineProperty(Promise.prototype, 'constructor', constructorKept)
    Reflect.defineProperty(Promise.prototype, 'then', thenKept)
    Reflect.defineProperty(Promise, Symbol.species, speciesKept)
  })

  it.each([[1], ['a'], [undefined], [null]])('lets %p go on, which no await reads a constructor of', (value) => {
    expect(refusesPromise(value)).toBe(false)
  })

  /**
   * Flipped from "lets a thenable go on": a thenable that is no exact native promise (a subclass, a class with a `then`) is refused, since
   * its `then` is code of the host that calls the live `Promise.prototype.then`; only a driver's own lazy query builders are let through, by `thenables`.
   */
  it('refuses a thenable and a subclass of Promise, and lets a driver thenable through when asked', () => {
    class Sub extends Promise<number> {}
    class Builder {
      then(): void {}
    }
    expect(refusesPromise({ then: () => undefined })).toBe(true)
    expect(refusesPromise(Sub.resolve(1))).toBe(true)
    expect(refusesPromise(new Builder())).toBe(true)
    expect(refusesPromise(new Builder(), true)).toBe(false)
    expect(refusesPromise({ then: 1 })).toBe(false)
    expect(refusesPromise(Object.setPrototypeOf(Promise.resolve(1), null))).toBe(false)
  })

  it('lets an untouched promise go on', () => {
    expect(refusesPromise(Promise.resolve(1))).toBe(false)
    expect(promiseIntrinsicsIntact()).toBe(true)
    expect(promiseSpeciesIntact()).toBe(true)
  })

  it.each([['then'], ['constructor']])('refuses a promise with an own %s', (name) => {
    const promise = Promise.resolve(1)
    Reflect.defineProperty(promise, name, { value: Promise, configurable: true })
    expect(refusesPromise(promise)).toBe(true)
  })

  it('refuses while Promise.prototype.constructor is an accessor, a value that is not Promise, or gone', () => {
    Reflect.defineProperty(Promise.prototype, 'constructor', { get: () => Promise, configurable: true })
    expect(refusesPromise(Promise.resolve(1))).toBe(true)
    Reflect.defineProperty(Promise.prototype, 'constructor', { value: Object, configurable: true, writable: true })
    expect(promiseIntrinsicsIntact()).toBe(false)
    Reflect.deleteProperty(Promise.prototype, 'constructor')
    expect(promiseIntrinsicsIntact()).toBe(false)
  })

  it('refuses while Promise[Symbol.species] is a getter that is not the engine\u2019s or is gone', () => {
    Reflect.defineProperty(Promise, Symbol.species, { get: () => Object, configurable: true })
    const wrong = promiseSpeciesIntact()
    Reflect.defineProperty(Promise, Symbol.species, speciesKept)
    expect(wrong).toBe(false)
    Reflect.defineProperty(Promise, Symbol.species, { value: Promise, configurable: true })
    expect(promiseSpeciesIntact()).toBe(false)
    Reflect.deleteProperty(Promise, Symbol.species)
    expect(promiseSpeciesIntact()).toBe(false)
  })

  it('refuses while Promise.prototype.then is an accessor, no function, or gone, and not when it is a wrapper', () => {
    Reflect.defineProperty(Promise.prototype, 'then', { get: () => thenKept.value as unknown, configurable: true })
    expect(promiseIntrinsicsIntact()).toBe(false)
    Reflect.defineProperty(Promise.prototype, 'then', { value: 1, configurable: true, writable: true })
    expect(promiseIntrinsicsIntact()).toBe(false)
    Reflect.deleteProperty(Promise.prototype, 'then')
    expect(promiseIntrinsicsIntact()).toBe(false)
    const original = thenKept.value as (...args: unknown[]) => unknown
    Reflect.defineProperty(Promise.prototype, 'then', { ...thenKept, value: function wrapped(this: unknown, ...args: unknown[]) { return original.apply(this, args) } })
    expect(promiseIntrinsicsIntact()).toBe(true)
  })

  it('answers whether to refuse, and handles the rejection of a promise it refuses', async () => {
    const handled = jest.fn()
    process.once('unhandledRejection', handled)
    const rejected = Promise.reject(new Error('refused'))
    rejected.catch(() => undefined)
    Reflect.defineProperty(rejected, 'then', { value: Promise.prototype.then, configurable: true })
    expect(refusesPromise(rejected)).toBe(true)
    expect(refusesPromise(Promise.resolve(1))).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 5))
    process.removeListener('unhandledRejection', handled)
    expect(handled).not.toHaveBeenCalled()
  })

  /** The species getter is read as an own property of the intrinsic only: a descriptor with no `get` of its own is not the engine's. */
  it('refuses a species descriptor that inherits its getter', () => {
    const inherited = Object.create({ get: speciesKept.get }) as PropertyDescriptor
    Object.defineProperty(inherited, 'configurable', { value: true })
    expect(Object.hasOwn(inherited, 'get')).toBe(false)
    Reflect.defineProperty(Promise, Symbol.species, { value: Promise, configurable: true })
    expect(promiseSpeciesIntact()).toBe(false)
  })
})

describe('the arrays and objects a decision path reads', () => {
  const kept = {
    map: Object.getOwnPropertyDescriptor(Array.prototype, 'map')!,
    push: Object.getOwnPropertyDescriptor(Array.prototype, 'push')!,
    iterator: Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!,
  }
  afterEach(() => {
    Reflect.defineProperty(Array.prototype, 'map', kept.map)
    Reflect.defineProperty(Array.prototype, 'push', kept.push)
    Reflect.defineProperty(Array.prototype, Symbol.iterator, kept.iterator)
    Reflect.deleteProperty(Array.prototype, 'then')
    Reflect.deleteProperty(Object.prototype, 'then')
  })

  /** Runs `read` while `holder[key]` is replaced and restores it before the test's own assertions run, which use the arrays themselves. */
  function whileReplaced<T>(holder: object, key: string | symbol, replacement: PropertyDescriptor, read: () => T): T {
    const original = Object.getOwnPropertyDescriptor(holder, key)
    Reflect.defineProperty(holder, key, replacement)
    try {
      return read()
    } finally {
      if (original === undefined) Reflect.deleteProperty(holder, key)
      else Reflect.defineProperty(holder, key, original)
    }
  }

  it('is intact on a healthy realm, and refuses a replaced method, a replaced iterator or a then on either prototype', () => {
    const answers = [
      arrayIntrinsicsIntact(),
      whileReplaced(Array.prototype, 'map', { ...kept.map, value: () => [] }, arrayIntrinsicsIntact),
      whileReplaced(Array.prototype, 'push', { ...kept.push, value: () => 0 }, arrayIntrinsicsIntact),
      whileReplaced(Array.prototype, Symbol.iterator, { ...kept.iterator, value: () => ({ next: () => ({ done: true }) }) }, arrayIntrinsicsIntact),
      whileReplaced(Array.prototype, 'then', { value: () => undefined, configurable: true }, arrayIntrinsicsIntact),
      whileReplaced(Object.prototype, 'then', { value: () => undefined, configurable: true }, arrayIntrinsicsIntact),
      arrayIntrinsicsIntact(),
    ]
    expect(answers).toEqual([true, false, false, false, false, false, true])
  })

  it('refuses any value while an array method is replaced', () => {
    const refused = whileReplaced(Array.prototype, 'map', { ...kept.map, value: () => [] }, () => refusesPromise(1))
    expect(refused).toBe(true)
  })

  it('finds a then that is a function or an accessor on the value or its chain, and not a plain field', () => {
    const accessor = Object.defineProperty({}, 'then', { get: () => undefined })
    let chain: object = {}
    for (let depth = 0; depth < 70; depth += 1) chain = Object.create(chain) as object
    expect([
      chainHasThen(accessor),
      chainHasThen(Object.create({ then: () => undefined })),
      chainHasThen({ then: 1 }),
      chainHasThen(1),
      chainHasThen(null),
      chainHasThen(() => undefined),
      chainHasThen(chain),
    ]).toEqual([true, true, false, false, false, false, true])
  })

  it('appends, maps and filters with no method of Array.prototype', () => {
    const list: number[] = []
    const results = whileReplaced(Array.prototype, 'push', { ...kept.push, value: () => 0 }, () =>
      whileReplaced(Array.prototype, 'map', { ...kept.map, value: () => [] }, () => {
        appendTo(list, 1)
        return [mapList([1, 2, 3], (n, index) => n * 2 + index), filterList([1, 2, 3, 4], (n) => n % 2 === 0)]
      }),
    )
    expect(list).toEqual([1])
    expect(results).toEqual([[2, 5, 8], [2, 4]])
  })
})
