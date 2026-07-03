import type { UsageRecord } from '../../shared'
import type { EventDispatcher } from './event-dispatcher'
import { createLedgerAuditHook, createMeteringEventHooks } from './event-hooks'

/** Build a complete settled `UsageRecord`. */
function makeRecord(over: Partial<UsageRecord> = {}): UsageRecord {
  const now = new Date('2026-06-01T00:00:00.000Z')
  return {
    id: 'rec-1',
    tenantId: 'tenant-1',
    scope: { type: 'user', id: 'u1' },
    provider: 'openai',
    model: 'gpt-5',
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
    billedCostNanoUsd: 25_000_000n,
    markupMultiplier: 4,
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

describe('createMeteringEventHooks', () => {
  /** usageRecorded maps the record to the documented usage.recorded payload. */
  it('emits usage.recorded with the documented payload', async () => {
    const emit = jest.fn(() => Promise.resolve())
    const hooks = createMeteringEventHooks({ emit } as unknown as EventDispatcher)
    const record = makeRecord()
    await hooks.usageRecorded(record)
    expect(emit).toHaveBeenCalledWith('ai_tokens.usage.recorded', 'tenant-1', record.scope, {
      usageRecordId: 'rec-1',
      feature: 'chat.reply',
      provider: 'openai',
      model: 'gpt-5',
      serviceTier: 'standard',
      totalTokens: 1500,
      rawCostNanoUsd: 6_250_000n,
      billedCostNanoUsd: 25_000_000n,
      enforced: false,
      isSystemCost: false,
    })
  })

  /** priceMissing maps the record to the documented price.missing payload. */
  it('emits price.missing with the documented payload', async () => {
    const emit = jest.fn(() => Promise.resolve())
    const hooks = createMeteringEventHooks({ emit } as unknown as EventDispatcher)
    await hooks.priceMissing(makeRecord({ id: 'rec-9', priceMissing: true }))
    expect(emit).toHaveBeenCalledWith('ai_tokens.price.missing', 'tenant-1', expect.anything(), {
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      serviceTier: 'standard',
      usageRecordId: 'rec-9',
    })
  })
})

describe('createLedgerAuditHook', () => {
  /** The audit hook forwards the action + details to the dispatcher. */
  it('forwards a chain-verification audit', () => {
    const audit = jest.fn(() => Promise.resolve())
    createLedgerAuditHook({ audit } as unknown as EventDispatcher)('ai_tokens.chain.verified', {
      tenantId: 't1',
      valid: true,
    })
    expect(audit).toHaveBeenCalledWith('ai_tokens.chain.verified', { tenantId: 't1', valid: true })
  })
})
