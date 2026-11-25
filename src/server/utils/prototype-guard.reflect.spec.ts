/**
 * @fileoverview Rows for the `Reflect` part of the realm guard: the functions the language defines on it are compared, and the functions a
 * metadata polyfill adds to it (a second copy defines them again) are not.
 * @layer server
 */
import type * as Guard from './prototype-guard'
import { assertCleanRealm } from './prototype-guard'

/** The functions the language defines on `Reflect`; each has its own row. */
const LANGUAGE_FUNCTIONS = [
  'apply',
  'construct',
  'defineProperty',
  'deleteProperty',
  'get',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'has',
  'isExtensible',
  'ownKeys',
  'preventExtensions',
  'set',
  'setPrototypeOf',
] as const

/** Captured here, because the rows below replace members of `Reflect` and must still put them back. */
const defineOf = Reflect.defineProperty
const reflect = Reflect as unknown as Record<string, (...args: unknown[]) => unknown>

/** The error `check` raises, or `undefined` when it does not refuse. */
function refusalOf(check: () => void): { code: string } | undefined {
  try {
    check()
  } catch (error) {
    return { code: (error as { getResponse(): { error: { code: string } } }).getResponse().error.code }
  }
  return undefined
}

describe('the realm guard and the functions on Reflect', () => {
  it.each(LANGUAGE_FUNCTIONS)('refuses a replaced Reflect.%s', (name) => {
    // A wrapper that forwards is still another function: the guard compares identity, not behaviour.
    const original = reflect[name] as (...args: unknown[]) => unknown
    const forwarding = (...args: unknown[]): unknown => original(...args)
    defineOf(Reflect, name, { value: forwarding })
    let thrown: { code: string } | undefined
    try {
      thrown = refusalOf(assertCleanRealm)
    } finally {
      defineOf(Reflect, name, { value: original })
    }
    expect(thrown?.code).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  it('does not refuse a polyfill function defined before load and defined again after it', async () => {
    // A second copy of the metadata polyfill defines its functions on `Reflect` again; no decision of the library reads one.
    defineOf(Reflect, 'defineMetadata', { value: () => 'first', configurable: true, writable: true })
    let loaded: typeof Guard | undefined
    try {
      await jest.isolateModulesAsync(async () => {
        loaded = await import('./prototype-guard')
      })
      defineOf(Reflect, 'defineMetadata', { value: () => 'second', configurable: true, writable: true })
      expect(loaded === undefined ? 'not loaded' : refusalOf(loaded.assertCleanRealm)).toBeUndefined()
    } finally {
      Reflect.deleteProperty(Reflect, 'defineMetadata')
    }
  })

  it('does not refuse once a second copy of reflect-metadata is evaluated after load', async () => {
    // The real package, in a fresh module registry, the way a host's second copy arrives.
    let loaded: typeof Guard | undefined
    await jest.isolateModulesAsync(async () => {
      loaded = await import('./prototype-guard')
    })
    jest.isolateModules(() => {
      jest.requireActual('reflect-metadata')
    })
    expect(loaded === undefined ? 'not loaded' : refusalOf(loaded.assertCleanRealm)).toBeUndefined()
  })
})
