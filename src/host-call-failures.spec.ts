/**
 * @fileoverview What happens when the host's own code fails inside an operation that has already done its work. A telemetry sink that
 * throws, returns a rejecting promise or a thenable whose `then` throws, and an `onThrottle` callback that does the same, must not end
 * the call or leave a rejection nobody handles: the failure is one log line with the error's name and never its message, and the
 * operation goes on. The sweep below runs each hostile shape through each host entry point.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { UsageRecord } from './shared'
import type { ITelemetrySink } from './server/interfaces'
import { TelemetryEmitter } from './server/telemetry/otel-emitter'
import { budgetInput, context, makeService } from '../test/fakes/budget-fixtures'

const SECRET = 'host-private-text'
const SINK_LINE = 'ai_tokens.telemetry.sink_failed'
const THROTTLE_LINE = 'ai_tokens.budget.on_throttle_failed'

/** The hostile ways a host function can fail, each as a function that fails when it is called. */
const FAILURES: readonly (readonly [string, () => unknown, string])[] = [
  ['throws', (): never => { throw new Error(SECRET) }, 'name=Error'],
  ['returns a rejecting promise', (): unknown => Promise.reject(new Error(SECRET)), 'name=Error'],
  ['returns a thenable whose then throws', (): unknown => ({ then: (): never => { throw new Error(SECRET) } }), 'name=Error'],
  ['returns a thenable that rejects', (): unknown => ({ then: (_ok: unknown, no: (error: unknown) => void): void => no(new Error(SECRET)) }), 'name=Error'],
  ['returns a thenable that rejects with a value that is not an Error', (): unknown => ({ then: (_ok: unknown, no: (error: unknown) => void): void => no(SECRET) }), 'non-Error rejection'],
  ['returns a value whose then getter throws', (): unknown => Object.defineProperty({}, 'then', { get: (): never => { throw new Error(SECRET) } }), 'name=Error'],
]

