import type { AiTokensErrorResponse } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { AiTokensException } from '../errors'
import { LedgerService, type LedgerAppendInput } from './ledger.service'

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

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: AiTokensException): string {
  return (error.getResponse() as AiTokensErrorResponse).error.code
}

describe('LedgerService.append', () => {
  /** A first append stores the record and derives `totalTokens`. */
  it('appends a new record and sums totalTokens', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const record = await service.append(makeInput(), 'key-1')
    expect(record.id).toBeDefined()
    expect(record.idempotencyKey).toBe('key-1')
    expect(record.totalTokens).toBe(1500)
    expect(store.all()).toHaveLength(1)
  })

  /** A replay with the same key and same payload returns the identical record. */
  it('returns the identical record on a matching replay and writes nothing', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const first = await service.append(makeInput(), 'key-1')
    const replay = await service.append(makeInput(), 'key-1')
    expect(replay.id).toBe(first.id)
    expect(store.all()).toHaveLength(1)
  })

  /** The same key with a different payload is a 409 idempotency conflict. */
  it('throws AI_TOKENS_IDEMPOTENCY_CONFLICT on a payload mismatch', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    await service.append(makeInput(), 'key-1')
    const error = await service.append(makeInput({ inputTokens: 999 }), 'key-1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AiTokensException)
    expect(codeOf(error as AiTokensException)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
    expect((error as AiTokensException).getStatus()).toBe(409)
  })

  /** Without a key, each call writes a distinct record (no dedupe). */
  it('generates a random key when none is supplied, disabling dedupe', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const a = await service.append(makeInput())
    const b = await service.append(makeInput())
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey)
    expect(store.all()).toHaveLength(2)
  })

  /** A non-conflict store error propagates unchanged. */
  it('rethrows a non-conflict store error', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    jest.spyOn(store, 'append').mockRejectedValue(new Error('db down'))
    await expect(service.append(makeInput(), 'key-1')).rejects.toThrow('db down')
  })
})

describe('LedgerService.findByIdempotencyKey', () => {
  /** A stored record is found by tenant + key; a miss returns null. */
  it('finds a stored record and returns null on a miss', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    await service.append(makeInput(), 'key-1')
    expect(await service.findByIdempotencyKey('tenant-1', 'key-1')).not.toBeNull()
    expect(await service.findByIdempotencyKey('tenant-1', 'absent')).toBeNull()
  })
})

describe('LedgerService.query', () => {
  /** Seed a diverse fixture used by the filter matrix. */
  async function seedFixture(): Promise<{ store: InMemoryLedgerStore; service: LedgerService }> {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    await service.append(
      makeInput({
        scope: { type: 'user', id: 'u1' },
        beneficiary: { type: 'user', id: 'client-1' },
        feature: 'chat.reply',
        provider: 'openai',
        model: 'gpt-5',
        operation: 'chat',
        serviceTier: 'standard',
        tags: ['team:research'],
        enforced: true,
        occurredAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      'k1',
    )
    await service.append(
      makeInput({
        scope: { type: 'user', id: 'u2' },
        feature: 'chat.summarize',
        provider: 'anthropic',
        model: 'claude',
        operation: 'chat',
        serviceTier: 'batch',
        tags: ['team:ops'],
        isSystemCost: true,
        systemCostCategory: 'retry',
        occurredAt: new Date('2026-06-05T00:00:00.000Z'),
      }),
      'k2',
    )
    await service.append(
      makeInput({ feature: 'chat.reply', status: 'released', occurredAt: new Date('2026-06-10T00:00:00.000Z') }),
      'k3',
    )
    return { store, service }
  }

  /** Every `LedgerFilter` field narrows the result set as documented. */
  it('honors every filter field', async () => {
    const { service } = await seedFixture()
    expect(await service.query({ tenantId: 'other' })).toHaveLength(0)
    expect(await service.query({ tenantId: 'tenant-1', scope: { type: 'user', id: 'u2' } })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', beneficiary: { type: 'user', id: 'client-1' } })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', feature: 'chat.summarize' })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', features: ['chat.reply', 'chat.summarize'] })).toHaveLength(2)
    expect(await service.query({ tenantId: 'tenant-1', provider: 'anthropic' })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', model: 'gpt-5' })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', operation: 'chat' })).toHaveLength(2)
    expect(await service.query({ tenantId: 'tenant-1', serviceTier: 'batch' })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', tags: ['team:research'] })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', isSystemCost: true })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', systemCostCategory: 'retry' })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', enforcedOnly: true })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', from: new Date('2026-06-04T00:00:00.000Z') })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', to: new Date('2026-06-02T00:00:00.000Z') })).toHaveLength(1)
  })

  /** With no status filter, only posted/reversed records are returned (§8.3). */
  it('defaults the status filter to posted + reversed', async () => {
    const { service } = await seedFixture()
    expect(await service.query({ tenantId: 'tenant-1' })).toHaveLength(2)
  })

  /** An explicit status filter overrides the default. */
  it('honors an explicit status filter', async () => {
    const { service } = await seedFixture()
    expect(await service.query({ tenantId: 'tenant-1', status: ['released'] })).toHaveLength(1)
  })

  /** Offset and limit paginate the matched set. */
  it('paginates with offset and limit', async () => {
    const { service } = await seedFixture()
    expect(await service.query({ tenantId: 'tenant-1', status: ['posted'], limit: 1 })).toHaveLength(1)
    expect(await service.query({ tenantId: 'tenant-1', status: ['posted'], offset: 2 })).toHaveLength(0)
  })
})

describe('LedgerService.sumCost', () => {
  /** Totals cover posted + reversed only and match the hand-computed sums. */
  it('aggregates posted and reversed records by default', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    await service.append(makeInput({ rawCostNanoUsd: 100n, billedCostNanoUsd: 400n, surchargeNanoUsd: 10n }), 'k1')
    await service.append(
      makeInput({ status: 'reversed', rawCostNanoUsd: 30n, billedCostNanoUsd: 120n, surchargeNanoUsd: 3n }),
      'k2',
    )
    await service.append(
      makeInput({ status: 'released', rawCostNanoUsd: 999n, billedCostNanoUsd: 999n, surchargeNanoUsd: 999n }),
      'k3',
    )
    const summary = await service.sumCost({ tenantId: 'tenant-1' })
    expect(summary.rawCostNanoUsd).toBe(130n)
    expect(summary.billedCostNanoUsd).toBe(520n)
    expect(summary.surchargeNanoUsd).toBe(13n)
    expect(summary.totalTokens).toBe(3000)
    expect(summary.records).toBe(2)
  })
})
