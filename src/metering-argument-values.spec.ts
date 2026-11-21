/**
 * @fileoverview What the metering calls do with the arguments that take a hold: an estimate is read by the names of the variant it is,
 * a collector given to `capture()` is used as it is, and the usage of a call is read deeper than other arguments and never when it
 * contains itself.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { isBuiltInNormalizer, providerPresets } from './server/config/provider-presets'
import { AiTokensException } from './server/errors'
import { StreamUsageCollector } from './server/streaming/stream-usage-collector'
import { newVisit, readDeep } from './server/utils/argument-guards'
import { readHoldEstimate, readShape } from './server/utils/date-guards'

/** An object whose keys each hold a list of zeros of the given length. */
const lists = (sizes: number[]): Record<string, unknown> => Object.fromEntries(sizes.map((size, index) => [`l${String(index)}`, Array.from({ length: size }, () => 0)]))

function at(args: unknown[], path: (string | number)[]): Record<string | number, unknown> {
  let target: unknown = args
  for (const step of path) target = (target as Record<string | number, unknown>)[step]
  return target as Record<string | number, unknown>
}

function setAt(args: unknown[], path: (string | number)[], value: unknown): void {
  at(args, path.slice(0, -1))[path.at(-1)!] = value
}

/** The reason of the typed refusal `run` raises, or `undefined` when it is accepted; any other failure is rethrown. */
async function reasonOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    const { error: body } = error.getResponse() as { error: { code: string; details?: { reason?: string } } }
    return `${body.code} ${body.details?.reason ?? ''}`
  }
  return undefined
}

/** A public call with the arguments that make it succeed. */
async function callOf(name: string): Promise<{ run: (args: unknown[]) => unknown; args: unknown[] }> {
  const def = (await rig()).calls[name]
  if (def === undefined) throw new Error(`no call named ${name}`)
  return { run: def.run, args: await def.base() }
}

