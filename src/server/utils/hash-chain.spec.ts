import type { UsageRecord } from '../../shared'
import { chainHash } from './hash-chain'

/** Build a complete `UsageRecord`; `over` replaces any field under test. */
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
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

describe('chainHash', () => {
  /** A genesis hash (null prev) is a deterministic 64-char hex digest. */
  it('is deterministic for a genesis record', () => {
    const hash = chainHash(null, makeRecord())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(chainHash(null, makeRecord())).toBe(hash)
  })

  /** A different previous hash changes the result (chain linkage). */
  it('changes when the previous hash differs', () => {
    expect(chainHash('aaaa', makeRecord())).not.toBe(chainHash('bbbb', makeRecord()))
    expect(chainHash(null, makeRecord())).not.toBe(chainHash('bbbb', makeRecord()))
  })

  /** A different record id changes the result. */
  it('changes when the record id differs', () => {
    expect(chainHash(null, makeRecord({ id: 'rec-2' }))).not.toBe(chainHash(null, makeRecord()))
  })

  /** A change to a cost field changes the result (tamper evidence). */
  it('changes when a cost is tampered', () => {
    expect(chainHash(null, makeRecord({ billedCostNanoUsd: 24_100_001n }))).not.toBe(chainHash(null, makeRecord()))
  })

  /** Status and the reversal annotation are excluded, so the chain survives reversal. */
  it('is stable across the posted → reversed annotation', () => {
    const base = chainHash('prev', makeRecord())
    expect(chainHash('prev', makeRecord({ status: 'reversed', reversedByRecordId: 'rec-9' }))).toBe(base)
  })
})
