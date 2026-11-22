/**
 * @fileoverview The gaps a full audit of the realm guard found, each as a row that fails without its fix: the iterator intrinsics that every
 * `for...of` and spread goes through, the global `Date`, the guard run again after the last await of a rating call, a module read through
 * its descriptors only, and the rating mode read as the host's own.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { applyDefaults } from './server/config'
import { AiTokensException } from './server/errors'
import { MeteringService } from './server/services/metering.service'
import { PricingService } from './server/services/pricing.service'
import { BUILT_INS, pollutedNames, recordFunctions } from './server/utils/prototype-guard'
import { makeFullStore } from '../test/fakes/full-store'

/** The code of the typed refusal a call raises, or `undefined` when it returns. */
async function codeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    return (error.getResponse() as { error: { code: string } }).error.code
  }
  return undefined
}

/** The iterator intrinsics a `for...of`, a spread or a destructuring goes through, by the value that reaches each. */
const ITERATORS: [string, () => object][] = [
  ['array iterator', () => Object.getPrototypeOf([][Symbol.iterator]()) as object],
  ['%IteratorPrototype%', () => Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as object],
  ['set iterator', () => Object.getPrototypeOf(new Set()[Symbol.iterator]()) as object],
  ['map iterator', () => Object.getPrototypeOf(new Map()[Symbol.iterator]()) as object],
  ['string iterator', () => Object.getPrototypeOf(''[Symbol.iterator]()) as object],
  ['regexp string iterator', () => Object.getPrototypeOf(''.matchAll(/a/g)) as object],
  ['generator', () => (Object.getPrototypeOf(function* generated(): Generator { /* prototype only */ }) as { prototype: object }).prototype],
]

describe('the realm guard and the iterators', () => {
  it.each(ITERATORS)('records the functions of the %s, and counts the first of them replaced', (_name, owner) => {
    const target = owner()
    const name = Object.hasOwn(target, 'next') ? 'next' : Symbol.iterator
    expect(BUILT_INS.some((entry) => entry.owner === target && entry.name === name)).toBe(true)
    const kept = Object.getOwnPropertyDescriptor(target, name)!
    let counted = -1
    try {
      Object.defineProperty(target, name, { ...kept, value: (): object => ({ done: true }) })
      counted = pollutedNames()
    } finally {
      Object.defineProperty(target, name, kept)
    }
    expect(counted).toBe(1)
    expect(pollutedNames()).toBe(0)
  })

  it.each([
    ['Array', Array.prototype],
    ['Set', Set.prototype],
    ['Map', Map.prototype],
    ['String', String.prototype],
  ] as [string, object][])('counts Symbol.iterator replaced on the %s prototype', (_name, owner) => {
    const kept = Object.getOwnPropertyDescriptor(owner, Symbol.iterator)!
    let counted = -1
    try {
      Object.defineProperty(owner, Symbol.iterator, { ...kept, value: function* replaced(): Generator { /* empty */ } })
      counted = pollutedNames()
    } finally {
      Object.defineProperty(owner, Symbol.iterator, kept)
    }
    expect(counted).toBeGreaterThanOrEqual(1)
    expect(pollutedNames()).toBe(0)
  })

  /** A replaced `next` of the array iterator made a `for...of` over `Object.entries` see nothing, so a surcharge was billed as 0. */
  it('refuses a record while the array iterator no longer iterates, and bills nothing', async () => {
    const { calls } = await rig()
    const record = calls['metering.record']!
    const args = await record.base()
    const prototype = Object.getPrototypeOf([][Symbol.iterator]()) as { next: unknown }
    const kept = prototype.next
    let code: string | undefined
    try {
      prototype.next = (): object => ({ done: true })
      code = await codeOf(() => record.run(args))
    } finally {
      prototype.next = kept
    }
    expect(code).toBe('AI_TOKENS_INVALID_CONFIG')
  })
})

describe('the realm guard and the global Date', () => {
  it('counts the global Date replaced by a subclass of it', () => {
    const kept = globalThis.Date
    let counted = -1
    try {
      ;(globalThis as { Date: unknown }).Date = class extends kept {}
      counted = pollutedNames()
    } finally {
      ;(globalThis as { Date: unknown }).Date = kept
    }
    expect(counted).toBe(1)
    expect(pollutedNames()).toBe(0)
  })
})

describe('the realm guard after the last await', () => {
  /** The built-in is replaced while the call waits for its rate, after the guard at the door has passed. */
  it('refuses an estimate when a built-in is replaced while the rate is read', async () => {
    const { calls } = await rig()
    const estimate = calls['metering.estimateCost']!
    const args = await estimate.base()
    const original = PricingService.prototype.resolveRate
    const values = Object.values
    const spy = jest.spyOn(PricingService.prototype, 'resolveRate').mockImplementation(async function (this: PricingService, ...given) {
      const rate = await original.apply(this, given)
      ;(Object as { values: unknown }).values = (): unknown[] => []
      return rate
    })
    let code: string | undefined
    try {
      code = await codeOf(() => estimate.run(args))
    } finally {
      ;(Object as { values: unknown }).values = values
      spy.mockRestore()
    }
    expect(code).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  it('refuses a capture when a built-in is replaced while the hold is loaded', async () => {
    const { calls } = await rig()
    const capture = calls['metering.capture']!
    const args = await capture.base()
    const load = (MeteringService.prototype as unknown as { loadHoldRecord: (...given: unknown[]) => Promise<unknown> }).loadHoldRecord
    const values = Object.values
    const spy = jest.spyOn(MeteringService.prototype as never, 'loadHoldRecord').mockImplementation((async function (this: unknown, ...given: unknown[]) {
      const record = await load.apply(this, given)
      ;(Object as { values: unknown }).values = (): unknown[] => []
      return record
    }) as never)
    let code: string | undefined
    try {
      code = await codeOf(() => capture.run(args))
    } finally {
      ;(Object as { values: unknown }).values = values
      spy.mockRestore()
    }
    expect(code).toBe('AI_TOKENS_INVALID_CONFIG')
  })
})

describe('the realm guard and the modules it records', () => {
  it('reads descriptors only, so no getter of the owner runs while its functions are recorded', () => {
    let reads = 0
    const owner = {
      kept(): void { /* a function */ },
    }
    Object.defineProperty(owner, 'fips', { get: () => { reads += 1; return 1 }, enumerable: true, configurable: true })
    const recorded = recordFunctions([owner])
    expect(reads).toBe(0)
    expect(recorded.map((entry) => entry.name)).toEqual(['kept'])
  })

  it('records no accessor of node:crypto and loading it warns of nothing', () => {
    const names = BUILT_INS.map((entry) => entry.name)
    expect(names).not.toContain('fips')
    expect(names).not.toContain('constants')
  })
})

describe('the rating mode as the host\'s own', () => {
  it.each(['ratingMode', 'currency'])('ignores a %s planted on Object.prototype when the host left it out', (key) => {
    const planted = key === 'ratingMode' ? 'provider-reported' : 'EUR'
    const bare = applyDefaults({ store: makeFullStore() })
    Object.defineProperty(Object.prototype, key, { value: planted, configurable: true, writable: true, enumerable: false })
    try {
      const resolved: Record<string, unknown> = { ...applyDefaults({ store: makeFullStore() }) }
      expect(resolved[key]).toBe(({ ...bare } as Record<string, unknown>)[key])
    } finally {
      Reflect.deleteProperty(Object.prototype, key)
    }
  })
})
