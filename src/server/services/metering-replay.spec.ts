/**
 * @fileoverview Pins how `record()` treats a second call with an idempotency key the ledger already
 * holds: the same request returns the stored record and does nothing else, a different request
 * conflicts, and calls with one key run one at a time. A replay must not move a budget, wallet,
 * event, metric or content store a second time.
 * @layer server
 */
import { Test } from '@nestjs/testing'
import { makeFullStore } from '../../../test/fakes/full-store'
import type { AiTokensErrorResponse, UsageRecord, WalletRef } from '../../shared'
import { BymaxAiTokensModule } from '../bymax-ai-tokens.module'
import { providerPresets } from '../config/provider-presets'
import { AiTokensException } from '../errors'
import type { IAiTokensStore, MeteringContext } from '../interfaces'
import { BudgetService, LedgerService, MeteringService, PricingService, WalletService } from './index'
import type { LedgerAppendInput } from './ledger.service'

const SCOPE = { type: 'user' as const, id: 'u' }
const WALLET: WalletRef = { tenantId: 't', ownerType: 'user', ownerId: 'u' }
const RAW = { model: 'gpt-5-mini', usage: { prompt_tokens: 1000, completion_tokens: 500 } }
const CONTEXT: MeteringContext = { tenantId: 't', scope: SCOPE, feature: 'f', idempotencyKey: 'k1', enforce: true }
const OCCURRED_AT = new Date('2026-06-01T00:00:00.000Z')
const CONTENT = { prompt: 'p', completion: 'c' }

/** What the sinks behind the module have been asked to do. */
interface Probe {
  events: string[]
  telemetry: number
  content: number
}

/** Everything a spec needs from one booted module. */
interface Booted {
  metering: MeteringService
  ledger: LedgerService
  budgets: BudgetService
  wallets: WalletService
  pricing: PricingService
  probe: Probe
  store: IAiTokensStore
}

/** Boot a module with wallets, budgets and counting sinks, and give the payer a wallet and a budget. */
async function boot(strict = true, store: IAiTokensStore = makeFullStore()): Promise<Booted> {
  const probe: Probe = { events: [], telemetry: 0, content: 0 }
  const moduleRef = await Test.createTestingModule({
    imports: [
      BymaxAiTokensModule.forRoot({
        store,
        wallets: {},
        budgets: {},
        scopeResolver: () => ({ tenantId: 't', scope: SCOPE, feature: 'f' }),
        pricing: { strict },
        events: {
          emitter: false,
          sink: {
            deliver: (event): Promise<void> => {
              probe.events.push(event.type)
              return Promise.resolve()
            },
          },
        },
        telemetry: {
          sink: {
            recordUsage: (): void => {
              probe.telemetry += 1
            },
          },
        },
        content: {
          store: {
            put: (): Promise<void> => {
              probe.content += 1
              return Promise.resolve()
            },
            purge: (): Promise<number> => Promise.resolve(0),
          },
        },
      }),
    ],
  }).compile()
  await moduleRef.init()
  const booted: Booted = {
    metering: moduleRef.get(MeteringService),
    ledger: moduleRef.get(LedgerService),
    budgets: moduleRef.get(BudgetService),
    wallets: moduleRef.get(WalletService),
    pricing: moduleRef.get(PricingService),
    probe,
    store,
  }
  await booted.wallets.grant(WALLET, { amountNanoUsd: 50_000_000n, idempotencyKey: 'grant', reason: 'seed' })
  await booted.budgets.upsertBudget({ tenantId: 't', scope: SCOPE, limitNanoUsd: 100_000_000n, window: 'total' })
  return booted
}

/** Everything a replay must leave exactly as the first call left it. */
async function snapshot(booted: Booted): Promise<Record<string, unknown>> {
  const [status] = await booted.budgets.status('t', SCOPE)
  const balance = await booted.wallets.getBalance(WALLET)
  return {
    spent: status?.spent,
    balance: balance.nanoUsd,
    rows: (await booted.ledger.query({ tenantId: 't' })).length,
    events: [...booted.probe.events],
    telemetry: booted.probe.telemetry,
    content: booted.probe.content,
  }
}

/** The idempotency-conflict code behind a rejected call. */
function conflictCode(error: unknown): string | undefined {
  return error instanceof AiTokensException ? (error.getResponse() as AiTokensErrorResponse).error.code : undefined
}

