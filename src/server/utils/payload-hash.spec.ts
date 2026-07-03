import type { NewUsageRecord } from '../../shared'
import { computePayloadHash } from './payload-hash'

/** Build a complete `NewUsageRecord`; `over` replaces any field under test. */
function makeRecord(over: Partial<NewUsageRecord> = {}): NewUsageRecord {
  return {
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
    rawCostNanoUsd: 6_025_000n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 24_100_000n,
    markupMultiplier: 4,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    idempotencyKey: 'key-1',
    isSystemCost: false,
    enforced: false,
    occurredAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  }
}

describe('computePayloadHash', () => {
  /** Identical metered content yields an identical, 64-char hex digest. */
  it('is stable for identical content', () => {
    const hash = computePayloadHash(makeRecord())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(computePayloadHash(makeRecord())).toBe(hash)
  })

  /** The idempotency key itself is excluded, so it never changes the hash. */
  it('ignores the idempotency key', () => {
    expect(computePayloadHash(makeRecord({ idempotencyKey: 'key-A' }))).toBe(
      computePayloadHash(makeRecord({ idempotencyKey: 'key-B' })),
    )
  })

  /** Lifecycle/annotation fields are excluded, so settlement never re-hashes. */
  it('ignores status and the reversal annotation', () => {
    const base = computePayloadHash(makeRecord())
    expect(computePayloadHash(makeRecord({ status: 'pending' }))).toBe(base)
    expect(computePayloadHash(makeRecord({ reversedByRecordId: 'rec-9' }))).toBe(base)
  })

  /** A different token count changes the hash. */
  it('changes when a token count differs', () => {
    expect(computePayloadHash(makeRecord({ inputTokens: 1001 }))).not.toBe(computePayloadHash(makeRecord()))
  })

  /** A different bigint cost changes the hash (bigint fields participate). */
  it('changes when a cost differs', () => {
    expect(computePayloadHash(makeRecord({ billedCostNanoUsd: 24_100_001n }))).not.toBe(
      computePayloadHash(makeRecord()),
    )
  })

  /** A different occurredAt changes the hash. */
  it('changes when occurredAt differs', () => {
    expect(computePayloadHash(makeRecord({ occurredAt: new Date('2026-06-02T00:00:00.000Z') }))).not.toBe(
      computePayloadHash(makeRecord()),
    )
  })
})