/** A complete posted usage record. */
function completeRecord(over: Partial<UsageRecord> = {}): UsageRecord {
  const now = new Date('2026-06-01T00:00:00.000Z')
  return {
    id: 'rec-1',
    tenantId: 'tenant-1',
    scope: { type: 'user', id: 'u1' },
    provider: 'openai',
    model: 'gpt-5-2026-03-14',
    operation: 'chat',
    serviceTier: 'standard',
    feature: 'chat.reply',
    tags: [],
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
    totalTokens: 1500,
    priceVersionId: 'price-1',
    rawCostNanoUsd: 6_250_000n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 6_250_000n,
    markupMultiplier: 1,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    idempotencyKey: 'key-1',
    isSystemCost: false,
    enforced: false,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

const record = completeRecord()

/** Errors a host can throw whose own reads throw: a describing line must survive them. */
const HOSTILE_ERRORS: readonly (readonly [string, () => unknown])[] = [
  ['an error whose code getter throws', (): unknown => Object.defineProperty(new Error('x'), 'code', { get: (): never => { throw new Error(SECRET) } })],
  ['an error whose name getter throws', (): unknown => Object.defineProperty(new Error('x'), 'name', { get: (): never => { throw new Error(SECRET) } })],
  ['a Proxy whose prototype read throws', (): unknown => new Proxy(new Error('x'), { getPrototypeOf: (): never => { throw new Error(SECRET) } })],
]


let warned: string[] = []

beforeEach(() => {
  warned = []
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((line: unknown) => {
    warned.push(String(line))
  })
})
afterEach(() => {
  jest.restoreAllMocks()
})

/** Let a rejected promise's handlers run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('a telemetry sink that fails', () => {
  it.each(FAILURES)('does not fail recordUsage or recordDuration when it %s, and logs the description of the error only', async (_label, fail, described) => {
    const sink = { recordUsage: fail, recordDuration: fail } as unknown as ITelemetrySink
    const emitter = new TelemetryEmitter(sink)
    expect(() => { emitter.recordUsage(record) }).not.toThrow()
    expect(() => { emitter.recordDuration(record, 5) }).not.toThrow()
    await settle()
    expect(warned).toHaveLength(2)
    expect(warned).toEqual([`${SINK_LINE} ${described}`, `${SINK_LINE} ${described}`])
  })

  it('does not fail when the method itself cannot be read', async () => {
    const sink = Object.defineProperty({}, 'recordUsage', { get: (): never => { throw new Error(SECRET) } }) as unknown as ITelemetrySink
    expect(() => { new TelemetryEmitter(sink).recordUsage(record) }).not.toThrow()
    expect(warned).toHaveLength(1)
    expect(warned[0]).not.toContain(SECRET)
  })

  it('calls a sink that works, with the sink as this, and logs nothing', () => {
    const calls: string[] = []
    const sink = { tag: 'sink', recordUsage(this: { tag: string }): void { calls.push(this.tag) } } as unknown as ITelemetrySink
    new TelemetryEmitter(sink).recordUsage(record)
    expect(calls).toEqual(['sink'])
    expect(warned).toEqual([])
  })
})

describe('an onThrottle callback that fails', () => {
  it.each(FAILURES)('does not fail the consume that throttles when it %s, and the spend is kept', async (_label, fail, described) => {
    const { service, store } = makeService({ options: { onThrottle: fail as never } })
    const budget = await service.upsertBudget(budgetInput({ policy: 'throttle', limitNanoUsd: 100n }))
    await expect(service.consume(context(), { nanoUsd: 150n, tokens: 0, count: 1 })).resolves.toBeUndefined()
    await settle()
    expect(warned.filter((line) => line.startsWith(THROTTLE_LINE))).toEqual([`${THROTTLE_LINE} ${described}`])
    expect(warned.join('\n')).not.toContain(SECRET)
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(150n)
  })
})

describe('a host error that cannot be read', () => {
  it.each(HOSTILE_ERRORS)('is absorbed by a sink that throws %s, and by one that rejects with it', async (_label, make) => {
    const failure = make()
    const throws = { recordUsage: (): never => { throw failure } } as unknown as ITelemetrySink
    const rejects = { recordUsage: (): unknown => ({ then: (_ok: unknown, no: (error: unknown) => void): void => { no(failure) } }) } as unknown as ITelemetrySink
    expect(() => { new TelemetryEmitter(throws).recordUsage(record) }).not.toThrow()
    expect(() => { new TelemetryEmitter(rejects).recordUsage(record) }).not.toThrow()
    await settle()
    expect(warned).toEqual([`${SINK_LINE} unreadable error`, `${SINK_LINE} unreadable error`])
  })

  it.each(HOSTILE_ERRORS)('is absorbed by an onThrottle callback that throws %s', async (_label, make) => {
    const failure = make()
    const { service } = makeService({ options: { onThrottle: (): never => { throw failure } } })
    await service.upsertBudget(budgetInput({ policy: 'throttle', limitNanoUsd: 100n }))
    await expect(service.consume(context(), { nanoUsd: 150n, tokens: 0, count: 1 })).resolves.toBeUndefined()
    expect(warned.filter((line) => line.startsWith(THROTTLE_LINE))).toEqual([`${THROTTLE_LINE} unreadable error`])
  })

  it('does not fail recordDuration when the method getter throws, and calls nothing when the method is left out', () => {
    const unreadable = Object.defineProperty({ recordUsage: (): void => undefined }, 'recordDuration', { get: (): never => { throw new Error(SECRET) } }) as unknown as ITelemetrySink
    expect(() => { new TelemetryEmitter(unreadable).recordDuration(record, 5) }).not.toThrow()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toBe(`${SINK_LINE} name=Error`)
    const withoutDuration: ITelemetrySink = { recordUsage: (): void => undefined }
    expect(() => { new TelemetryEmitter(withoutDuration).recordDuration(record, 5) }).not.toThrow()
    expect(warned).toHaveLength(1)
  })
})
