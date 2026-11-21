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
const FAILURES: readonly (readonly [string, () => unknown])[] = [
  ['throws', (): never => { throw new Error(SECRET) }],
  ['returns a rejecting promise', (): unknown => Promise.reject(new Error(SECRET))],
  ['returns a thenable whose then throws', (): unknown => ({ then: (): never => { throw new Error(SECRET) } })],
  ['returns a thenable that rejects', (): unknown => ({ then: (_ok: unknown, no: (error: unknown) => void): void => no(new Error(SECRET)) })],
  ['returns a thenable that rejects with a value that is not an Error', (): unknown => ({ then: (_ok: unknown, no: (error: unknown) => void): void => no(SECRET) })],
  ['returns a value whose then getter throws', (): unknown => Object.defineProperty({}, 'then', { get: (): never => { throw new Error(SECRET) } })],
]

const record = { id: 'r1', provider: 'openai', model: 'gpt-4o', operation: 'chat', serviceTier: 'standard', inputTokens: 1, outputTokens: 1 } as unknown as UsageRecord

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
  it.each(FAILURES)('does not fail recordUsage or recordDuration when it %s, and logs the name only', async (_label, fail) => {
    const sink = { recordUsage: fail, recordDuration: fail } as unknown as ITelemetrySink
    const emitter = new TelemetryEmitter(sink)
    expect(() => { emitter.recordUsage(record) }).not.toThrow()
    expect(() => { emitter.recordDuration(record, 5) }).not.toThrow()
    await settle()
    expect(warned).toHaveLength(2)
    for (const line of warned) {
      expect(line.startsWith(SINK_LINE)).toBe(true)
      expect(line).not.toContain(SECRET)
    }
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
  it.each(FAILURES)('does not fail the consume that throttles when it %s, and the spend is kept', async (_label, fail) => {
    const { service, store } = makeService({ options: { onThrottle: fail as never } })
    const budget = await service.upsertBudget(budgetInput({ policy: 'throttle', limitNanoUsd: 100n }))
    await expect(service.consume(context(), { nanoUsd: 150n, tokens: 0, count: 1 })).resolves.toBeUndefined()
    await settle()
    expect(warned.filter((line) => line.startsWith(THROTTLE_LINE))).toHaveLength(1)
    expect(warned.join('\n')).not.toContain(SECRET)
    expect((await store.getWindow(budget.id, new Date('2026-06-01T00:00:00.000Z')))?.spentNanoUsd).toBe(150n)
  })
})
