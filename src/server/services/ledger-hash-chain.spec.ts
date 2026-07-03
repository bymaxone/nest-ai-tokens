import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { LedgerService, type LedgerAppendInput, type LedgerAuditHook } from './ledger.service'

/** Build a `LedgerAppendInput`; `over` replaces any field under test. */
function makeInput(over: Partial<LedgerAppendInput> = {}): LedgerAppendInput {
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
    priceVersionId: 'price-1',
    rawCostNanoUsd: 6_025_000n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 24_100_000n,
    markupMultiplier: 4,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    isSystemCost: false,
    enforced: false,
    occurredAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  }
}

/** Construct a ledger service with the chain flag set and an optional audit hook. */
function makeService(store: InMemoryLedgerStore, hashChain: boolean, audit?: LedgerAuditHook): LedgerService {
  return new LedgerService(store, { ledger: { hashChain } }, audit)
}

describe('LedgerService hash chain', () => {
  /** Disabled by default: no chain lookup, no hashes written. */
  it('computes nothing when the chain is disabled', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const a = await service.append(makeInput(), 'a')
    const b = await service.append(makeInput({ inputTokens: 5 }), 'b')
    expect(store.lastHashCalls).toBe(0)
    expect(a.hash).toBeUndefined()
    expect(b.hash).toBeUndefined()
  })

  /** Enabled: record → settle → reverse produces a verifiable chain, audited. */
  it('verifies a chain spanning record, settle, and reverse', async () => {
    const store = new InMemoryLedgerStore()
    const audit = jest.fn()
    const service = makeService(store, true, audit)

    const original = await service.append(makeInput(), 'a')
    expect(original.hash).toBeDefined()

    const hold = await service.append(makeInput({ status: 'pending' }), 'h')
    await service.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 5n })

    await service.reverse(original.id, 'refund')

    const result = await service.verifyChain('tenant-1')
    expect(result).toEqual({ valid: true })
    expect(audit).toHaveBeenCalledWith('ai_tokens.chain.verified', { tenantId: 'tenant-1', valid: true })
  })

  /** Tampering any posted row makes verifyChain report exactly that row. */
  it('detects a tampered posted row', async () => {
    const store = new InMemoryLedgerStore()
    const audit = jest.fn()
    const service = makeService(store, true, audit)

    await service.append(makeInput(), 'a')
    const b = await service.append(makeInput({ inputTokens: 5 }), 'b')
    await service.append(makeInput({ inputTokens: 9 }), 'c')

    b.billedCostNanoUsd = 999_999_999n

    const result = await service.verifyChain('tenant-1')
    expect(result).toEqual({ valid: false, brokenAtRecordId: b.id })
    expect(audit).toHaveBeenCalledWith('ai_tokens.chain.verified', {
      tenantId: 'tenant-1',
      valid: false,
      brokenAtRecordId: b.id,
    })
  })

  /** A pending hold is excluded from the chain; settling it keeps the chain valid. */
  it('excludes pending holds and stays valid after settlement', async () => {
    const store = new InMemoryLedgerStore()
    const service = makeService(store, true)

    await service.append(makeInput(), 'a')
    const hold = await service.append(makeInput({ status: 'pending' }), 'h')
    expect(hold.hash).toBeUndefined()
    expect((await service.verifyChain('tenant-1')).valid).toBe(true)

    await service.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 5n })
    expect((await service.verifyChain('tenant-1')).valid).toBe(true)
  })

  /** verifyChain honors the occurredAt range bounds and self-verifies each in-range row. */
  it('honors the from/to range bounds', async () => {
    const store = new InMemoryLedgerStore()
    const service = makeService(store, true)
    await service.append(makeInput({ occurredAt: new Date('2026-06-01T00:00:00.000Z') }), 'a')
    await service.append(makeInput({ occurredAt: new Date('2026-06-10T00:00:00.000Z') }), 'b')
    expect((await service.verifyChain('tenant-1', new Date('2026-06-05T00:00:00.000Z'))).valid).toBe(true)
    expect((await service.verifyChain('tenant-1', undefined, new Date('2026-06-05T00:00:00.000Z'))).valid).toBe(true)
  })
})
