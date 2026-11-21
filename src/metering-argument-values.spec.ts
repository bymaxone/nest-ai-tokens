/**
 * @fileoverview What the metering calls do with the arguments that take a hold: an estimate is read by the names of the variant it is,
 * a collector given to `capture()` is used as it is, and the usage of a call is read deeper than other arguments and never when it
 * contains itself.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { providerPresets } from './server/config/provider-presets'
import { AiTokensException } from './server/errors'
import { StreamUsageCollector } from './server/streaming/stream-usage-collector'
import { readDeep } from './server/utils/argument-guards'

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

  it('refuses an estimate whose has trap throws, naming the estimate', async () => {
    const { run, args } = await callOf('metering.hold')
    setAt(args, [1], new Proxy({}, { has: (): never => { throw new Error('host-private-text') } }))
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG estimate could not be read')
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
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG usage could not be read')
  })
})

describe('the usage a call reads once', () => {
  /** A value nested `levels` deep, as a provider response carries the JSON arguments of a tool call. */
  const nested = (levels: number): Record<string, unknown> => {
    let inner: Record<string, unknown> = { leaf: 1 }
    for (let level = 0; level < levels; level += 1) inner = { inner }
    return inner
  }

  it.each([['metering.record', [0, 'usage']], ['metering.capture', [2]]] as const)('is read at %s when a tool call nests 20 levels deep, and the call completes', async (name, path) => {
    const { run, args } = await callOf(name)
    const base = at(args, path.slice(0, -1))[path.at(-1)!] as Record<string, unknown>
    setAt(args, [...path], { ...base, content: [{ type: 'tool_use', input: nested(20) }] })
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })

  it.each([['metering.record', [0, 'usage']], ['metering.capture', [2]]] as const)('is refused at %s, naming the usage, when it nests deeper than 64 levels or contains itself', async (name, path) => {
    const { run, args } = await callOf(name)
    const base = at(args, path.slice(0, -1))[path.at(-1)!] as Record<string, unknown>
    setAt(args, [...path], { ...base, content: nested(70) })
    expect(await reasonOf(() => run(args))).toContain('could not be read')
    const cyclic: Record<string, unknown> = { ...base }
    cyclic.self = cyclic
    setAt(args, [...path], cyclic)
    expect(await reasonOf(() => run(args))).toContain('could not be read')
  })

  it('is refused when a list holds itself, and a value shared twice without a cycle is read', () => {
    const list: unknown[] = []
    list.push(list)
    expect(() => readDeep(list, 'list', 0, 64)).toThrow()
    const shared = { a: 1 }
    expect(readDeep({ x: shared, y: shared }, 'pair', 0, 64)).toEqual(expect.objectContaining({ x: { a: 1 }, y: { a: 1 } }))
  })

  it('refuses a value that shares a child between its branches 40 levels deep, fast, and still reads a large list', () => {
    let shared: unknown = { leaf: 1 }
    for (let level = 0; level < 40; level += 1) shared = { left: shared, right: shared }
    const started = Date.now()
    expect(() => readDeep(shared, 'usage', 0, 64)).toThrow()
    expect(Date.now() - started).toBeLessThan(5000)
    const embeddings = Array.from({ length: 100 }, () => ({ embedding: Array.from({ length: 3072 }, (_, index) => index) }))
    expect(readDeep({ data: embeddings }, 'usage', 0, 64)).toEqual(expect.objectContaining({ data: expect.any(Array) as unknown }))
  })

  it('reads exactly as many lists and objects as the budget holds, and refuses one more', () => {
    const objects = (count: number): unknown[] => Array.from({ length: count }, () => ({}))
    expect(() => readDeep(objects(9_999), 'usage', 0, 64)).not.toThrow()
    expect(() => readDeep(objects(10_000), 'usage', 0, 64)).toThrow()
  })

  it('reads exactly as many other values as the budget holds, and refuses one more', () => {
    const list = Array.from({ length: 100_000 }, () => 0)
    const shared = (count: number): Record<string, unknown> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`l${String(index)}`, list]))
    expect(() => readDeep(shared(10), 'usage', 0, 64)).not.toThrow()
    expect(() => readDeep(shared(11), 'usage', 0, 64)).toThrow()
  })
})
