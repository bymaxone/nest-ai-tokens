import type { UsageRecord } from '../../shared'
import type { ITelemetrySink } from '../interfaces'
import { NO_OP_TELEMETRY } from './no-op-telemetry'
import { TelemetryEmitter, buildGenAiAttributes } from './otel-emitter'

/** A complete posted usage record. */
function record(over: Partial<UsageRecord> = {}): UsageRecord {
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

describe('buildGenAiAttributes', () => {
  /** The attribute set carries token counts, models, operation, provider, and tier. */
  it('builds the documented gen_ai.* attributes', () => {
    const attrs = buildGenAiAttributes(record({ requestedModel: 'gpt-5' }))
    expect(attrs).toEqual({
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5',
      'gen_ai.response.model': 'gpt-5-2026-03-14',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.service_tier': 'standard',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
    })
  })

  /** The request model defaults to the response model when none was requested. */
  it('defaults the request model to the response model', () => {
    expect(buildGenAiAttributes(record())['gen_ai.request.model']).toBe('gpt-5-2026-03-14')
  })

  /** No attribute value contains prompt/completion text. */
  it('captures no content', () => {
    const prompt = 'What is the capital of France?'
    const attrs = buildGenAiAttributes(record())
    for (const value of Object.values(attrs)) {
      expect(String(value)).not.toContain(prompt)
    }
  })
})

describe('TelemetryEmitter', () => {
  /** With a sink, recordUsage forwards the attributes and the record. */
  it('records usage through the sink', () => {
    const recordUsage = jest.fn()
    const emitter = new TelemetryEmitter({ recordUsage })
    const posted = record()
    emitter.recordUsage(posted)
    expect(recordUsage).toHaveBeenCalledWith(buildGenAiAttributes(posted), posted)
  })

  /** With a sink implementing recordDuration, the duration is forwarded. */
  it('records duration when the sink supports it', () => {
    const recordDuration = jest.fn()
    const emitter = new TelemetryEmitter({ recordUsage: jest.fn(), recordDuration })
    const posted = record()
    emitter.recordDuration(posted, 250)
    expect(recordDuration).toHaveBeenCalledWith(buildGenAiAttributes(posted), 250)
  })

  /** A sink without recordDuration ignores the duration call. */
  it('ignores duration when the sink omits recordDuration', () => {
    const sink: ITelemetrySink = { recordUsage: jest.fn() }
    expect(() => new TelemetryEmitter(sink).recordDuration(record(), 10)).not.toThrow()
  })

  /** A null sink is a no-op for both signals. */
  it('is a no-op without a sink', () => {
    expect(() => NO_OP_TELEMETRY.recordUsage(record())).not.toThrow()
    expect(() => NO_OP_TELEMETRY.recordDuration(record(), 10)).not.toThrow()
  })
})
