/**
 * @fileoverview The gaps a full audit of the realm guard found, each as a row that fails without its fix: the iterator intrinsics that every
 * `for...of` and spread goes through, the global `Date`, the guard run again after the last await of a rating call, a module read through
 * its descriptors only, and the rating mode read as the host's own.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { deriveIdempotencyKey } from './shared'
import { InMemoryLedgerStore } from '../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../test/fakes/in-memory-pricing-store'
import { providerPresets } from './server/config/provider-presets'
import { LedgerService } from './server/services/ledger.service'
import { applyDefaults } from './server/config'
import { AiTokensException } from './server/errors'
import { MeteringService } from './server/services/metering.service'
import { guardedStore } from './server/utils/guarded-store'
import { KeyedSerial } from './server/utils/keyed-serial'
import { ratedCost } from './server/utils/rated-cost'
import { MarkupResolver } from './server/services/markup.resolver'
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

describe('the realm guard after the awaited read of a price and of a markup', () => {
  /** The host's markup policy answers after the price was read: a built-in is replaced as it answers, and nothing is posted or reserved. */
  it.each(['record', 'hold', 'estimateCost', 'capture'] as const)('refuses %s when a built-in is replaced while the markup policy runs', async (name) => {
    let armed = false
    const values = Object.values
    const policy = {
      resolve: (): Promise<number> => {
        if (armed) (Object as { values: unknown }).values = (): unknown[] => []
        return Promise.resolve(1)
      },
    }
    const options = applyDefaults({ store: makeFullStore(), markup: policy, pricing: { seedFromSnapshot: false, strict: true, cacheTtlMs: 1 } })
    const pricing = new PricingService(options, new InMemoryPricingStore())
    const ledgerStore = new InMemoryLedgerStore()
    const metering = new MeteringService(new LedgerService(ledgerStore, options), pricing, new MarkupResolver(options), options)
    await pricing.upsertPrice({ provider: 'openai', model: 'gpt-4o', operation: 'chat', inputNanoUsdPerMillion: 2_500_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
    const context = (): never => ({ tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f', idempotencyKey: `k${String(Math.random())}`, baseModel: 'gpt-4o' }) as never
    const estimate = { provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 10, maxOutputTokens: 10 } as never
    const usage = { model: 'gpt-4o', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }
    const held = name === 'capture' ? await metering.hold(context(), estimate) : undefined
    const before = (await ledgerStore.query({ tenantId: 't' })).length
    armed = true
    let code: string | undefined
    try {
      code = await codeOf(() => {
        if (name === 'record') return metering.record({ usage, preset: { ...providerPresets.openaiChat }, context: context() })
        if (name === 'hold') return metering.hold(context(), estimate)
        if (name === 'estimateCost') return metering.estimateCost(estimate)
        return metering.capture(held as never, { tenantId: 't', scope: { type: 'user', id: 'u' } } as never, usage, { ...providerPresets.openaiChat })
      })
    } finally {
      ;(Object as { values: unknown }).values = values
      armed = false
    }
    expect(code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect((await ledgerStore.query({ tenantId: 't' })).length).toBe(before)
  })

  it('refuses a markup whose host policy answers after a built-in was replaced', async () => {
    const values = Object.values
    const resolver = new MarkupResolver({
      markup: {
        resolve: (): Promise<number> => {
          ;(Object as { values: unknown }).values = (): unknown[] => []
          return Promise.resolve(2)
        },
      },
    })
    let code: string | undefined
    try {
      code = await codeOf(() => resolver.resolve({ scope: { type: 'user', id: 'u' }, provider: 'openai', model: 'gpt-4o', operation: 'chat', serviceTier: 'standard' }))
    } finally {
      ;(Object as { values: unknown }).values = values
    }
    expect(code).toBe('AI_TOKENS_INVALID_CONFIG')
  })
})

describe('the realm guard and the symbol-keyed methods', () => {
  /** A replaced `RegExp.prototype[Symbol.replace]` or `Date.prototype[Symbol.toPrimitive]` is seen by no scan of names: the symbols are recorded too. */
  it.each([
    ['RegExp.prototype', RegExp.prototype, Symbol.replace],
    ['RegExp.prototype', RegExp.prototype, Symbol.split],
    ['RegExp.prototype', RegExp.prototype, Symbol.match],
    ['RegExp.prototype', RegExp.prototype, Symbol.matchAll],
    ['RegExp.prototype', RegExp.prototype, Symbol.search],
    ['Date.prototype', Date.prototype, Symbol.toPrimitive],
    ['String.prototype', String.prototype, Symbol.iterator],
    ['Symbol.prototype', Symbol.prototype, Symbol.toPrimitive],
  ] as [string, object, symbol][])('records the symbol-keyed method of %s and counts it replaced', (_label, owner, key) => {
    expect(BUILT_INS.some((entry) => entry.owner === owner && entry.name === key)).toBe(true)
    const kept = Object.getOwnPropertyDescriptor(owner, key)!
    let counted = -1
    try {
      Object.defineProperty(owner, key, { ...kept, value: function replaced(): void { /* a replacement */ } })
      counted = pollutedNames()
    } finally {
      Object.defineProperty(owner, key, kept)
    }
    expect(counted).toBe(1)
    expect(pollutedNames()).toBe(0)
  })
})

describe('the realm guard and Function.prototype', () => {
  /** `call`, `apply` and `bind` run every call the library makes, so a replaced one rewrites the arguments and the results of each. */
  it.each(['call', 'apply', 'bind'] as const)('counts Function.prototype.%s replaced', (name) => {
    const kept = Object.getOwnPropertyDescriptor(Function.prototype, name)!
    let counted = -1
    try {
      Object.defineProperty(Function.prototype, name, { ...kept, value: function replaced(): void { /* a replacement */ } })
      counted = pollutedNames()
    } finally {
      Object.defineProperty(Function.prototype, name, kept)
    }
    expect(counted).toBe(1)
    expect(pollutedNames()).toBe(0)
  })

  it('refuses a store call while Function.prototype.apply is replaced, and runs the store through Reflect.apply', async () => {
    const { calls } = await rig()
    const query = calls['ledger.query']!
    const args = await query.base()
    const kept = Object.getOwnPropertyDescriptor(Function.prototype, 'apply')!
    let code: string | undefined
    try {
      Object.defineProperty(Function.prototype, 'apply', { ...kept, value: function replaced(): never { throw new Error('a replaced apply ran') } })
      code = await codeOf(() => query.run(args))
    } finally {
      Object.defineProperty(Function.prototype, 'apply', kept)
    }
    expect(code).toBe('AI_TOKENS_INVALID_CONFIG')
  })
})

describe('the realm guard in the step of the arithmetic', () => {
  it('refuses the cost of a usage and the markup of an amount when a built-in was replaced after the last read', () => {
    const resolver = new MarkupResolver({ markup: 2 })
    const values = Object.values
    let refused = 0
    return resolver.resolve({ scope: { type: 'user', id: 'u' }, provider: 'openai', model: 'gpt-4o', operation: 'chat', serviceTier: 'standard' }).then((resolved) => {
      try {
        ;(Object as { values: unknown }).values = (): unknown[] => []
        try {
          resolved.apply(10n)
        } catch (error) {
          if (error instanceof AiTokensException) refused += 1
        }
        try {
          ratedCost({} as never, {} as never)
        } catch (error) {
          if (error instanceof AiTokensException) refused += 1
        }
      } finally {
        ;(Object as { values: unknown }).values = values
      }
      expect(refused).toBe(2)
      expect(resolved.apply(10n)).toBe(20n)
    })
  })
})

describe('the realm guard and Promise', () => {
  /**
   * Wrapping the global `Promise` and its methods after load, as a tracing or monitoring agent does, is not counted as a polluted realm. The
   * wrapped `Promise.resolve` here hands the store a subclass instance, which is no exact native promise, so the store call is refused with
   * `AI_TOKENS_INVALID_CONFIG`.
   */
  it('does not count a Promise wrapped as an agent wraps it, and refuses the subclass promise it hands a store', async () => {
    const { calls } = await rig()
    const query = calls['ledger.query']!
    const args = await query.base()
    const original = { Promise: globalThis.Promise, then: Promise.prototype.then, resolve: Promise.resolve, all: Promise.all }
    let counted = -1
    let code: string | undefined = 'unset'
    try {
      Promise.prototype.then = function wrapped(this: Promise<unknown>, ...given: Parameters<Promise<unknown>['then']>): Promise<unknown> {
        return original.then.apply(this, given)
      } as never
      Promise.resolve = ((value: unknown): Promise<unknown> => original.resolve.call(Promise, value)) as never
      Promise.all = ((values: Iterable<unknown>): Promise<unknown[]> => original.all.call(Promise, values as never)) as never
      ;(globalThis as { Promise: unknown }).Promise = class Traced extends original.Promise<unknown> {}
      counted = pollutedNames()
      code = await codeOf(() => query.run(args))
    } finally {
      ;(globalThis as { Promise: unknown }).Promise = original.Promise
      Promise.prototype.then = original.then
      Promise.resolve = original.resolve
      Promise.all = original.all
    }
    expect(counted).toBe(0)
    expect(code).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A `resolve` and a `then` that count the calls made from the library's own files: it settles with `await`, so neither is reached. */
  it('settles a store result and serializes keyed work without a lookup of the live Promise.resolve or Promise.prototype.then', async () => {
    const original = { then: Promise.prototype.then, resolve: Promise.resolve }
    const reached = { then: 0, resolve: 0 }
    const store = guardedStore({ read: async (): Promise<{ a: number }> => ({ a: 1 }) })
    const serial = new KeyedSerial()
    let read: { a: number } | undefined
    const order: number[] = []
    try {
      Promise.prototype.then = function counted(this: Promise<unknown>, ...given: Parameters<Promise<unknown>['then']>): Promise<unknown> {
        if (new Error().stack?.includes('/src/server/')) reached.then += 1
        return original.then.apply(this, given)
      } as never
      Promise.resolve = ((value: unknown): Promise<unknown> => {
        if (new Error().stack?.includes('/src/server/')) reached.resolve += 1
        return original.resolve.call(Promise, value)
      }) as never
      read = await store.read()
      const first = serial.run('k', async () => order.push(1))
      const second = serial.run('k', async () => order.push(2))
      await first
      await second
    } finally {
      Promise.prototype.then = original.then
      Promise.resolve = original.resolve
    }
    expect(read).toEqual({ a: 1 })
    expect(order).toEqual([1, 2])
    expect(reached.then).toBe(0)
    expect(reached.resolve).toBe(0)
  })

  it('records no function of Promise or of its prototype', () => {
    expect(BUILT_INS.some((entry) => (entry.owner as unknown) === Promise || (entry.owner as unknown) === Promise.prototype)).toBe(false)
    expect(BUILT_INS.some((entry) => entry.owner === globalThis && entry.name === 'Promise')).toBe(false)
  })
})

describe('the reason of the refusal', () => {
  it('counts the names of Object.prototype and the built-ins apart, and names none', async () => {
    const { calls } = await rig()
    const record = calls['metering.record']!
    const args = await record.base()
    const reasonOf = async (): Promise<string> => {
      try {
        await record.run(args)
      } catch (error) {
        return ((error as AiTokensException).getResponse() as { error: { details: { reason: string } } }).error.details.reason
      }
      return ''
    }
    Object.defineProperty(Object.prototype, 'zzSecretName', { value: 'zzSecretValue', configurable: true, writable: true, enumerable: false })
    const values = Object.values
    let planted = ''
    let replaced = ''
    try {
      planted = await reasonOf()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzSecretName')
    }
    try {
      ;(Object as { values: unknown }).values = (): unknown[] => []
      replaced = await reasonOf()
    } finally {
      ;(Object as { values: unknown }).values = values
    }
    expect(planted).toContain('1 name(s) on the Object.prototype')
    expect(planted).toContain('and 0 built-in(s)')
    expect(replaced).toContain('0 name(s) on the Object.prototype')
    expect(replaced).toContain('and 1 built-in(s)')
    expect(planted + replaced).not.toContain('zzSecret')
  })
})

describe('the realm guard and JSON', () => {
  /** A host's own tests spy on `JSON.stringify`: the keys, the statement parameters and the hashes are made with the one the library met at load. */
  it('does not count a replaced JSON.stringify, and a record, a hold and a key still use the original', async () => {
    const { calls } = await rig()
    const record = calls['metering.record']!
    const hold = calls['metering.hold']!
    const recordArgs = await record.base()
    const holdArgs = await hold.base()
    const before = deriveIdempotencyKey({ b: 1n, a: [new Date(0), 'x'] })
    const original = JSON.stringify
    let counted = -1
    let after = ''
    let recordCode: string | undefined = 'unset'
    let holdCode: string | undefined = 'unset'
    try {
      JSON.stringify = ((): string => {
        throw new Error('a host spy ran')
      }) as never
      counted = pollutedNames()
      after = deriveIdempotencyKey({ b: 1n, a: [new Date(0), 'x'] })
      recordCode = await codeOf(() => record.run(recordArgs))
      holdCode = await codeOf(() => hold.run(holdArgs))
    } finally {
      JSON.stringify = original
    }
    expect(counted).toBe(0)
    expect(after).toBe(before)
    expect(recordCode).toBeUndefined()
    expect(holdCode).toBeUndefined()
  })
})

describe('the own fields of a typed error', () => {
  /** The instance holds its response, status, message and name as its own, writable and configurable but not enumerable, whatever sits on a prototype. */
  it.each([
    ['response', undefined],
    ['status', 402],
    ['message', undefined],
    ['name', 'AiTokensException'],
  ])('defines %s as an own, hidden, writable and configurable field', (field, expected) => {
    const error = new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS')
    const described = Object.getOwnPropertyDescriptor(error, field)!
    expect(described.writable).toBe(true)
    expect(described.configurable).toBe(true)
    expect(described.enumerable).toBe(false)
    if (expected !== undefined) expect(described.value).toBe(expected)
    expect(Object.keys(described).sort()).toEqual(['configurable', 'enumerable', 'value', 'writable'])
  })

  it('names itself and its text, and keeps its body', () => {
    const error = new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS')
    expect(error.name).toBe('AiTokensException')
    expect(String(error)).toBe(`AiTokensException: ${error.message}`)
    expect(error.message.length).toBeGreaterThan(0)
    expect((error.getResponse() as { error: { code: string } }).error.code).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')
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
