/**
 * @fileoverview The module that checks the promises a host returns loads on a host whose global `Promise` is not the engine's: a
 * subclass, a wrapper function, a library such as bluebird or zone.js, or none at all. It takes what it compares with from the engine,
 * and never from the global.
 * @layer shared
 */

import type * as NativePromiseModule from './native-promise'

type NativePromise = typeof NativePromiseModule

/** Loads the module in a fresh registry while `replace` has put another `Promise` on the global, and gives the global back. */
function loadWith(replace: (engine: PromiseConstructor) => unknown): NativePromise {
  const engine = Promise
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Promise')!
  let loaded: NativePromise | undefined
  Object.defineProperty(globalThis, 'Promise', { ...descriptor, value: replace(engine) })
  try {
    jest.isolateModules(() => {
      loaded = jest.requireActual<NativePromise>('./native-promise')
    })
  } finally {
    Object.defineProperty(globalThis, 'Promise', descriptor)
  }
  return loaded!
}

/** A function that builds a native promise, as a wrapper library does, with the engine's prototype. */
function wrapper(engine: PromiseConstructor): unknown {
  function Wrapper(executor: ConstructorParameters<PromiseConstructor>[0]): Promise<unknown> {
    return new engine(executor)
  }
  Wrapper.prototype = engine.prototype
  Object.setPrototypeOf(Wrapper, engine)
  return Wrapper
}

describe.each([
  ['a subclass of Promise', (engine: PromiseConstructor) => class Replacement extends (engine as unknown as new (executor: unknown) => object) {}],
  ['a wrapper function over the engine promise', wrapper],
  ['a Promise that is gone', () => undefined],
  ['a Promise that is a plain function', () => function Replacement(): void {}],
])('the module loaded with %s as the global Promise', (_name, replace) => {
  it('loads, and answers as it does on a host with the engine promise', async () => {
    const native = loadWith(replace)
    expect(native.promiseIntrinsicsIntact()).toBe(true)
    expect(native.promiseSpeciesIntact()).toBe(true)
    expect(native.refusesPromise(Promise.resolve(1), false)).toBe(false)
    const planted = Promise.resolve(1)
    void Object.defineProperty(planted, 'then', { value: () => undefined })
    expect(native.refusesPromise(planted, false)).toBe(true)
  })
})