/** Fields a store assigns or a later transition changes; the rest is what a caller appends. */
const STORE_FIELDS = new Set(['id', 'status', 'hash', 'prevHash', 'createdAt', 'updatedAt', 'idempotencyKey', 'totalTokens', 'reversedByRecordId'])

/** The append input of a record, so a spec can store the row another version would have written. */
function appendInputOf(record: UsageRecord, over: Partial<LedgerAppendInput> = {}): LedgerAppendInput {
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => !STORE_FIELDS.has(key)))
  return { ...fields, ...over } as LedgerAppendInput
}

describe('record(): a retry of the same request', () => {
  /**
   * The retry repeats the request, so it is the same call. It returns the stored record and moves
   * nothing: not the budget, the wallet, the events (price-missing included), the metric or the
   * content store.
   */
  it.each([
    ['with the same occurredAt', { occurredAt: OCCURRED_AT }],
    ['without an occurredAt', {}],
  ])('returns the stored record and leaves every side effect alone %s', async (_name, retry) => {
    const booted = await boot(false)
    const first = await booted.metering.record({ usage: { ...RAW, model: 'unpriced-model' }, preset: providerPresets.openaiChat, context: CONTEXT, content: CONTENT, occurredAt: OCCURRED_AT })
    const afterFirst = await snapshot(booted)

    const replay = await booted.metering.record({ usage: { ...RAW, model: 'unpriced-model' }, preset: providerPresets.openaiChat, context: CONTEXT, content: CONTENT, ...retry })

    expect(first.priceMissing).toBe(true)
    expect(replay.id).toBe(first.id)
    expect(afterFirst.events).toContain('ai_tokens.price.missing')
    expect(await snapshot(booted)).toEqual(afterFirst)
  })

  /** The values computed while serving the call are not part of the request. */
  it('returns the stored record, with its original cost, when the price changed between attempts', async () => {
    const booted = await boot()
    const first = await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT, occurredAt: OCCURRED_AT })
    await booted.pricing.upsertPrice({
      provider: 'openai',
      model: 'gpt-5-mini',
      operation: 'chat',
      serviceTier: 'standard',
      inputNanoUsdPerMillion: 9_000_000_000n,
      outputNanoUsdPerMillion: 9_000_000_000n,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    })

    const replay = await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT, occurredAt: OCCURRED_AT })

    expect(replay.id).toBe(first.id)
    expect(replay.rawCostNanoUsd).toBe(first.rawCostNanoUsd)
  })

  /** A row an earlier version stored with the empty model, a defaulted occurredAt and its own rating. */
  it('returns a row stored by the previous release when the retry names no occurredAt', async () => {
    const source = await boot(false)
    const filled = await source.metering.record({
      usage: { usage: { inputTokens: 1000, outputTokens: 500 } },
      preset: providerPresets.bedrock,
      context: { ...CONTEXT, enforce: false, baseModel: 'claude-sonnet-4-5' },
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    const target = await boot(false)
    const stored = await target.ledger.append(appendInputOf(filled, { model: '', priceVersionId: 'price-from-last-week', billedCostNanoUsd: 7n }), CONTEXT.idempotencyKey)

    const replay = await target.metering.record({
      usage: { usage: { inputTokens: 1000, outputTokens: 500 } },
      preset: providerPresets.bedrock,
      context: { ...CONTEXT, enforce: false, baseModel: 'claude-sonnet-4-5' },
    })

    expect(replay.id).toBe(stored.id)
    expect(replay.billedCostNanoUsd).toBe(7n)
  })
})