describe('the estimate of a hold', () => {
  /** A getter that throws, on a field the estimate's own variant does not have: the variant is told by the name that is present (`provider`, then `tokens`), so only a field the variant's own list does not hold can be trapped. */
  const trap = (target: Record<string, unknown>, field: string): Record<string, unknown> =>
    Object.defineProperty(target, field, { get: (): never => { throw new Error('host-private-text') }, enumerable: true })

  it.each([
    ['rated', { provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 10, maxOutputTokens: 10 }, ['tokens', 'amountNanoUsd']],
    ['tokens', { tokens: 10 }, ['amountNanoUsd', 'model']],
    ['amount', { amountNanoUsd: 5n }, ['model', 'inputTokens']],
  ] as const)('reads only the fields of the %s variant', async (_variant, estimate, others) => {
    const { run, args } = await callOf('metering.hold')
    const own: Record<string, unknown> = { ...estimate }
    for (const other of others) if (!(other in estimate)) trap(own, other)
    setAt(args, [1], own)
    // A token estimate needs a preset in the context to be rated, so it may be refused for that; it is never refused for a field it cannot read.
    expect((await reasonOf(() => run(args))) ?? '').not.toContain('could not be read')
  })

  it.each([
    ['rated', { provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 10, maxOutputTokens: 10 }],
    ['amount', { amountNanoUsd: 5n }],
  ] as const)('accepts a %s estimate that is a Proxy over an empty target and answers by its get trap', async (_variant, source) => {
    const { run, args } = await callOf('metering.hold')
    setAt(args, [1], new Proxy({}, { get: (_target, key) => (source as Record<string, unknown>)[key as string] }))
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })

  it.each(['provider', 'tokens'] as const)('names the estimate field %s when it cannot be read', async (field) => {
    const { run, args } = await callOf('metering.hold')
    setAt(args, [1], Object.defineProperty({}, field, { get: (): never => { throw new Error('host-private-text') }, enumerable: true }))
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG estimate.${field} could not be read`)
  })

  it.each(['provider', 'tokens'] as const)('reads the %s of an estimate once: a getter that answers a value and then throws settles on the first', async (field) => {
    const { run, args } = await callOf('metering.hold')
    let reads = 0
    const base = field === 'provider' ? { model: 'gpt-4o', operation: 'chat', inputTokens: 10, maxOutputTokens: 10 } : {}
    const estimate = Object.defineProperty({ ...base }, field, { enumerable: true, get: (): unknown => { reads += 1; if (reads > 1) throw new Error('host-private-text'); return field === 'provider' ? 'openai' : 100 } })
    setAt(args, [1], estimate)
    expect((await reasonOf(() => run(args))) ?? '').not.toContain('could not be read')
    expect(reads).toBe(1)
  })

  it('names the field of a rated estimate that cannot be read, and the discriminator that holds a value that cannot be read', async () => {
    const rated = { provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 10, maxOutputTokens: 10 }
    const { run, args } = await callOf('metering.hold')
    setAt(args, [1], Object.defineProperty({ ...rated }, 'model', { get: (): never => { throw new Error('host-private-text') }, enumerable: true }))
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG estimate.model could not be read')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    setAt(args, [1], { ...rated, provider: cyclic })
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG estimate.provider.self could not be read')
    setAt(args, [1], { tokens: cyclic })
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG estimate.tokens.self could not be read')
  })

  it('gives the snapshot of an estimate the discriminator as a field a spread and a write both see', () => {
    for (const estimate of [{ provider: 'openai', model: 'm', operation: 'chat', inputTokens: 1, maxOutputTokens: 1 }, { tokens: 5 }]) {
      const copy = readHoldEstimate(estimate as never, newVisit()) as Record<string, unknown>
      const key = 'provider' in estimate ? 'provider' : 'tokens'
      expect(Object.keys(copy)).toContain(key)
      expect(Object.getOwnPropertyDescriptor(copy, key)).toEqual({ value: (estimate as Record<string, unknown>)[key], writable: true, enumerable: true, configurable: false })
    }
  })

  it('tells a tokens estimate that answers by its get trap from an amount, and refuses it only for the preset a tokens estimate needs', async () => {
    const { run, args } = await callOf('metering.hold')
    setAt(args, [1], new Proxy({}, { get: (_target, key) => ({ tokens: 10 } as Record<string, unknown>)[key as string] }))
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG a { tokens } hold estimate requires context.preset to identify the provider')
  })
})

describe('a capture that is repeated', () => {
  /** An object whose every field answers the first read and throws at every later one, as a usage a host builds once may. */
  const answersOnce = (source: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source)) {
      let read = false
      Object.defineProperty(out, key, {
        enumerable: true,
        get: (): unknown => {
          if (read) throw new Error('host-private-text')
          read = true
          return source[key]
        },
      })
    }
    return out
  }

  it('returns the record it posted without reading the usage again', async () => {
    const { run, args } = await callOf('metering.capture')
    args[2] = answersOnce(args[2] as Record<string, unknown>)
    const first = (await run(args)) as { id: string }
    const second = (await run(args)) as { id: string }
    expect(second.id).toBe(first.id)
  })
})

describe('a collector given to capture', () => {
  it('is used as it is, and the field of it the settlement reads is read once', async () => {
    const { run, args } = await callOf('metering.capture')
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-4o', preset: providerPresets.openaiChat })
    collector.push({ model: 'gpt-4o', choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } })
    let reads = 0
    Object.defineProperty(collector, 'usedFallback', { get: (): boolean => { reads += 1; return false } })
    args[2] = collector
    expect(await reasonOf(() => run(args))).toBeUndefined()
    expect(reads).toBe(1)
  })

  it('is refused as data, not leaked, when it is a Proxy whose prototype trap throws', async () => {
    const { run, args } = await callOf('metering.capture')
    args[2] = new Proxy({}, { getPrototypeOf: (): never => { throw new Error('host-private-text') } })
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG usage.provider could not be read')
  })
})

describe('the lists and maps a call reads once', () => {
  it('refuses a list that holds itself, and reads a value shared twice without a cycle as two copies', () => {
    const list: unknown[] = []
    list.push(list)
    expect(() => readDeep(list, 'list', 0, 64)).toThrow()
    const shared = { a: 1 }
    expect(readDeep({ x: shared, y: shared }, 'pair', 0, 64)).toEqual(expect.objectContaining({ x: { a: 1 }, y: { a: 1 } }))
  })

  it('refuses a value that shares a child between its branches 40 levels deep, after reading no more than the budget of objects', () => {
    let reads = 0
    let shared: Record<string, unknown> = { leaf: 1 }
    for (let level = 0; level < 40; level += 1) {
      const child = shared
      shared = {
        get left(): unknown { reads += 1; return child },
        get right(): unknown { reads += 1; return child },
      }
    }
    expect(refusalOf(() => readDeep(shared, 'usage', 0, 64))).toMatch(/^usage(\.left|\.right)+ could not be read$/)
    expect(reads).toBeLessThanOrEqual(10_001)
  })

  it('reads a batch of embeddings and a structured output of 3_000 rows', () => {
    const embeddings = Array.from({ length: 100 }, () => ({ embedding: Array.from({ length: 3072 }, (_, index) => index) }))
    expect(readDeep({ data: embeddings }, 'usage', 0, 64)).toEqual(expect.objectContaining({ data: expect.any(Array) as unknown }))
    const rows = Array.from({ length: 3_000 }, (_, index) => ({ id: index, detail: { ok: true } }))
    expect((readDeep({ rows }, 'usage', 0, 64) as { rows: unknown[] }).rows).toHaveLength(3_000)
  })

  it('reads exactly as many different lists and objects as the budget holds, and refuses one more', () => {
    const objects = (count: number): unknown[] => Array.from({ length: count }, () => ({}))
    expect(() => readDeep(objects(9_999), 'usage', 0, 64)).not.toThrow()
    expect(() => readDeep(objects(10_000), 'usage', 0, 64)).toThrow()
  })

  it('reads exactly as many values as the budget holds, counting each list and the root, and refuses one more', () => {
    const nine = Array.from({ length: 9 }, () => 100_000)
    expect(() => readDeep(lists([...nine, 99_989]), 'usage', 0, 64)).not.toThrow()
    expect(() => readDeep(lists([...nine, 99_990]), 'usage', 0, 64)).toThrow()
  })

  it('refuses distinct lists of 100_000 elements that all return one shared child, after reading no more than the budget of values', () => {
    let reads = 0
    const shared = { leaf: 1 }
    const list = (): unknown[] =>
      new Proxy<unknown[]>(Array.from({ length: 100_000 }, () => 0), {
        get: (target, key): unknown => {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            reads += 1
            return shared
          }
          return Reflect.get(target, key) as unknown
        },
      })
    expect(refusalOf(() => readDeep(Array.from({ length: 12 }, list), 'usage', 0, 64))).toMatch(/^usage\[\d+\]\[\d+\] could not be read$/)
    expect(reads).toBeLessThanOrEqual(1_000_000)
  })

  it('shares the budget between the fields of one call, and gives each call its own', () => {
    const big = (): number[][] => Array.from({ length: 6 }, () => Array.from({ length: 100_000 }, () => 0))
    const shape = { fields: { a: true, b: true } }
    expect(() => readShape({ a: big() }, shape, '')).not.toThrow()
    expect(() => readShape({ a: big(), b: big() }, shape, '')).toThrow()
    expect(() => readShape({ a: big() }, shape, '')).not.toThrow()
  })

  it('refuses an object that holds more keys than a list may hold elements, and reads one that holds that many', () => {
    const keyed = (count: number): Record<string, number> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${String(index)}`, index]))
    expect(Object.keys(readDeep(keyed(100_000), 'usage', 0, 64) as object)).toHaveLength(100_000)
    expect(() => readDeep(keyed(100_001), 'usage', 0, 64)).toThrow()
  })

  it('refuses a value that makes two new objects of every object it is asked for, after at most the budget of objects', () => {
    let made = 0
    const lazy = (): object => ({ get left(): object { made += 1; return lazy() }, get right(): object { made += 1; return lazy() } })
    expect(() => readDeep(lazy(), 'usage', 0, 64)).toThrow()
    expect(made).toBeLessThanOrEqual(10_001)
  })

  it('refuses a Proxy that lists no key, which answers by its get trap for names nobody can list, and reads an empty object', () => {
    expect(refusalOf(() => readDeep(new Proxy({}, { get: () => 5 }), 'unitRates', 1))).toBe('unitRates could not be read')
    expect(readDeep({}, 'unitRates', 1)).toEqual({})
    expect(readDeep(new Proxy({ a: 1 }, {}), 'unitRates', 1)).toEqual({ a: 1 })
  })

  it('keeps a Buffer and a typed array by reference, whatever their size', () => {
    const buffer = Buffer.alloc(5_000_000)
    const floats = new Float32Array(1_000_000)
    const copy = readDeep({ buffer, floats }, 'usage', 0, 64) as { buffer: unknown; floats: unknown }
    expect(copy.buffer).toBe(buffer)
    expect(copy.floats).toBe(floats)
  })
})

