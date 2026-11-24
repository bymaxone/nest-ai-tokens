/**
 * @fileoverview The check that runs between a host call and the native `await` of what it returned: a promise of this realm whose
 * `constructor` or `then` a host controls is refused, anything else goes on, and a refused promise is waited for once so that a rejection of it is handled.
 * @layer server
 */

import { isPristinePromise, promiseIntrinsicsIntact, promiseSpeciesIntact, refusesPromise } from './native-promise'

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
    expect(isPristinePromise(value)).toBe(true)
  })

  it('lets a thenable that is not a promise of this realm go on, since the answer it gives is its own', () => {
    expect(isPristinePromise({ then: () => undefined })).toBe(true)
    expect(isPristinePromise(Object.setPrototypeOf(Promise.resolve(1), null))).toBe(true)
  })

  it('lets an untouched promise go on', () => {
    expect(isPristinePromise(Promise.resolve(1))).toBe(true)
    expect(promiseIntrinsicsIntact()).toBe(true)
    expect(promiseSpeciesIntact()).toBe(true)
  })

  it.each([['then'], ['constructor']])('refuses a promise with an own %s', (name) => {
    const promise = Promise.resolve(1)
    Reflect.defineProperty(promise, name, { value: Promise, configurable: true })
    expect(isPristinePromise(promise)).toBe(false)
  })

  it('refuses while Promise.prototype.constructor is an accessor, a value that is not Promise, or gone', () => {
    Reflect.defineProperty(Promise.prototype, 'constructor', { get: () => Promise, configurable: true })
    expect(isPristinePromise(Promise.resolve(1))).toBe(false)
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
})
