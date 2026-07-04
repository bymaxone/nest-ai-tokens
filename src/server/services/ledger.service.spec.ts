import fc from 'fast-check'
import type { AiTokensErrorResponse, UsageStatus } from '../../shared'
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

/** Assert a promise rejects with a 409 idempotency conflict. */
async function expectConflict(promise: Promise<unknown>): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AiTokensException)
  expect(codeOf(error as AiTokensException)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
  expect((error as AiTokensException).getStatus()).toBe(409)
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

  /** totalTokens is the exact sum of all 10 token categories — kills every ArithmeticOperator mutation on the sumTokens formula. */
  it('sums all 10 token categories into totalTokens', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const record = await service.append(
      makeInput({
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 10,
        cacheWrite5mTokens: 20,
        cacheWrite1hTokens: 30,
        reasoningTokens: 40,
        audioInTokens: 50,
        audioOutTokens: 60,
        imageInTokens: 70,
        imageOutTokens: 80,
      }),
      'sum-key',
    )
    // 100+200+10+20+30+40+50+60+70+80 = 660
    expect(record.totalTokens).toBe(660)
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

describe('LedgerService.findById', () => {
  /** A stored record is found by its global id; a miss returns null. */
  it('finds a stored record by id and returns null on a miss', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const record = await service.append(makeInput(), 'key-1')
    expect((await service.findById(record.id))?.id).toBe(record.id)
    expect(await service.findById('absent')).toBeNull()
  })
})

describe('LedgerService.findExpiredHolds', () => {
  /** Pending records older than the cutoff are returned, bounded by the limit. */
  it('returns expired pending holds up to the limit', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    await service.append(makeInput({ status: 'pending' }), 'h1')
    await service.append(makeInput({ status: 'pending' }), 'h2')
    await service.append(makeInput({ status: 'posted' }), 'p1')
    const expired = await service.findExpiredHolds(new Date(Date.now() + 60_000), 10)
    expect(expired).toHaveLength(2)
    expect(await service.findExpiredHolds(new Date(Date.now() + 60_000), 1)).toHaveLength(1)
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

describe('LedgerService.transition', () => {
  /** Append a record in `status` and return the service + stored record. */
  async function appendWith(
    status: UsageStatus,
    over: Partial<LedgerAppendInput> = {},
  ): Promise<{ store: InMemoryLedgerStore; service: LedgerService; record: Awaited<ReturnType<LedgerService['append']>> }> {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const record = await service.append(makeInput({ status, ...over }), 'k')
    return { store, service, record }
  }

  /** pending → posted settles the hold with actual amounts. */
  it('settles a hold with actual amounts', async () => {
    const { service, record } = await appendWith('pending')
    const settled = await service.transition(record.id, 'pending', 'posted', { billedCostNanoUsd: 42n })
    expect(settled?.status).toBe('posted')
    expect(settled?.billedCostNanoUsd).toBe(42n)
  })

  /** pending → posted with the full settlement whitelist (amounts, pricing, reversal linkage) applies every field. */
  it('settles with the entire settlement whitelist', async () => {
    const { service, record } = await appendWith('pending')
    const settled = await service.transition(record.id, 'pending', 'posted', {
      inputTokens: 42,
      billedCostNanoUsd: 99n,
      priceVersionId: 'pv-settled',
      priceMissing: false,
      markupMultiplier: 2,
      reversedByRecordId: 'rec-link',
    })
    expect(settled?.status).toBe('posted')
    expect(settled?.inputTokens).toBe(42)
    expect(settled?.billedCostNanoUsd).toBe(99n)
    expect(settled?.priceVersionId).toBe('pv-settled')
    expect(settled?.markupMultiplier).toBe(2)
    expect(settled?.reversedByRecordId).toBe('rec-link')
  })

  /** pending → posted with no patch is a legal bare settlement. */
  it('settles a hold with no patch', async () => {
    const { service, record } = await appendWith('pending')
    expect((await service.transition(record.id, 'pending', 'posted'))?.status).toBe('posted')
  })

  /** A settlement patch that mutates an immutable identity field is rejected at the service layer. */
  it('rejects a settlement patch that mutates the immutable tenantId', async () => {
    const { service, record } = await appendWith('pending')
    await expectConflict(service.transition(record.id, 'pending', 'posted', { tenantId: 'hijacked-tenant' }))
  })

  /** The immutable idempotencyKey is likewise off-limits to a settlement patch. */
  it('rejects a settlement patch that mutates the immutable idempotencyKey', async () => {
    const { service, record } = await appendWith('pending')
    await expectConflict(service.transition(record.id, 'pending', 'posted', { idempotencyKey: 'hijacked-key' }))
  })

  /** The immutable record id is off-limits to a settlement patch. */
  it('rejects a settlement patch that mutates the immutable id', async () => {
    const { service, record } = await appendWith('pending')
    await expectConflict(service.transition(record.id, 'pending', 'posted', { id: 'hijacked-id' }))
  })

  /**
   * The service-layer guard runs BEFORE the store, so a store that applies patches
   * broadly (the in-memory fake) never mutates the immutable field or the status.
   */
  it('leaves the record and its identity intact when an illegal settlement patch is rejected', async () => {
    const { service, record } = await appendWith('pending')
    await expectConflict(service.transition(record.id, 'pending', 'posted', { tenantId: 'evil' }))
    expect(record.tenantId).toBe('tenant-1')
    expect(record.status).toBe('pending')
  })

  /** pending → released voids the hold. */
  it('voids a hold with no patch', async () => {
    const { service, record } = await appendWith('pending')
    expect((await service.transition(record.id, 'pending', 'released'))?.status).toBe('released')
  })

  /** pending → released persists a legal audit annotation (correlation linkage). */
  it('allows a non-amount patch on release', async () => {
    const { service, record } = await appendWith('pending')
    const released = await service.transition(record.id, 'pending', 'released', { correlationId: 'corr-9' })
    expect(released?.correlationId).toBe('corr-9')
  })

  /** A release voids a hold, so a non-annotation column (settlement pricing metadata) is rejected. */
  it('rejects a non-annotation patch on release', async () => {
    const { service, record } = await appendWith('pending')
    await expectConflict(service.transition(record.id, 'pending', 'released', { priceVersionId: 'price-2' }))
  })

  /** posted → reversed annotates with reversedByRecordId. */
  it('annotates a posted record as reversed', async () => {
    const { service, record } = await appendWith('posted')
    const reversed = await service.transition(record.id, 'posted', 'reversed', { reversedByRecordId: 'rec-2' })
    expect(reversed?.status).toBe('reversed')
    expect(reversed?.reversedByRecordId).toBe('rec-2')
  })

  /** posted → reversed with no patch is legal (bare flip). */
  it('allows a bare posted → reversed flip', async () => {
    const { service, record } = await appendWith('posted')
    expect((await service.transition(record.id, 'posted', 'reversed'))?.status).toBe('reversed')
  })

  /** An amount patch on release is rejected. */
  it('rejects an amount patch on release', async () => {
    const { service, record } = await appendWith('pending')
    await expectConflict(service.transition(record.id, 'pending', 'released', { billedCostNanoUsd: 1n }))
  })

  /** A non-annotation patch on posted → reversed is rejected. */
  it('rejects an amount patch on reversal', async () => {
    const { service, record } = await appendWith('posted')
    await expectConflict(service.transition(record.id, 'posted', 'reversed', { billedCostNanoUsd: 1n }))
  })

  /** An illegal (from, to) pair is a caller bug → conflict. */
  it('rejects an illegal posted → pending transition', async () => {
    const { service, record } = await appendWith('posted')
    await expectConflict(service.transition(record.id, 'posted', 'pending'))
  })

  /** A legal pair whose record is in another state returns null (atomic claim). */
  it('returns null on a from-state mismatch', async () => {
    const { service, record } = await appendWith('posted')
    expect(await service.transition(record.id, 'pending', 'posted', { billedCostNanoUsd: 1n })).toBeNull()
  })

  /** Two concurrent claims: exactly one wins, the other gets null. */
  it('lets exactly one of two concurrent claims win', async () => {
    const { service, record } = await appendWith('pending')
    const results = await Promise.all([
      service.transition(record.id, 'pending', 'posted', { billedCostNanoUsd: 1n }),
      service.transition(record.id, 'pending', 'posted', { billedCostNanoUsd: 2n }),
    ])
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })
})

describe('LedgerService.reverse', () => {
  /** A reversal negates every amount, copies attribution, and annotates the original. */
  it('negates amounts, copies attribution, and annotates the original', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const original = await service.append(
      makeInput({
        beneficiary: { type: 'user', id: 'client-1' },
        requestedBy: 'actor-1',
        requestedModel: 'gpt-5-req',
        extraUnits: { web_search_requests: 2 },
        correlationId: 'corr-1',
        requestId: 'req-1',
        systemCostCategory: 'retry',
        isSystemCost: true,
        enforced: true,
        rawCostNanoUsd: 6_025_000n,
        surchargeNanoUsd: 20_000_000n,
        billedCostNanoUsd: 24_100_000n,
      }),
      'orig-key',
    )

    const compensating = await service.reverse(original.id, 'provider outage')

    expect(compensating.reversesRecordId).toBe(original.id)
    expect(compensating.status).toBe('posted')
    expect(compensating.idempotencyKey).toBe(`reverse:${original.id}`)
    expect(compensating.rawCostNanoUsd).toBe(-6_025_000n)
    expect(compensating.surchargeNanoUsd).toBe(-20_000_000n)
    expect(compensating.billedCostNanoUsd).toBe(-24_100_000n)
    expect(compensating.inputTokens).toBe(-1000)
    expect(compensating.outputTokens).toBe(-500)
    expect(compensating.extraUnits).toEqual({ web_search_requests: -2 })
    expect(compensating.beneficiary).toEqual({ type: 'user', id: 'client-1' })
    expect(compensating.requestedBy).toBe('actor-1')
    expect(compensating.requestedModel).toBe('gpt-5-req')
    expect(compensating.correlationId).toBe('corr-1')
    expect(compensating.requestId).toBe('req-1')
    expect(compensating.systemCostCategory).toBe('retry')
    expect(compensating.isSystemCost).toBe(true)
    expect(compensating.enforced).toBe(true)

    const annotated = await service.findByIdempotencyKey('tenant-1', 'orig-key')
    expect(annotated?.status).toBe('reversed')
    expect(annotated?.reversedByRecordId).toBe(compensating.id)
  })

  /** The compensating record negates all non-zero token categories — kills UnaryOperator mutations on each negation. */
  it('negates all non-zero token categories in the compensating record', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const original = await service.append(
      makeInput({
        cacheReadTokens: 10,
        cacheWrite5mTokens: 20,
        cacheWrite1hTokens: 30,
        reasoningTokens: 40,
        audioInTokens: 50,
        audioOutTokens: 60,
        imageInTokens: 70,
        imageOutTokens: 80,
      }),
      'tok-neg-key',
    )
    const compensating = await service.reverse(original.id, 'negate-test')
    expect(compensating.cacheReadTokens).toBe(-10)
    expect(compensating.cacheWrite5mTokens).toBe(-20)
    expect(compensating.cacheWrite1hTokens).toBe(-30)
    expect(compensating.reasoningTokens).toBe(-40)
    expect(compensating.audioInTokens).toBe(-50)
    expect(compensating.audioOutTokens).toBe(-60)
    expect(compensating.imageInTokens).toBe(-70)
    expect(compensating.imageOutTokens).toBe(-80)
  })

  /** After a reversal, sumCost nets to zero across the pair. */
  it('nets sumCost to zero for the reversed pair', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const original = await service.append(
      makeInput({ rawCostNanoUsd: 100n, billedCostNanoUsd: 400n, surchargeNanoUsd: 10n }),
      'k',
    )
    await service.reverse(original.id, 'refund')
    const summary = await service.sumCost({ tenantId: 'tenant-1' })
    expect(summary.rawCostNanoUsd).toBe(0n)
    expect(summary.billedCostNanoUsd).toBe(0n)
    expect(summary.surchargeNanoUsd).toBe(0n)
    expect(summary.totalTokens).toBe(0)
    expect(summary.records).toBe(2)
  })

  /** Reversing a missing record is a conflict. */
  it('rejects reversing a missing record', async () => {
    const service = new LedgerService(new InMemoryLedgerStore())
    await expectConflict(service.reverse('absent', 'x'))
  })

  /** Reversing a non-posted record is a conflict. */
  it('rejects reversing a pending record', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const hold = await service.append(makeInput({ status: 'pending' }), 'k')
    await expectConflict(service.reverse(hold.id, 'x'))
  })

  /** A second reverse of the same record is blocked (already reversed). */
  it('rejects a second reverse of the same record', async () => {
    const store = new InMemoryLedgerStore()
    const service = new LedgerService(store)
    const original = await service.append(makeInput(), 'k')
    await service.reverse(original.id, 'first')
    await expectConflict(service.reverse(original.id, 'second'))
  })

  /** For arbitrary amounts, the compensating record exactly negates the original. */
  it('exactly negates arbitrary amounts and nets to zero (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          inputTokens: fc.nat({ max: 1_000_000 }),
          outputTokens: fc.nat({ max: 1_000_000 }),
          rawCostNanoUsd: fc.bigInt({ min: 0n, max: 10n ** 18n }),
          billedCostNanoUsd: fc.bigInt({ min: 0n, max: 10n ** 18n }),
          surchargeNanoUsd: fc.bigInt({ min: 0n, max: 10n ** 15n }),
        }),
        async (amounts) => {
          const store = new InMemoryLedgerStore()
          const service = new LedgerService(store)
          const original = await service.append(makeInput(amounts), 'k')
          const compensating = await service.reverse(original.id, 'r')
          expect(compensating.rawCostNanoUsd).toBe(-amounts.rawCostNanoUsd)
          expect(compensating.billedCostNanoUsd).toBe(-amounts.billedCostNanoUsd)
          expect(compensating.surchargeNanoUsd).toBe(-amounts.surchargeNanoUsd)
          expect(compensating.inputTokens).toBe(-amounts.inputTokens)
          expect(compensating.outputTokens).toBe(-amounts.outputTokens)
          const summary = await service.sumCost({ tenantId: 'tenant-1' })
          expect(summary.rawCostNanoUsd).toBe(0n)
          expect(summary.billedCostNanoUsd).toBe(0n)
          expect(summary.surchargeNanoUsd).toBe(0n)
        },
      ),
    )
  })
})
