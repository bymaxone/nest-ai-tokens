import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import type { UsageRecord } from '../../shared'
import { chainHash, verifyChainRecords } from '../utils/hash-chain'
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
    expect(result).toMatchObject({ valid: true, unchainedCount: 0, chainStartsAtRecordId: original.id })
    expect(audit).toHaveBeenCalledWith('ai_tokens.chain.verified', { tenantId: 'tenant-1', valid: true, unchainedCount: 0 })
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
    expect(result).toEqual({ valid: false, brokenAtRecordId: b.id, unchainedCount: 0 })
    expect(audit).toHaveBeenCalledWith('ai_tokens.chain.verified', {
      tenantId: 'tenant-1',
      valid: false,
      unchainedCount: 0,
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

/** Remove optional chain fields from a stored record, as an attacker with write access would. */
function strip(record: UsageRecord, ...fields: ('hash' | 'prevHash')[]): void {
  if (fields.includes('hash')) delete record.hash
  if (fields.includes('prevHash')) delete record.prevHash
}

describe('LedgerService hash chain over a mixed ledger', () => {
  /** Rows written before the chain was enabled are counted as unchained; the chain verifies from its genesis. */
  it('reports rows from before enablement as unchained and starts the chain at the first hashed row', async () => {
    const store = new InMemoryLedgerStore()
    const off = makeService(store, false)
    await off.append(makeInput(), 'old1')
    await off.append(makeInput({ inputTokens: 2 }), 'old2')
    const on = makeService(store, true)
    const new1 = await on.append(makeInput({ inputTokens: 3 }), 'new1')
    await on.append(makeInput({ inputTokens: 4 }), 'new2')
    expect(await on.verifyChain('tenant-1')).toEqual({ valid: true, unchainedCount: 2, chainStartsAtRecordId: new1.id })
  })

  /** A hold created before a record that settled first sits ahead of it in the listing yet links to it: still valid. */
  it('follows the links, not the creation order', async () => {
    const store = new InMemoryLedgerStore()
    const service = makeService(store, true)
    const hold = await service.append(makeInput({ status: 'pending' }), 'hold')
    const quick = await service.append(makeInput({ inputTokens: 7 }), 'quick')
    await service.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 5n })
    expect(await service.verifyChain('tenant-1')).toEqual({ valid: true, unchainedCount: 0, chainStartsAtRecordId: quick.id })
  })

  /** Removing a chained row's hash but keeping its link is the downgrade attempt: broken at that row. */
  it('flags a post-genesis row whose hash was removed', async () => {
    const store = new InMemoryLedgerStore()
    const service = makeService(store, true)
    await service.append(makeInput(), 'a')
    const b = await service.append(makeInput({ inputTokens: 5 }), 'b')
    await service.append(makeInput({ inputTokens: 9 }), 'c')
    strip(b, 'hash')
    expect(await service.verifyChain('tenant-1')).toEqual({ valid: false, brokenAtRecordId: b.id, unchainedCount: 1 })
  })

  /** Removing the hash and the link of a middle row leaves its successor pointing at nothing: broken at the successor. */
  it('flags the successor of a middle row stripped of hash and link', async () => {
    const store = new InMemoryLedgerStore()
    const service = makeService(store, true)
    await service.append(makeInput(), 'a')
    const b = await service.append(makeInput({ inputTokens: 5 }), 'b')
    const c = await service.append(makeInput({ inputTokens: 9 }), 'c')
    strip(b, 'hash', 'prevHash')
    expect(await service.verifyChain('tenant-1')).toEqual({ valid: false, brokenAtRecordId: c.id, unchainedCount: 1 })
  })

  /** Changing a chained row's content after the fact still breaks at that row. */
  it('flags a post-genesis payload change', async () => {
    const store = new InMemoryLedgerStore()
    const service = makeService(store, true)
    await service.append(makeInput(), 'a')
    const b = await service.append(makeInput({ inputTokens: 5 }), 'b')
    b.inputTokens = 6
    expect(await service.verifyChain('tenant-1')).toEqual({ valid: false, brokenAtRecordId: b.id, unchainedCount: 0 })
  })

  /** Settled rows with no hash at all mean the chain was never enabled, which is not tampering. */
  it('reports a ledger with no hashed row as never enabled', async () => {
    const store = new InMemoryLedgerStore()
    const audit = jest.fn()
    const service = makeService(store, false, audit)
    await service.append(makeInput(), 'a')
    await service.append(makeInput({ inputTokens: 2 }), 'b')
    expect(await service.verifyChain('tenant-1')).toEqual({ valid: false, status: 'never-enabled', unchainedCount: 2 })
    expect(audit).toHaveBeenCalledWith('ai_tokens.chain.verified', {
      tenantId: 'tenant-1',
      valid: false,
      unchainedCount: 2,
      status: 'never-enabled',
    })
  })

  /** A tenant with no settled record has nothing to verify and nothing unchained. */
  it('treats a tenant without settled records as valid', async () => {
    const service = makeService(new InMemoryLedgerStore(), true)
    expect(await service.verifyChain('tenant-1')).toEqual({ valid: true, unchainedCount: 0 })
  })

  /** A window that starts mid-chain checks each row's own hash and claims no genesis. */
  it('verifies a window that starts mid-chain without a genesis', async () => {
    const store = new InMemoryLedgerStore()
    const service = makeService(store, true)
    await service.append(makeInput({ occurredAt: new Date('2026-06-01T00:00:00.000Z') }), 'a')
    await service.append(makeInput({ inputTokens: 5, occurredAt: new Date('2026-06-10T00:00:00.000Z') }), 'b')
    await service.append(makeInput({ inputTokens: 9, occurredAt: new Date('2026-06-20T00:00:00.000Z') }), 'c')
    expect(await service.verifyChain('tenant-1', new Date('2026-06-05T00:00:00.000Z'))).toEqual({ valid: true, unchainedCount: 0 })
  })
})

