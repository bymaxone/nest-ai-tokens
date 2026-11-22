/**
 * @fileoverview The guard that refuses to bill beside a polluted realm: a clean process passes, a name planted on `Object.prototype` (by
 * assignment or by `defineProperty`, a string or an enumerable symbol), a standard name deleted or overwritten, a descriptor changed and a
 * built-in replaced each count, the refusal carries a count and never a name or a value, and the seam that turns it off is restored.
 * @layer server
 */

import type * as RealVm from 'node:vm'
import { runInNewContext } from 'node:vm'
import type * as GuardModule from './prototype-guard'
import { assertCleanRealm, pollutedNames, withoutRealmGuard } from './prototype-guard'

/** The typed code and reason of the refusal `run` raises, or `undefined` when it does not refuse. */
function refusal(run: () => void): { code: string; reason: string } | undefined {
  try {
    run()
  } catch (error) {
    const body = (error as { getResponse(): { error: { code: string; details?: { reason?: string } } } }).getResponse().error
    return { code: body.code, reason: body.details?.reason ?? '' }
  }
  return undefined
}

describe('the realm guard', () => {
  it('finds a clean process clean', () => {
    expect(pollutedNames()).toBe(0)
    expect(() => assertCleanRealm()).not.toThrow()
  })

  it.each([['assigned', false], ['defined and hidden', true]])('counts a string name that is %s and refuses with the count only', (_how, hidden) => {
    const name = 'zzPlantedName'
    if (hidden) Object.defineProperty(Object.prototype, name, { value: 'secret-value', configurable: true, writable: true, enumerable: false })
    else (Object.prototype as unknown as Record<string, unknown>)[name] = 'secret-value'
    try {
      expect(pollutedNames()).toBe(1)
      const refused = refusal(() => assertCleanRealm())
      expect(refused?.code).toBe('AI_TOKENS_INVALID_CONFIG')
      expect(refused?.reason).toContain('1 name(s)')
      expect(refused?.reason).not.toContain(name)
      expect(refused?.reason).not.toContain('secret-value')
    } finally {
      Reflect.deleteProperty(Object.prototype, name)
    }
    expect(pollutedNames()).toBe(0)
  })

  it('counts an enumerable symbol and ignores a hidden one', () => {
    const shown = Symbol('shown')
    const hidden = Symbol('hidden')
    Object.defineProperty(Object.prototype, shown, { value: 1, configurable: true, writable: true, enumerable: true })
    Object.defineProperty(Object.prototype, hidden, { value: 1, configurable: true, writable: true, enumerable: false })
    try {
      expect(pollutedNames()).toBe(1)
    } finally {
      Reflect.deleteProperty(Object.prototype, shown)
      Reflect.deleteProperty(Object.prototype, hidden)
    }
  })

  it('counts a standard name that is deleted, overwritten by another function, or made looser, and a constructor that no longer names Object', () => {
    const toString = Object.getOwnPropertyDescriptor(Object.prototype, 'toString')!
    const constructor = Object.getOwnPropertyDescriptor(Object.prototype, 'constructor')!
    const valueOf = Object.getOwnPropertyDescriptor(Object.prototype, 'valueOf')!
    try {
      Reflect.deleteProperty(Object.prototype, 'toString')
      expect(pollutedNames()).toBe(1)
      Object.defineProperty(Object.prototype, 'toString', toString)
      Object.defineProperty(Object.prototype, 'valueOf', { ...valueOf, value: function replaced(): number { return 1 } })
      expect(pollutedNames()).toBe(1)
      Object.defineProperty(Object.prototype, 'valueOf', valueOf)
      Object.defineProperty(Object.prototype, 'constructor', { ...constructor, value: 5 })
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(Object.prototype, 'toString', toString)
      Object.defineProperty(Object.prototype, 'valueOf', valueOf)
      Object.defineProperty(Object.prototype, 'constructor', constructor)
    }
    expect(pollutedNames()).toBe(0)
  })

  it('never runs a get or a set planted on the prototype that a descriptor would inherit', () => {
    let ran = 0
    Object.defineProperty(Object.prototype, 'get', { get: () => { ran += 1; return () => 1 }, configurable: true })
    Object.defineProperty(Object.prototype, 'set', { get: () => { ran += 1; return () => 1 }, configurable: true })
    try {
      expect(pollutedNames()).toBe(2)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'get')
      Reflect.deleteProperty(Object.prototype, 'set')
    }
    expect(ran).toBe(0)
  })

  it('counts a built-in that is not the one the library met', () => {
    const keys = Object.keys
    const includes = Array.prototype.includes
    let afterKeys = -1
    let afterBoth = -1
    try {
      ;(Object as { keys: unknown }).keys = (): string[] => []
      afterKeys = pollutedNames()
      ;(Array.prototype as { includes: unknown }).includes = (): boolean => true
      afterBoth = pollutedNames()
    } finally {
      ;(Object as { keys: unknown }).keys = keys
      ;(Array.prototype as { includes: unknown }).includes = includes
    }
    expect(afterKeys).toBe(1)
    expect(afterBoth).toBe(2)
    expect(pollutedNames()).toBe(0)
  })

  it('compares with the Object.prototype of a fresh realm, so it holds in a process that runs another realm too', () => {
    expect((runInNewContext('Object.prototype') as object) !== Object.prototype).toBe(true)
    expect(pollutedNames()).toBe(0)
  })

  it('turns off only inside withoutRealmGuard, for a synchronous and an asynchronous run, and turns on again after a throw', async () => {
    Object.defineProperty(Object.prototype, 'zzPlanted', { value: 1, configurable: true, writable: true, enumerable: false })
    try {
      expect(refusal(() => assertCleanRealm())).toBeDefined()
      expect(withoutRealmGuard(() => refusal(() => assertCleanRealm()))).toBeUndefined()
      expect(await withoutRealmGuard(async () => refusal(() => assertCleanRealm()))).toBeUndefined()
      expect(() => withoutRealmGuard(() => { throw new Error('boom') })).toThrow('boom')
      expect(refusal(() => assertCleanRealm())).toBeDefined()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzPlanted')
    }
  })
})

describe('the realm guard when a fresh realm cannot be built', () => {
  /** The module loaded afresh with a `vm` whose `runInNewContext` throws `failures` times and then works as the real one does. */
  async function loadedWithFailingVm(failures: number): Promise<typeof GuardModule> {
    const real = jest.requireActual<typeof RealVm>('node:vm')
    let left = failures
    let guard: typeof GuardModule | undefined
    await jest.isolateModulesAsync(async () => {
      jest.doMock('node:vm', () => ({
        runInNewContext: (code: string): unknown => {
          if (left > 0) {
            left -= 1
            throw new Error('no realm')
          }
          return real.runInNewContext(code)
        },
      }))
      guard = await import('./prototype-guard')
    })
    jest.dontMock('node:vm')
    return guard!
  }

  it('counts the process as polluted while no fresh realm can be built, and compares again once one can', async () => {
    // The build at load fails, and so do the retries of the first two uses; the retry of the third works.
    const guard = await loadedWithFailingVm(3)
    expect(guard.pollutedNames()).toBe(1)
    expect(() => guard.assertCleanRealm()).toThrow()
    expect(guard.pollutedNames()).toBe(0)
  })

  it('builds the realm at the first use when the build at load failed once', async () => {
    const guard = await loadedWithFailingVm(1)
    expect(guard.pollutedNames()).toBe(0)
  })
})
