/**
 * @fileoverview The check that runs between a host call and the native `await` of what it returned: a promise of this realm whose
 * `constructor` or `then` a host controls is refused, anything else goes on, and a refused promise is waited for once so that a rejection of it is handled.
 * @layer shared
 */

import { types } from 'node:util'
import {
  absorbRejection,
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
    // A trap records that it ran and throws, so its type is `never` and fits every trap signature without an assertion.
    const trap = (name: string) => (): never => {
      asked.push(name)
      throw new Error(`the ${name} trap ran`)
    }
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: trap('descriptor'),
      get: trap('get'),
      getPrototypeOf: trap('prototype'),
      has: trap('has'),
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

  /** A caller that lets thenables through still never lets a Proxy on the chain through: its `then` is a trap of the host. */
  it('refuses a value with a Proxy on its chain when thenables are allowed, and lets a thenable of a class through', () => {
    class Builder {
      then(): void {}
    }
    const proxy = new Proxy({}, {})
    expect([refusesPromise(Object.create(proxy), true, types.isProxy), refusesPromise(new Builder(), true, types.isProxy), refusesPromise(Object.create(proxy), true)]).toEqual([true, false, false])
  })

  /**
   * Every check the default mode makes, run in both modes. The one the thenables mode skips is the `then` on the chain of a value that is no
   * native promise; every other check holds in both.
   */
  const CHECKS: readonly (readonly [string, (thenables: boolean) => boolean, boolean, boolean])[] = [
    ['a plain object', (thenables) => refusesPromise({ id: 1 }, thenables, types.isProxy), false, false],
    ['a native promise', (thenables) => refusesPromise(Promise.resolve(1), thenables, types.isProxy), false, false],
    ['a native promise with a then of its own', (thenables) => refusesPromise(Object.assign(Promise.resolve(1), { then: () => undefined }), thenables, types.isProxy), true, true],
    ['a native promise with a constructor of its own', (thenables) => refusesPromise(Object.assign(Promise.resolve(1), { constructor: Promise }), thenables, types.isProxy), true, true],
    ['a native promise while Promise.prototype.then is an accessor', (thenables) => {
      const promise = Promise.resolve(1)
      return whileReplaced(Promise.prototype, 'then', { get: () => undefined, configurable: true }, () => refusesPromise(promise, thenables, types.isProxy))
    }, true, true],
    ['any value while an array method is replaced', (thenables) => whileReplaced(Array.prototype, 'map', { ...kept.map, value: () => [] }, () => refusesPromise({ id: 1 }, thenables, types.isProxy)), true, true],
    ['a Proxy', (thenables) => refusesPromise(new Proxy({}, {}), thenables, types.isProxy), true, true],
    ['a Proxy over a promise', (thenables) => refusesPromise(new Proxy(Promise.resolve(1), {}), thenables, types.isProxy), true, true],
    ['an object with a Proxy on its chain', (thenables) => refusesPromise(Object.create(new Proxy({}, {})), thenables, types.isProxy), true, true],
    ['an object with a chain longer than the one walked', (thenables) => {
      let chain: object = {}
      for (let depth = 0; depth < 70; depth += 1) chain = Object.create(chain) as object
      return refusesPromise(chain, thenables, types.isProxy)
    }, true, true],
    ['an instance of a class with a then', (thenables) => refusesPromise(new (class { then(): void {} })(), thenables, types.isProxy), true, false],
    ['an object with an accessor then', (thenables) => refusesPromise({ get then() { return undefined } }, thenables, types.isProxy), true, false],
    ['a subclass of Promise', (thenables) => refusesPromise(new (class extends Promise<number> {})(() => undefined), thenables, types.isProxy), true, false],
    ['an object with a then that is a plain field', (thenables) => refusesPromise({ then: 1 }, thenables, types.isProxy), false, false],
  ]

  it.each(CHECKS)('answers for %s in the default mode and in the mode that lets thenables through', (_name, check, byDefault, withThenables) => {
    expect([check(false), check(true)]).toEqual([byDefault, withThenables])
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

/** A chain of `length` objects, the first the one handed over, each the prototype of the one before, ending in a prototype of null. */
function chainOf(length: number, head: object): object {
  let chain: object = Object.create(null) as object
  for (let made = 1; made < length - 1; made += 1) chain = Object.create(chain) as object
  return length > 1 ? Object.create(chain, Object.getOwnPropertyDescriptors(head)) as object : Object.assign(chain, head)
}

/** What a wait on a value reads, flushed: the microtasks an `await` of a thenable schedules have run when this resolves. */
async function flushed(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

describe('the limits of the chain a decision path walks, and what it takes for a value', () => {
  it('walks sixty-five objects and refuses a chain of sixty-six', () => {
    const answers = [chainHasThen(chainOf(65, {})), chainHasThen(chainOf(66, {})), chainHasThen(chainOf(1, {}))]
    expect(answers).toEqual([false, true, false])
  })

  it('finds a then on a function, which is a value a resolution reads a then of', () => {
    const callable = Object.assign(() => undefined, { then: () => undefined })
    expect(chainHasThen(callable)).toBe(true)
    expect(refusesPromise(callable)).toBe(true)
    expect(refusesPromise(() => undefined)).toBe(false)
  })

  it('refuses a Proxy of a function without running a trap, and without waiting for it', async () => {
    const asked: string[] = []
    const trap = (name: string) => (): never => {
      asked.push(name)
      throw new Error(`the ${name} trap ran`)
    }
    const proxy = new Proxy(() => undefined, { get: trap('get'), getPrototypeOf: trap('prototype'), has: trap('has') })
    expect(refusesPromise(proxy, false, types.isProxy)).toBe(true)
    expect(refusesPromise(proxy, true, types.isProxy)).toBe(true)
    await flushed()
    expect(asked).toEqual([])
  })

  it('waits for a refused thenable of an ordinary chain, and for none that is longer than the chain walked', async () => {
    const ran: string[] = []
    const thenable = (name: string): { then: () => void } => ({ then: () => void ran.push(name) })
    expect(refusesPromise(chainOf(65, thenable('short')))).toBe(true)
    expect(refusesPromise(chainOf(66, thenable('long')))).toBe(true)
    await flushed()
    expect(ran).toEqual(['short'])
  })

  it('refuses a value that is not an object while an array method is replaced, with nothing to walk', () => {
    const push = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!
    Object.defineProperty(Array.prototype, 'push', { ...push, value: () => 0 })
    try {
      expect([refusesPromise(undefined), refusesPromise(1), refusesPromise(null)]).toEqual([true, true, true])
    } finally {
      Object.defineProperty(Array.prototype, 'push', push)
    }
  })

  it('appends, maps and filters into lists that are as ordinary as a literal', () => {
    const appended: number[] = []
    appendTo(appended, 1)
    const lists = [appended, mapList([1], (n) => n), filterList([1], () => true)]
    for (const list of lists) {
      expect(Object.getOwnPropertyDescriptor(list, 0)).toEqual({ value: 1, writable: true, enumerable: true, configurable: true })
    }
  })
})

describe('marking the rejection of a promise nobody will wait for as handled', () => {
  /** The rejections the process reports as unhandled while `run` and the turns after it go by. */
  async function unhandledDuring(run: () => void): Promise<unknown[]> {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => void seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      run()
      await new Promise<void>((done) => setImmediate(done))
      await new Promise<void>((done) => setImmediate(done))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    return seen
  }
  const kept = Object.getOwnPropertyDescriptor(Promise.prototype, 'then') as { value: (...args: unknown[]) => unknown } & PropertyDescriptor
  afterEach(() => {
    Reflect.defineProperty(Promise.prototype, 'then', kept)
    Reflect.deleteProperty(Object.prototype, 'accidentalExtension')
  })

  it('leaves no unhandled rejection of a native promise, and reads nothing from the polluted realm to do it', async () => {
    const lookups: string[] = []
    const failed = new Error('callback failed')
    // The plant is lifted before the test awaits anything: a `then` that never calls back would end the wait for the turns that follow.
    const seen = await unhandledDuring(() => {
      Reflect.defineProperty(Promise.prototype, 'then', { ...kept, value: () => void lookups.push('then') })
      ;(Object.prototype as Record<string, unknown>).accidentalExtension = 1
      try {
        absorbRejection(Promise.reject(failed))
      } finally {
        Reflect.defineProperty(Promise.prototype, 'then', kept)
      }
    })
    expect(seen).toEqual([])
    expect(lookups).toEqual([])
  })

  it('leaves no unhandled rejection of a native promise that names Promise as its own constructor, nor of a subclass of Promise', async () => {
    class Sub<T> extends Promise<T> {}
    const named = Promise.reject(new Error('callback failed'))
    Reflect.defineProperty(named, 'constructor', { value: Promise })
    const subclassed = Sub.reject(new Error('callback failed'))
    expect(await unhandledDuring(() => { absorbRejection(named); absorbRejection(subclassed) })).toEqual([])
  })

  it('leaves no unhandled rejection of a native promise with a then of its own', async () => {
    const own = Promise.reject(new Error('callback failed'))
    Reflect.defineProperty(own, 'then', { value: kept.value })
    expect(await unhandledDuring(() => absorbRejection(own))).toEqual([])
  })

  it('leaves no unhandled rejection of a native promise while the then of Promise.prototype is an accessor', async () => {
    const failed = Promise.reject(new Error('callback failed'))
    expect(await unhandledDuring(() => {
      Reflect.defineProperty(Promise.prototype, 'then', { get: () => kept.value as unknown, configurable: true })
      try {
        absorbRejection(failed)
      } finally {
        Reflect.defineProperty(Promise.prototype, 'then', kept)
      }
    })).toEqual([])
  })

  it('leaves no unhandled rejection of a native promise while Promise[Symbol.species] is planted, and reads that getter 0 times', async () => {
    const speciesKept = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!
    let reads = 0
    const failed = Promise.reject(new Error('callback failed'))
    const seen = await unhandledDuring(() => {
      Reflect.defineProperty(Promise, Symbol.species, { get: () => { reads += 1; return Promise }, configurable: true })
      try {
        absorbRejection(failed)
      } finally {
        Reflect.defineProperty(Promise, Symbol.species, speciesKept)
      }
    })
    expect(seen).toEqual([])
    expect(reads).toBe(0)
  })

  it('does not hand a thenable that is no promise to the then of a promise', () => {
    class Builder {
      then(): void {}
    }
    expect(() => absorbRejection(new Builder(), true)).not.toThrow()
  })

  it('runs the then of a thenable only when the caller does not let thenables through', () => {
    const ran: string[] = []
    const lazy = { then: () => void ran.push('then') }
    absorbRejection(lazy, true)
    expect(ran).toEqual([])
    absorbRejection(lazy, false)
    expect(ran).toEqual([])
    return flushed().then(() => expect(ran).toEqual(['then']))
  })

  it('touches no trap of a Proxy and ignores a value that is no promise', () => {
    const trapped: string[] = []
    const proxied = new Proxy(Promise.resolve(1), { get: (target, key) => { trapped.push(String(key)); return Reflect.get(target, key) as unknown } })
    absorbRejection(proxied, false, types.isProxy)
    absorbRejection(null, false, types.isProxy)
    absorbRejection(7, false, types.isProxy)
    absorbRejection(undefined, false, types.isProxy)
    expect(trapped).toEqual([])
  })
})