describe('verifyChainRecords structure', () => {
  /** Build three chained records a -> b -> c through a real service so their hashes are genuine. */
  async function chained(): Promise<[UsageRecord, UsageRecord, UsageRecord]> {
    const service = makeService(new InMemoryLedgerStore(), true)
    const a = await service.append(makeInput(), 'a')
    const b = await service.append(makeInput({ inputTokens: 5 }), 'b')
    const c = await service.append(makeInput({ inputTokens: 9 }), 'c')
    return [a, b, c]
  }

  /** Deleting a record that no other record names as its predecessor goes unnoticed: here the settled hold. Pins the documented limit. */
  it('does not notice a deleted record that no other record links to', async () => {
    const service = makeService(new InMemoryLedgerStore(), true)
    const hold = await service.append(makeInput({ status: 'pending' }), 'hold')
    const quick = await service.append(makeInput({ inputTokens: 7 }), 'quick')
    await service.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 5n })
    const next = await service.append(makeInput({ inputTokens: 8 }), 'next')
    const settledHold = (await service.query({ tenantId: 'tenant-1', status: ['posted'] })).find((record) => record.id === hold.id)
    expect(settledHold?.prevHash).toBe(quick.hash)
    expect(next.prevHash).toBe(quick.hash)
    // The hold is deleted: no remaining record names it, so the rest still verifies.
    expect(verifyChainRecords([quick, next], true)).toEqual({ valid: true, unchainedCount: 0, chainStartsAtRecordId: quick.id })
  })

  /** A hold that settles after a later record links to the same predecessor as the next record; that is normal, not a fork. */
  it('accepts two records that share a predecessor', async () => {
    const [a, b] = await chained()
    const sibling = { ...b, id: 'sibling', hash: chainHash(a.hash ?? null, { ...b, id: 'sibling' }) }
    expect(verifyChainRecords([a, b, sibling], true)).toEqual({ valid: true, unchainedCount: 0, chainStartsAtRecordId: a.id })
  })

  /** Without its first rows the earliest hashed row has no genesis: its predecessor is missing. */
  it('flags a chain whose first rows are missing', async () => {
    const [, b, c] = await chained()
    expect(verifyChainRecords([b, c], true)).toEqual({ valid: false, brokenAtRecordId: b.id, unchainedCount: 0 })
  })

  /** A second row with no predecessor is a second chain start: broken at it. */
  it('flags a second chain start', async () => {
    const [a, b] = await chained()
    const other = { ...b, id: 'other', hash: chainHash(null, { ...b, id: 'other' }) }
    delete other.prevHash
    expect(verifyChainRecords([a, other], true)).toEqual({ valid: false, brokenAtRecordId: 'other', unchainedCount: 0 })
  })

  /** A gap inside a bounded call is not flagged: the window may have cut the chain, only each row's hash counts. */
  it('skips the structural rules for a bounded call', async () => {
    const [a, , c] = await chained()
    expect(verifyChainRecords([a, c], true)).toEqual({ valid: false, brokenAtRecordId: c.id, unchainedCount: 0 })
    expect(verifyChainRecords([a, c], false)).toEqual({ valid: true, unchainedCount: 0, chainStartsAtRecordId: a.id })
  })
})