describe('record(): a retry of a different request', () => {
  /** Each case changes one request field under the key the first call used. */
  it.each([
    ['another token count', { usage: { model: 'gpt-5-mini', usage: { prompt_tokens: 1001, completion_tokens: 500 } } }, {}],
    ['another model', { usage: { model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 500 } } }, {}],
    ['another feature', {}, { feature: 'g' }],
    ['another tag', {}, { tags: ['x'] }],
    ['another baseModel', {}, { baseModel: 'gpt-5' }],
    ['another occurredAt that the retry supplies', { occurredAt: new Date('2026-06-02T00:00:00.000Z') }, {}],
  ])('conflicts for %s and moves nothing', async (_name, change, contextChange) => {
    const booted = await boot()
    await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT, content: CONTENT, occurredAt: OCCURRED_AT })
    const afterFirst = await snapshot(booted)

    const error = await booted.metering
      .record({ usage: RAW, preset: providerPresets.openaiChat, context: { ...CONTEXT, ...contextChange }, content: CONTENT, occurredAt: OCCURRED_AT, ...change })
      .catch((e: unknown) => e)

    expect(conflictCode(error)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
    expect(await snapshot(booted)).toEqual(afterFirst)
  })

  /**
   * When the lookup misses but the store holds the key (a concurrent first attempt), a payload that
   * differs only in a defaulted value is reported as a conflict; the fields decide it, so the same
   * request resolves to the stored row and runs nothing.
   */
  it('resolves a conflict reported by the store against the stored row', async () => {
    const booted = await boot()
    const first = await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT, occurredAt: OCCURRED_AT })
    const afterFirst = await snapshot(booted)
    jest.spyOn(booted.ledger, 'findByIdempotencyKey').mockResolvedValueOnce(null)

    const replay = await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT, content: CONTENT })

    expect(replay.id).toBe(first.id)
    expect(await snapshot(booted)).toEqual(afterFirst)
  })

  /** The store's conflict stays a conflict when the fields differ. */
  it('rethrows the store conflict when the stored row is another request', async () => {
    const booted = await boot()
    await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT, occurredAt: OCCURRED_AT })
    jest.spyOn(booted.ledger, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    const error = await booted.metering.record({ usage: { model: 'gpt-5-mini', usage: { prompt_tokens: 7, completion_tokens: 5 } }, preset: providerPresets.openaiChat, context: CONTEXT, occurredAt: OCCURRED_AT }).catch((e: unknown) => e)
    expect(conflictCode(error)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
  })

  /** A conflict whose row has gone is rethrown, not guessed at. */
  it('rethrows the store conflict when the row cannot be found again', async () => {
    const booted = await boot()
    await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT, occurredAt: OCCURRED_AT })
    jest.spyOn(booted.ledger, 'findByIdempotencyKey').mockResolvedValue(null)
    const error = await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT }).catch((e: unknown) => e)
    expect(conflictCode(error)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
  })

  /** Only the idempotency conflict is resolved; any other store failure reaches the caller as it is. */
  it('lets any other store failure through', async () => {
    const booted = await boot()
    const failure = new Error('store down')
    jest.spyOn(booted.ledger, 'append').mockRejectedValueOnce(failure)
    await expect(booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT })).rejects.toBe(failure)
  })

  /** Without a key nothing is looked up, so a call never waits on or matches another. */
  it('looks nothing up when the call has no idempotency key', async () => {
    const booted = await boot()
    const find = jest.spyOn(booted.ledger, 'findByIdempotencyKey')
    const { idempotencyKey: _unused, ...keyless } = CONTEXT
    await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: keyless })
    expect(find).not.toHaveBeenCalled()
  })
})

