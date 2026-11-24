/**
 * @fileoverview The check that runs between a host call and the native `await` of what it returned: a promise of this realm whose
 * `constructor` or `then` a host controls is refused, anything else goes on, and a refused promise is waited for once so that a rejection of it is handled.
 * @layer shared
 */

import { types } from 'node:util'
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
   * A value that is no exact native promise is refused. An `await` of a class with a `then` runs that `then`, which is code of the host; an
   * `await` of a subclass of Promise calls the inherited `then`, which builds its result through the species a host can plant. A caller that
   * passes `thenables` lets a thenable through.
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

  it('answers whether to refuse a native promise that has a then of its own', async () => {
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

  /** A `Promise[Symbol.species]` that holds a plain value instead of the engine's getter is not the engine's. */
  it('refuses a species property that is a plain value, not the engine getter', () => {
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

  /** `every` is replaced together with `map`: a check that read `every` live would be told the list is fine. */
  it('refuses a replaced method even when Array.prototype.every answers true', () => {
    const every = Object.getOwnPropertyDescriptor(Array.prototype, 'every')!
    const intact = whileReplaced(Array.prototype, 'every', { ...every, value: () => true }, () =>
      whileReplaced(Array.prototype, 'map', { ...kept.map, value: () => [] }, arrayIntrinsicsIntact),
    )
    expect(intact).toBe(false)
  })

  /** The check reads no live global either: a `Reflect.get` replaced with the map answers an index with a read that is unchanged. */
  it('refuses a replaced method even when Reflect.get answers an unchanged read', () => {
    const unchanged = { holder: Object.prototype, key: 'hasOwnProperty', value: Object.prototype.hasOwnProperty }
    const answer = (_target: object, key: PropertyKey): unknown => (typeof key === 'number' ? unchanged : undefined)
    const intact = whileReplaced(Array.prototype, 'map', { ...kept.map, value: () => [] }, () =>
      whileReplaced(Reflect, 'get', { value: answer, configurable: true, writable: true }, arrayIntrinsicsIntact),
    )
    expect(intact).toBe(false)
  })

  /** The check runs on what the module captured: `Object.getOwnPropertyDescriptor` and `Object.hasOwn` replaced after load do not answer for it. */
  it('refuses a replaced method even when Object.getOwnPropertyDescriptor and Object.hasOwn are replaced to answer intact', () => {
    const unchanged = (_holder: object, key: PropertyKey): unknown => ({ value: key === 'map' ? (kept.map.value as unknown) : undefined })
    const intact = whileReplaced(Array.prototype, 'map', { ...kept.map, value: () => [] }, () =>
      whileReplaced(Object, 'getOwnPropertyDescriptor', { value: unchanged, configurable: true, writable: true }, () =>
        whileReplaced(Object, 'hasOwn', { value: () => true, configurable: true, writable: true }, arrayIntrinsicsIntact),
      ),
    )
    expect(intact).toBe(false)
  })

  /** A Proxy answers `getOwnPropertyDescriptor` and `get` with the host's code: it is refused before either is asked. */
  it('refuses a Proxy, or one on the prototype chain, without running a trap', () => {
    const asked: string[] = []
    const trap = (name: string) => (): undefined => {
      asked.push(name)
      return undefined
    }
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: trap('descriptor'),
      get: trap('get'),
      getPrototypeOf: trap('prototype') as unknown as () => null,
      has: trap('has') as unknown as () => boolean,
    })
    const answers = [
      refusesPromise(proxy, false, types.isProxy),
      refusesPromise(proxy, true, types.isProxy),
      refusesPromise(Object.create(proxy), false, types.isProxy),
      chainHasThen(proxy, types.isProxy),
      refusesPromise({}, false, types.isProxy),
    ]
    expect(answers).toEqual([true, true, true, true, false])
    expect(asked).toEqual([])
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
