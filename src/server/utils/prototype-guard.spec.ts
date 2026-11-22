/**
 * @fileoverview The guard that refuses to bill beside a polluted realm: a clean process passes, a name planted on `Object.prototype` (by
 * assignment or by `defineProperty`, a string or an enumerable symbol), a standard name deleted or overwritten, a descriptor changed and a
 * built-in replaced each count, the refusal carries a count and never a name or a value, and the seam that turns it off is restored.
 * @layer server
 */

import type * as RealVm from 'node:vm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type * as GuardModule from './prototype-guard'
import { BUILT_INS, assertCleanRealm, pollutedNames, withoutRealmGuard } from './prototype-guard'

/** Captured here, because the rows below rebind `Reflect` and must still be able to put it back. */
const getOf = Reflect.get
const setOf = Reflect.set

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

  it('counts a standard name that is deleted, overwritten by another function, or a constructor that no longer names Object', () => {
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

  it('counts a standard function swapped for the same native function of another realm, which has the same text and not the same identity', () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'valueOf')!
    const foreign = runInNewContext('Object.prototype.valueOf') as () => boolean
    let counted = 0
    try {
      Object.defineProperty(Object.prototype, 'valueOf', { ...original, value: foreign })
      counted = pollutedNames()
    } finally {
      Object.defineProperty(Object.prototype, 'valueOf', original)
    }
    expect(counted).toBe(1)
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

  /** The scan relies on nothing a polluter can replace: with a key planted, a `Set` that forgets, an iterator that stops, an `Array` method or a
   * `Reflect` function that lies, the refusal still stands. */
  it.each([
    ['Set.prototype.add', Set.prototype, 'add', function (this: Set<unknown>): Set<unknown> { return this }],
    ['Set.prototype.has', Set.prototype, 'has', (): boolean => false],
    ['Array.prototype.filter', Array.prototype, 'filter', function (): unknown[] { return [] }],
    ['Array.prototype.every', Array.prototype, 'every', (): boolean => true],
    ['Array.prototype.includes', Array.prototype, 'includes', (): boolean => false],
    ['Array.prototype[Symbol.iterator]', Array.prototype, Symbol.iterator, function* (): Generator<never> { /* yields nothing */ }],
    ['Reflect.ownKeys', Reflect, 'ownKeys', (): never[] => []],
    ['Reflect.get', Reflect, 'get', (): undefined => undefined],
    ['Object.hasOwn', Object, 'hasOwn', (): boolean => true],
    ['Object.getOwnPropertyDescriptors', Object, 'getOwnPropertyDescriptors', (): object => ({})],
  ])('still counts a planted key when %s is replaced by a function that lies', (_name, owner, name, lie) => {
    const original = Reflect.get(owner, name) as unknown
    Object.defineProperty(Object.prototype, 'zzPlantedName', { value: 1, configurable: true, writable: true, enumerable: false })
    let counted = 0
    try {
      Reflect.set(owner, name, lie)
      counted = pollutedNames()
    } finally {
      Reflect.set(owner, name, original)
      Reflect.deleteProperty(Object.prototype, 'zzPlantedName')
    }
    expect(counted).toBeGreaterThanOrEqual(1)
    expect(pollutedNames()).toBe(0)
  })

  /** An element assigned to an array goes through the setters of its prototype chain: an index accessor planted there must not swallow what the scan keeps. */
  it.each([
    ['Object.prototype', Object.prototype],
    ['Array.prototype', Array.prototype],
  ])('still counts a planted key when an index accessor that swallows every write is planted on %s', (_name, owner) => {
    Object.defineProperty(owner, '0', { set(): void { /* swallows the write */ }, get: (): undefined => undefined, configurable: true })
    Object.defineProperty(Object.prototype, 'zzPlantedName', { value: 1, configurable: true, writable: true, enumerable: false })
    let counted = 0
    try {
      counted = pollutedNames()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzPlantedName')
      Reflect.deleteProperty(owner, '0')
    }
    expect(counted).toBeGreaterThanOrEqual(1)
    expect(pollutedNames()).toBe(0)
  })

  /** The scan is built from a few things no polluter can replace: pinned in its text, so that a later edit cannot bring an iterator, a list or a
   * method of the realm back. Comments are removed first, so that prose may name what the code avoids. */
  it('is written with plain loops, captured references and no list, iterator, spread, destructuring of an array or method of the realm', () => {
    const source = readFileSync(join(__dirname, 'prototype-guard.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const start = source.indexOf('export function pollutedNames')
    const body = source.slice(start, source.indexOf('let active', start))
    expect(body.length).toBeGreaterThan(200)
    for (const forbidden of [/\bfor\s*\(\s*(?:const|let)\s+[\w$[\]{},\s]+\s+of\b/, /\.\.\./, /\bnew\s+(?:Set|Map|WeakSet|WeakMap|Array)\b/, /\b(?:const|let)\s*\[/, /\]\s*=[^=]/, /\.(?:push|map|filter|forEach|some|every|includes|indexOf|slice|concat|entries|keys|values)\(/, /\bObject\.(?:keys|entries|values|assign)\b/]) {
      expect(forbidden.test(body)).toBe(false)
    }
  })

  /** A name rebound to another object leaves every function of the original as it was: the baseline compares the binding. */
  it.each(['Object', 'Reflect', 'Array', 'JSON', 'Math', 'Number', 'String', 'Promise', 'Set', 'Map', 'WeakMap', 'ArrayBuffer'])('counts the global %s rebound to another object, with nothing planted', (name) => {
    const original = getOf(globalThis, name) as unknown
    let counted = -1
    try {
      setOf(globalThis, name, { prototype: {} })
      counted = pollutedNames()
    } finally {
      setOf(globalThis, name, original)
    }
    expect(counted).toBe(1)
    expect(pollutedNames()).toBe(0)
  })

  /** No list of the functions the library calls is kept: every function of the standard namespaces and constructors is recorded, and replacing any
   * one of them, whichever, is counted. */
  it('counts every recorded function that is replaced, one at a time', () => {
    const defineOf = Object.defineProperty
    const descriptorOf = Object.getOwnPropertyDescriptor
    const missed: string[] = []
    let replaced = 0
    for (const { owner, name } of BUILT_INS) {
      const original = descriptorOf(owner, name)
      if (!original?.configurable) continue
      let counted = -1
      try {
        defineOf(owner, name, { ...original, value: function lying(): void { /* replaced */ } })
        counted = pollutedNames()
      } finally {
        defineOf(owner, name, original)
      }
      replaced += 1
      if (counted !== 1) missed.push(String(name) + ':' + String(counted))
    }
    expect(replaced).toBeGreaterThan(300)
    expect(missed).toEqual([])
    expect(pollutedNames()).toBe(0)
  })

  it('records the functions that money, hashes and dates go through', () => {
    const wanted: [object, string][] = [
      [BigInt, 'asIntN'], [BigInt.prototype, 'toString'], [DataView.prototype, 'setUint32'], [TextEncoder.prototype, 'encode'], [Date, 'UTC'], [Date.prototype, 'toISOString'],
      [Math, 'round'], [Object, 'values'], [Promise, 'all'], [Reflect, 'getPrototypeOf'], [Array.prototype, 'forEach'], [Array.prototype, 'reduce'], [String.prototype, 'padStart'],
      [Map.prototype, 'set'], [Set.prototype, 'add'], [Number, 'isSafeInteger'], [JSON, 'stringify'], [Object.getPrototypeOf(Uint8Array.prototype) as object, 'fill'], [ArrayBuffer, 'isView'],
    ]
    for (const [owner, name] of wanted) expect(BUILT_INS.some((entry) => entry.owner === owner && entry.name === name)).toBe(true)
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