describe('record(): a provider-reported cost is part of the request', () => {
  const reported = (cost?: number): unknown => ({ model: 'any-model', usage: { prompt_tokens: 1000, completion_tokens: 500, ...(cost === undefined ? {} : { cost }) } })

  /** The provider's own cost is what the caller reported, so a retry repeating it is the same request. */
  it('returns the stored record for a retry that reports the same cost', async () => {
    const booted = await boot()
    const first = await booted.metering.record({ usage: reported(0.01), preset: providerPresets.openrouter, context: CONTEXT })
    const replay = await booted.metering.record({ usage: reported(0.01), preset: providerPresets.openrouter, context: CONTEXT })
    expect(replay.id).toBe(first.id)
  })

  /** A retry that reports another cost is another request, unlike a rate-table price that changed on our side. */
  it('conflicts for a retry that reports another cost', async () => {
    const booted = await boot()
    await booted.metering.record({ usage: reported(0.01), preset: providerPresets.openrouter, context: CONTEXT })
    const error = await booted.metering.record({ usage: reported(0.02), preset: providerPresets.openrouter, context: CONTEXT }).catch((e: unknown) => e)
    expect(conflictCode(error)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
  })

  /** Rating still refuses a provider-reported call that carries no cost, replay lookup or not. */
  it('refuses a call that reports no cost', async () => {
    const booted = await boot()
    await expect(booted.metering.record({ usage: reported(), preset: providerPresets.openrouter, context: CONTEXT })).rejects.toBeInstanceOf(AiTokensException)
  })
})

describe('record(): calls with one idempotency key run one at a time', () => {
  /** The number of keys with a call in flight. */
  function inflight(metering: MeteringService): number {
    return (metering as unknown as { inflight: Map<string, unknown> }).inflight.size
  }

  /**
   * Two simultaneous calls with one key would both miss the lookup and both append. Running them in
   * turn makes the second one a replay of the first, so the effects happen once and both calls
   * return the same record.
   */
  it('produces one set of effects and one record for two concurrent calls', async () => {
    const booted = await boot()
    const call = (): Promise<UsageRecord> => booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT, content: CONTENT, occurredAt: OCCURRED_AT })

    const [a, b] = await Promise.all([call(), call()])

    expect(b.id).toBe(a.id)
    const [status] = await booted.budgets.status('t', SCOPE)
    expect(status?.spent.count).toBe(1)
    expect(booted.probe.events.filter((type) => type === 'ai_tokens.usage.recorded')).toHaveLength(1)
    expect(booted.probe.telemetry).toBe(1)
    expect(booted.probe.content).toBe(2)
    expect(inflight(booted.metering)).toBe(0)
  })

  /** The second call never inherits the first one's failure. */
  it('records normally when the call ahead of it failed before appending', async () => {
    const booted = await boot()
    const failing = booted.metering.record({ usage: { ...RAW, model: 'unpriced-model' }, preset: providerPresets.openaiChat, context: CONTEXT })
    const following = booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT })

    await expect(failing).rejects.toBeInstanceOf(AiTokensException)
    const record = await following
    expect(record.model).toBe('gpt-5-mini')
    expect(await booted.ledger.query({ tenantId: 't' })).toHaveLength(1)
    expect(inflight(booted.metering)).toBe(0)
  })

  /** Calls with different keys, and the same key in another tenant, never queue behind each other. */
  it('lets calls with other keys run while one waits', async () => {
    const booted = await boot()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const find = jest.spyOn(booted.ledger, 'findByIdempotencyKey')
    find.mockImplementationOnce(async () => {
      await gate
      return null
    })

    const held = booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: { ...CONTEXT, idempotencyKey: 'held' } })
    const other = await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: { ...CONTEXT, idempotencyKey: 'other' } })

    expect(other.idempotencyKey).toBe('other')
    expect(inflight(booted.metering)).toBe(1)
    release()
    await held
    expect(inflight(booted.metering)).toBe(0)
  })

  /** The map holds only keys with a call in flight, however the call ends. */
  it.each([
    ['succeeds', undefined],
    ['is rejected by the store', new Error('store down')],
  ])('holds no key once a call that %s has settled', async (_name, failure) => {
    const booted = await boot()
    if (failure !== undefined) jest.spyOn(booted.ledger, 'append').mockRejectedValueOnce(failure)
    await booted.metering.record({ usage: RAW, preset: providerPresets.openaiChat, context: CONTEXT }).catch(() => undefined)
    expect(inflight(booted.metering)).toBe(0)
  })

  /** A call that fails validation before any lookup also leaves nothing behind. */
  it('holds no key once a call that throws has settled', async () => {
    const booted = await boot()
    await expect(booted.metering.record({ usage: { not: 'usage' }, preset: providerPresets.openaiChat, context: CONTEXT })).rejects.toBeInstanceOf(AiTokensException)
    expect(inflight(booted.metering)).toBe(0)
  })
})

describe('meter(): a retry', () => {
  /** The duration metric belongs to the call that did the work, not to a replay of it. */
  it('records no duration for a replay', async () => {
    const booted = await boot()
    const durations: number[] = []
    const telemetry = (booted.metering as unknown as { telemetry: { recordDuration: (...args: unknown[]) => void } }).telemetry
    jest.spyOn(telemetry, 'recordDuration').mockImplementation((_usage, ms) => {
      durations.push(ms as number)
    })
    const run = (): Promise<unknown> => booted.metering.meter(() => Promise.resolve(RAW), { ...CONTEXT, preset: providerPresets.openaiChat }, (response) => response)

    await run()
    await run()

    expect(durations).toHaveLength(1)
  })
})