const NORMALIZED = { provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }

describe('the usage of a call', () => {
  /** An object that answers by its get trap and lists nothing, as a lazy wrapper of a response does. */
  const lazy = (source: Record<string, unknown>): object => new Proxy({}, { get: (_target, key) => source[key as string] })
  const anthropic = (extra: Record<string, unknown>): Record<string, unknown> => ({ model: 'claude-opus', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, ...extra } })

  /** The record call of a world that prices the Anthropic model, and its arguments. */
  async function recordCall(): Promise<{ run: (args: unknown[]) => unknown; args: unknown[] }> {
    const { calls } = await rig()
    const price = calls['pricing.upsertPrice']
    const record = calls['metering.record']
    if (price === undefined || record === undefined) throw new Error('no call')
    const priceArgs = await price.base()
    Object.assign(at(priceArgs, [0]), { provider: 'anthropic', model: 'claude-opus', unitRates: { web_search_requests: 1n } })
    await price.run(priceArgs)
    return { run: record.run, args: await record.base() }
  }

  async function recorded(preset: unknown, usage: unknown, keepBaseModel = false): Promise<{ cacheWrite5mTokens: number; cacheWrite1hTokens: number; cacheReadTokens: number; reasoningTokens: number; extraUnits?: Record<string, number> }> {
    const { run, args } = await recordCall()
    at(args, [0]).preset = preset
    at(args, [0]).usage = usage
    if (!keepBaseModel) delete at(args, [0, 'context']).baseModel
    return (await run(args)) as { cacheWrite5mTokens: number; cacheWrite1hTokens: number; cacheReadTokens: number; reasoningTokens: number; extraUnits?: Record<string, number> }
  }

  it('bills the cache writes of an Anthropic response whose cache_creation answers by a get trap, as it bills a plain one', async () => {
    const cache = { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 }
    const plain = await recorded(providerPresets.anthropic, anthropic({ cache_creation: cache }))
    const wrapped = await recorded(providerPresets.anthropic, anthropic({ cache_creation: lazy(cache) }))
    expect([plain.cacheWrite5mTokens, plain.cacheWrite1hTokens]).toEqual([30, 20])
    expect([wrapped.cacheWrite5mTokens, wrapped.cacheWrite1hTokens]).toEqual([30, 20])
  })

  it('bills the cached and the reasoning tokens of an OpenAI response whose details answer by a get trap', async () => {
    const response = (details: (source: Record<string, unknown>) => unknown): Record<string, unknown> => ({ model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: details({ cached_tokens: 20 }), completion_tokens_details: details({ reasoning_tokens: 10 }) } })
    const wrapped = await recorded(providerPresets.openaiChat, response(lazy), true)
    expect([wrapped.cacheReadTokens, wrapped.reasoningTokens]).toEqual([20, 10])
  })

  it('refuses the server tool use of an Anthropic response that lists nothing, and never bills a tool as free', async () => {
    const { run, args } = await recordCall()
    at(args, [0]).preset = providerPresets.anthropic
    delete at(args, [0, 'context']).baseModel
    at(args, [0]).usage = anthropic({ server_tool_use: lazy({ web_search_requests: 5 }) })
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_USAGE_MALFORMED the usage holds an object that lists no field')
    at(args, [0]).usage = anthropic({ server_tool_use: { web_search_requests: 5 } })
    expect((await run(args) as { extraUnits?: Record<string, number> }).extraUnits).toEqual({ web_search_requests: 5 })
  })

  it('bills the server tool counts an Anthropic response defines as a getter of a class or as a field that is not enumerable', async () => {
    class Tools { get web_search_requests(): number { return Number('5') } }
    const hidden = Object.defineProperty({}, 'web_search_requests', { value: 7, enumerable: false })
    const viaClass = await recorded(providerPresets.anthropic, anthropic({ server_tool_use: new Tools() }))
    const viaHidden = await recorded(providerPresets.anthropic, anthropic({ server_tool_use: hidden }))
    expect(viaClass.extraUnits).toEqual({ web_search_requests: 5 })
    expect(viaHidden.extraUnits).toEqual({ web_search_requests: 7 })
  })

  it('refuses the unit rates of a price that list nothing, and never stores a tool as free', async () => {
    const { run, args } = await callOf('pricing.upsertPrice')
    at(args, [0]).unitRates = lazy({ web_search_requests: 10n })
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG unitRates could not be read')
  })

  it('refuses the extra units of a context that list nothing', async () => {
    const { run, args } = await callOf('metering.record')
    at(args, [0, 'context']).extraUnits = lazy({ web_search_requests: 5 })
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG context.extraUnits could not be read')
  })

  it('accepts a full embeddings response and a response that carries a Buffer, without walking either', async () => {
    const data = Array.from({ length: 2048 }, () => ({ embedding: Array.from({ length: 1536 }, () => 0.5) }))
    await recorded(providerPresets.openaiChat, { model: 'text-embedding-3-small', data, usage: { prompt_tokens: 5, completion_tokens: 0 } }, true)
    await recorded(providerPresets.openaiChat, { model: 'gpt-4o', blob: Buffer.alloc(5_000_000), usage: { prompt_tokens: 5, completion_tokens: 1 } }, true)
  })

  it('accepts a normalized usage that holds an empty raw and an empty serverToolUse, in record() and in capture()', async () => {
    const normalized = { provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0, raw: {}, serverToolUse: {} }
    const recordCall = await callOf('metering.record')
    delete at(recordCall.args, [0]).preset
    at(recordCall.args, [0]).usage = normalized
    expect(await reasonOf(() => recordCall.run(recordCall.args))).toBeUndefined()
    const captureCall = await callOf('metering.capture')
    captureCall.args[2] = normalized
    expect(await reasonOf(() => captureCall.run(captureCall.args))).toBeUndefined()
  })

  it('accepts a normalized usage whose raw holds objects nested 40 deep, and refuses one nested past 64', async () => {
    const nested = (depth: number): Record<string, unknown> => (depth === 0 ? { leaf: 1 } : { next: nested(depth - 1) })
    const usage = (depth: number): Record<string, unknown> => ({ provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0, raw: nested(depth) })
    const call = await callOf('metering.record')
    delete at(call.args, [0]).preset
    at(call.args, [0]).usage = usage(40)
    expect(await reasonOf(() => call.run(call.args))).toBeUndefined()
    at(call.args, [0]).usage = usage(70)
    expect(await reasonOf(() => call.run(call.args))).toContain('usage.raw')
  })

  it('hands a normalizer of the host the host\'s own object, which it may call a method of, test with instanceof and read a private field of', async () => {
    class Response {
      readonly #tokens = 7
      readonly usage = { prompt_tokens: 5, completion_tokens: 5 }
      tokens(): number {
        return this.#tokens
      }
    }
    const normalizer = (raw: unknown): unknown => {
      if (!(raw instanceof Response)) throw new Error('not a response')
      return { provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: raw.tokens(), outputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
    }
    const { run, args } = await callOf('metering.record')
    at(args, [0]).preset = { provider: 'openai', normalizer, ratingMode: 'rate-table' }
    at(args, [0]).usage = new Response()
    expect(((await run(args)) as { inputTokens: number }).inputTokens).toBe(7)
  })

  it.each([
    ['a getter that answers a count first and another after', (): Record<string, unknown> => { let reads = 0; return Object.defineProperty({ ...NORMALIZED }, 'inputTokens', { enumerable: true, get: (): number => { reads += 1; return reads === 1 ? 5 : -3 } }) }],
    ['a Proxy over an empty target that answers by its get trap', (): Record<string, unknown> => lazy({ ...NORMALIZED }) as Record<string, unknown>],
  ] as const)('settles a capture of a normalized usage that is %s, with the preset of a host, on the values read once', async (_label, make) => {
    const { run, args } = await callOf('metering.capture')
    args[3] = { provider: 'openai', normalizer: (raw: unknown): unknown => raw, ratingMode: 'rate-table' }
    args[2] = make()
    const record = (await run(args)) as { inputTokens: number; outputTokens: number }
    expect([record.inputTokens, record.outputTokens]).toEqual([5, 5])
  })

  it('reads a normalized usage by name once when a record has no normalizer, and when it is a Proxy over an empty target', async () => {
    const { run, args } = await callOf('metering.record')
    delete at(args, [0]).preset
    at(args, [0]).usage = lazy({ ...NORMALIZED })
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })

  it('does not take the fields of a normalized usage from a raw response a normalizer reads: a cyclic raw there is the response\'s own business', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const builtIn = await callOf('metering.record')
    at(builtIn.args, [0]).usage = { model: 'gpt-4o', raw: cyclic, usage: { prompt_tokens: 5, completion_tokens: 5 } }
    expect(await reasonOf(() => builtIn.run(builtIn.args))).toBeUndefined()
    const host = await callOf('metering.record')
    delete at(host.args, [0]).preset
    at(host.args, [0]).normalizer = (): unknown => ({ ...NORMALIZED })
    at(host.args, [0]).usage = { raw: cyclic }
    expect(await reasonOf(() => host.run(host.args))).toBeUndefined()
  })

  it('names the usage when a field of a normalized usage cannot be read', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const { run, args } = await callOf('metering.capture')
    args[2] = { ...NORMALIZED, raw: cyclic }
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG usage.raw.self could not be read')
  })

  it('records a response that holds a null field, which is no object to give a view', async () => {
    const { run, args } = await callOf('metering.record')
    at(args, [0]).usage = { model: 'gpt-4o', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: null } }
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })

  it('leaves the fields a host normalizer reads to it: a getter that answers once settles the capture on that answer', async () => {
    let reads = 0
    const raw = { model: 'custom', get inputTokens(): number { reads += 1; if (reads > 1) throw new Error('host-private-text'); return 100 } }
    const normalizer = (response: unknown): unknown => ({ ...NORMALIZED, inputTokens: (response as typeof raw).inputTokens })
    const { run, args } = await callOf('metering.capture')
    args[3] = { provider: 'openai', normalizer, ratingMode: 'rate-table' }
    args[2] = raw
    expect(((await run(args)) as { inputTokens: number }).inputTokens).toBe(100)
    expect(reads).toBe(1)
  })

  it.each([
    ['provider', { provider: 'custom' }],
    ['operation', { operation: 'chat' }],
  ] as const)('leaves the fields of a host normalizer to it when the response names only its %s', async (_name, named) => {
    let reads = 0
    const raw = { ...named, get inputTokens(): number { reads += 1; if (reads > 1) throw new Error('host-private-text'); return 100 } }
    const normalizer = (response: unknown): unknown => ({ ...NORMALIZED, inputTokens: (response as typeof raw).inputTokens })
    const { run, args } = await callOf('metering.capture')
    args[3] = { provider: 'openai', normalizer, ratingMode: 'rate-table' }
    args[2] = raw
    expect(((await run(args)) as { inputTokens: number }).inputTokens).toBe(100)
    expect(reads).toBe(1)
  })

  it.each(['provider', 'operation'] as const)('names the %s of a usage under a host normalizer when it cannot be read', async (field) => {
    const { run, args } = await callOf('metering.capture')
    args[3] = { provider: 'openai', normalizer: (raw: unknown): unknown => raw, ratingMode: 'rate-table' }
    args[2] = Object.defineProperty({ provider: 'openai', operation: 'chat' }, field, { enumerable: true, get: (): never => { throw new Error('host-private-text') } })
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG usage.${field} could not be read`)
  })

  it('reads the provider and the operation of a normalized usage under a host normalizer once each', async () => {
    const reads = { provider: 0, operation: 0 }
    const counted = (field: 'provider' | 'operation'): PropertyDescriptor => ({ enumerable: true, get: (): unknown => { reads[field] += 1; return NORMALIZED[field] } })
    const usage = Object.defineProperties({ ...NORMALIZED }, { provider: counted('provider'), operation: counted('operation') })
    const { run, args } = await callOf('metering.capture')
    args[3] = { provider: 'openai', normalizer: (raw: unknown): unknown => raw, ratingMode: 'rate-table' }
    args[2] = usage
    expect(await reasonOf(() => run(args))).toBeUndefined()
    expect(reads).toEqual({ provider: 1, operation: 1 })
  })

  it('does not read a key another library added to Object.prototype as a field of a response, and bills a response as it is', async () => {
    const prototype = Object.prototype as Record<string, unknown>
    prototype.cached_tokens = 40
    try {
      const record = await recorded(providerPresets.openaiChat, { model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: {} } }, true)
      expect([record.cacheReadTokens, (record as unknown as { inputTokens: number }).inputTokens]).toEqual([0, 100])
    } finally {
      Reflect.deleteProperty(prototype, 'cached_tokens')
    }
  })

  it('tells the normalizers of the library from a normalizer of the host', () => {
    expect(isBuiltInNormalizer(providerPresets.anthropic.normalizer)).toBe(true)
    expect(isBuiltInNormalizer(providerPresets.openaiCompatible('deepseek').normalizer)).toBe(true)
    expect(isBuiltInNormalizer((raw) => raw as never)).toBe(false)
  })

  it('settles a capture whose normalized usage is a Proxy over an empty target', async () => {
    const { run, args } = await callOf('metering.capture')
    args[2] = lazy({ provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 })
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })
})

/** The reason of the typed refusal `read` raises, or `undefined` when it returns. */
function refusalOf(read: () => unknown): string | undefined {
  try {
    read()
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    return (error.getResponse() as { error: { details?: { reason?: string } } }).error.details?.reason
  }
  return undefined
}

describe('what a refusal of a read names', () => {
  it.each([
    ['metering.capture', [1], 'tenantId', 'caller.tenantId'],
    ['metering.release', [1], 'tenantId', 'caller.tenantId'],
    ['metering.capture', [3], 'provider', 'preset.provider'],
  ] as const)('names the field at %s %j when %s cannot be read', async (name, path, field, named) => {
    const { run, args } = await callOf(name)
    Object.defineProperty(at(args, path.slice(0, -1))[path.at(-1)!], field, { get: (): never => { throw new Error('host-private-text') } })
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG ${named} could not be read`)
  })

  it('names the content of a capture when a field of it cannot be read', async () => {
    const { run, args } = await callOf('metering.capture')
    args[4] = Object.defineProperty({}, 'prompt', { get: (): never => { throw new Error('host-private-text') } })
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG content.prompt could not be read')
  })

  it('does not list the keys of the scope of an estimate', async () => {
    const { run, args } = await callOf('metering.estimateCost')
    let listed = 0
    at(args, [0]).scope = new Proxy({ type: 'user', id: 'u' }, { ownKeys(target) { listed += 1; return Reflect.ownKeys(target) } })
    await reasonOf(() => run(args))
    expect(listed).toBe(0)
  })

  it('names the value that goes past the budget of values', () => {
    expect(refusalOf(() => readDeep(lists(Array.from({ length: 10 }, () => 100_000)), 'usage', 0, 64))).toBe('usage.l9[99989] could not be read')
  })

  it('names the value when a read has too many different lists and objects, too many keys, or contains itself', () => {
    expect(refusalOf(() => readDeep(Array.from({ length: 10_000 }, () => ({})), 'usage', 0, 64))).toBe('usage[9999] could not be read')
    expect(refusalOf(() => readDeep(Object.fromEntries(Array.from({ length: 100_001 }, (_, index) => [`k${String(index)}`, 0])), 'usage', 0, 64))).toBe('usage could not be read')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(refusalOf(() => readDeep(cyclic, 'usage', 0, 64))).toBe('usage.self could not be read')
  })
})

