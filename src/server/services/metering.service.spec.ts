import type { AiTokensErrorResponse, NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { MeteringContext } from '../interfaces'
import { providerPresets } from '../config/provider-presets'
import { AiTokensException } from '../errors'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService, type MeteringEventHooks } from './metering.service'
import { PricingService } from './pricing.service'

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** A representative metering context; `over` replaces any field. */
function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', ...over }
}

/** Build a complete `NormalizedUsage` for already-normalized inputs. */
function normalized(over: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
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
    ...over,
  }
}

/** A complete normalized usage with one required field removed, returned opaquely. */
function withoutField(field: keyof NormalizedUsage): unknown {
  return Object.fromEntries(Object.entries(normalized()).filter(([key]) => key !== field))
}

/** A complete normalized usage with one field replaced by a wrong-typed value. */
function withField(field: string, value: unknown): unknown {
  return { ...normalized(), [field]: value }
}

/** Assemble a MeteringService over in-memory stores; returns the collaborators for assertions. */
function build(opts: { markup?: number; strict?: boolean; ratingMode?: 'rate-table' | 'provider-reported' } = {}): {
  service: MeteringService
  ledgerStore: InMemoryLedgerStore
  pricingStore: InMemoryPricingStore
  events: { usageRecorded: jest.Mock; priceMissing: jest.Mock }
} {
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  const options = {
    ratingMode: opts.ratingMode ?? 'rate-table',
    markup: opts.markup ?? 1,
    ledger: { hashChain: false },
    pricing: { strict: opts.strict ?? true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
  } as ResolvedAiTokensOptions
  const events: MeteringEventHooks & { usageRecorded: jest.Mock; priceMissing: jest.Mock } = {
    usageRecorded: jest.fn(() => Promise.resolve()),
    priceMissing: jest.fn(() => Promise.resolve()),
  }
  const service = new MeteringService(
    new LedgerService(ledgerStore, options),
    new PricingService(options, pricingStore),
    new MarkupResolver(options),
    options,
    events,
  )
  return { service, ledgerStore, pricingStore, events }
}

/** Seed a gpt-5 chat price ($1.25/M input, $10/M output). */
async function seedGpt5(store: InMemoryPricingStore, model = 'gpt-5'): Promise<void> {
  await store.upsertPrice({
    provider: 'openai',
    model,
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_250_000_000n,
    outputNanoUsdPerMillion: 10_000_000_000n,
    effectiveFrom: new Date(0),
  })
}

describe('MeteringService.record', () => {
  /** Raw usage + preset → a correct posted, observe-only record. */
  it('records raw usage via a preset with markup applied', async () => {
    const { service, pricingStore, events } = build({ markup: 4 })
    await seedGpt5(pricingStore)
    const record = await service.record({
      usage: { model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 500 } },
      preset: providerPresets.openaiChat,
      context: context({ idempotencyKey: 'k1' }),
    })
    expect(record.status).toBe('posted')
    expect(record.enforced).toBe(false)
    expect(record.provider).toBe('openai')
    expect(record.model).toBe('gpt-5')
    expect(record.serviceTier).toBe('standard')
    expect(record.inputTokens).toBe(1000)
    expect(record.outputTokens).toBe(500)
    expect(record.rawCostNanoUsd).toBe(6_250_000n)
    expect(record.billedCostNanoUsd).toBe(25_000_000n)
    expect(record.markupMultiplier).toBe(4)
    expect(record.priceVersionId).not.toBeNull()
    expect(events.usageRecorded).toHaveBeenCalledWith(record)
    expect(events.priceMissing).not.toHaveBeenCalled()
  })

  /** An already-normalized usage is accepted with no preset (module default mode). */
  it('accepts an already-normalized usage without a preset', async () => {
    const { service, pricingStore } = build()
    await seedGpt5(pricingStore)
    const record = await service.record({ usage: normalized({ serviceTier: 'standard' }), context: context() })
    expect(record.rawCostNanoUsd).toBe(6_250_000n)
  })

  /** Raw usage with neither preset nor normalizer, not already normalized → 400. */
  it.each([null, 'nope', { prompt_tokens: 1 }, { provider: 'x' }, { provider: 'x', inputTokens: 1 }])(
    'rejects un-normalizable input %p as UNKNOWN_PROVIDER',
    async (usage) => {
      const { service } = build()
      const error = await service.record({ usage, context: context() }).catch((e: unknown) => e)
      expect(codeOf(error)).toBe('AI_TOKENS_UNKNOWN_PROVIDER')
      expect((error as AiTokensException).getStatus()).toBe(400)
    },
  )

  /** An object missing any required NormalizedUsage field is not accepted as normalized → 400. */
  it.each([
    ['provider', withoutField('provider')],
    ['model', withoutField('model')],
    ['operation', withoutField('operation')],
    ['inputTokens', withoutField('inputTokens')],
    ['outputTokens', withoutField('outputTokens')],
    ['cacheReadTokens', withoutField('cacheReadTokens')],
    ['cacheWrite5mTokens', withoutField('cacheWrite5mTokens')],
    ['cacheWrite1hTokens', withoutField('cacheWrite1hTokens')],
    ['reasoningTokens', withoutField('reasoningTokens')],
    ['audioInTokens', withoutField('audioInTokens')],
    ['audioOutTokens', withoutField('audioOutTokens')],
    ['imageInTokens', withoutField('imageInTokens')],
    ['imageOutTokens', withoutField('imageOutTokens')],
  ])('rejects a normalized usage missing %s', async (_field, usage) => {
    const { service } = build()
    const error = await service.record({ usage, context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_UNKNOWN_PROVIDER')
    expect((error as AiTokensException).getStatus()).toBe(400)
  })

  /** An object mistyping any required field (wrong type, unknown operation, non-finite count) is rejected. */
  it.each([
    ['provider not a string', withField('provider', 123)],
    ['model not a string', withField('model', 123)],
    ['operation not a string', withField('operation', 42)],
    ['operation not in the catalog', withField('operation', 'not-an-operation')],
    ['inputTokens not a number', withField('inputTokens', '1000')],
    ['outputTokens NaN', withField('outputTokens', Number.NaN)],
    ['cacheReadTokens Infinity', withField('cacheReadTokens', Number.POSITIVE_INFINITY)],
  ])('rejects a normalized usage with %s', async (_case, usage) => {
    const { service } = build()
    const error = await service.record({ usage, context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_UNKNOWN_PROVIDER')
  })

  /** A fully-typed normalized usage still passes the tightened guard and rates. */
  it('accepts a complete normalized usage across every required field', async () => {
    const { service, pricingStore } = build()
    await seedGpt5(pricingStore)
    const record = await service.record({ usage: normalized(), context: context() })
    expect(record.status).toBe('posted')
    expect(record.rawCostNanoUsd).toBe(6_250_000n)
  })

  /** All attribution fields land on the record. */
  it('persists every attribution field', async () => {
    const { service, pricingStore } = build()
    await seedGpt5(pricingStore)
    const record = await service.record({
      usage: normalized(),
      context: context({
        beneficiary: { type: 'user', id: 'client-1' },
        requestedBy: 'actor-1',
        serviceTier: 'standard',
        tags: ['team:research'],
        extraUnits: { web_search_requests: 2 },
        correlationId: 'corr-1',
        isSystemCost: true,
        systemCostCategory: 'retry',
      }),
    })
    expect(record.beneficiary).toEqual({ type: 'user', id: 'client-1' })
    expect(record.requestedBy).toBe('actor-1')
    expect(record.tags).toEqual(['team:research'])
    expect(record.extraUnits).toEqual({ web_search_requests: 2 })
    expect(record.correlationId).toBe('corr-1')
    expect(record.isSystemCost).toBe(true)
    expect(record.systemCostCategory).toBe('retry')
  })

  /** A non-strict rate miss records zero cost + priceMissing + fires the hook. */
  it('records a price-missing row and fires the price-missing hook', async () => {
    const { service, events } = build({ strict: false })
    const record = await service.record({ usage: normalized({ model: 'unseeded' }), context: context() })
    expect(record.priceMissing).toBe(true)
    expect(record.rawCostNanoUsd).toBe(0n)
    expect(record.billedCostNanoUsd).toBe(0n)
    expect(record.priceVersionId).toBeNull()
    expect(events.priceMissing).toHaveBeenCalledWith(record)
    expect(events.usageRecorded).toHaveBeenCalledWith(record)
  })

  /** Strict mode propagates PRICE_NOT_FOUND on a miss. */
  it('propagates PRICE_NOT_FOUND in strict mode', async () => {
    const { service } = build({ strict: true })
    const error = await service.record({ usage: normalized({ model: 'unseeded' }), context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_PRICE_NOT_FOUND')
  })

  /** Provider-reported mode uses the reported cost and applies markup. */
  it('rates in provider-reported mode with markup', async () => {
    const { service } = build({ markup: 4, ratingMode: 'provider-reported' })
    const record = await service.record({
      usage: normalized({ provider: 'openrouter', providerReportedCostNanoUsd: 5_000_000n }),
      context: context(),
    })
    expect(record.rawCostNanoUsd).toBe(5_000_000n)
    expect(record.billedCostNanoUsd).toBe(20_000_000n)
    expect(record.priceVersionId).toBeNull()
  })

  /** Provider-reported mode without a reported cost is malformed. */
  it('rejects provider-reported mode without a reported cost', async () => {
    const { service } = build({ ratingMode: 'provider-reported' })
    const error = await service.record({ usage: normalized(), context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
    expect((error as AiTokensException).getStatus()).toBe(422)
  })

  /** A context ratingMode overrides the module default. */
  it('lets the context override the rating mode', async () => {
    const { service } = build({ markup: 2, ratingMode: 'rate-table' })
    const record = await service.record({
      usage: normalized({ providerReportedCostNanoUsd: 3_000_000n }),
      context: context({ ratingMode: 'provider-reported' }),
    })
    expect(record.rawCostNanoUsd).toBe(3_000_000n)
    expect(record.billedCostNanoUsd).toBe(6_000_000n)
  })

  /** baseModel resolves the price and lands as requestedModel. */
  it('resolves the price via baseModel and records requestedModel', async () => {
    const { service, pricingStore } = build()
    await seedGpt5(pricingStore)
    const record = await service.record({
      usage: normalized({ model: 'my-deployment' }),
      context: context({ baseModel: 'gpt-5' }),
    })
    expect(record.model).toBe('my-deployment')
    expect(record.requestedModel).toBe('gpt-5')
    expect(record.rawCostNanoUsd).toBe(6_250_000n)
  })

  /** enforce: true requires wallets/budgets and is rejected. */
  it('rejects enforce: true', async () => {
    const { service } = build()
    const error = await service.record({ usage: normalized(), context: context({ enforce: true }) }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A normalizer that throws a plain error becomes USAGE_MALFORMED. */
  it('wraps a plain normalizer failure as USAGE_MALFORMED', async () => {
    const { service } = build()
    const normalizer = (): NormalizedUsage => {
      throw new Error('cannot read usage')
    }
    const error = await service.record({ usage: {}, normalizer, context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** With no injected hooks, the default no-op hooks run for both events. */
  it('uses no-op event hooks by default', async () => {
    const ledgerStore = new InMemoryLedgerStore()
    const pricingStore = new InMemoryPricingStore()
    await seedGpt5(pricingStore)
    const options = {
      ratingMode: 'rate-table',
      markup: 1,
      ledger: { hashChain: false },
      pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    } as ResolvedAiTokensOptions
    const service = new MeteringService(
      new LedgerService(ledgerStore, options),
      new PricingService(options, pricingStore),
      new MarkupResolver(options),
      options,
    )
    expect((await service.record({ usage: normalized(), context: context() })).status).toBe('posted')
    expect((await service.record({ usage: normalized({ model: 'unseeded' }), context: context() })).priceMissing).toBe(true)
  })

  /** A normalizer that throws a typed error is rethrown unchanged. */
  it('rethrows a typed normalizer error', async () => {
    const { service } = build()
    const normalizer = (): NormalizedUsage => {
      throw new AiTokensException('AI_TOKENS_STORE_ERROR')
    }
    const error = await service.record({ usage: {}, normalizer, context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_STORE_ERROR')
  })
})

describe('MeteringService.estimateCost', () => {
  /** Estimates the raw and billed cost with zero side effects. */
  it('estimates raw and billed cost without side effects', async () => {
    const { service, pricingStore, ledgerStore, events } = build({ markup: 4 })
    await seedGpt5(pricingStore)
    const estimate = await service.estimateCost({
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      inputTokens: 1000,
      maxOutputTokens: 500,
      scope: { type: 'user', id: 'u1' },
      feature: 'chat.reply',
    })
    expect(estimate.rawCostNanoUsd).toBe(6_250_000n)
    expect(estimate.billedCostNanoUsd).toBe(25_000_000n)
    expect(ledgerStore.all()).toHaveLength(0)
    expect(events.usageRecorded).not.toHaveBeenCalled()
  })

  /** A non-strict rate miss estimates zero. */
  it('estimates zero on a non-strict rate miss', async () => {
    const { service } = build({ strict: false })
    const estimate = await service.estimateCost({
      provider: 'openai',
      model: 'unseeded',
      operation: 'chat',
      inputTokens: 10,
      maxOutputTokens: 10,
    })
    expect(estimate.rawCostNanoUsd).toBe(0n)
    expect(estimate.billedCostNanoUsd).toBe(0n)
  })
})

describe('MeteringService deferred surfaces', () => {
  /** Every later-phase member throws AI_TOKENS_NOT_CONFIGURED. */
  it('throws NOT_CONFIGURED for the hold lifecycle, reverse, and getStatus', async () => {
    const { service } = build()
    const hold = { id: 'h', tenantId: 't', scope: { type: 'user' as const, id: 'u' }, estimatedTokens: 0, estimatedCostNanoUsd: 0n, expiresAt: new Date() }
    const calls: Promise<unknown>[] = [
      service.meter(() => Promise.resolve(1), context(), () => ({})),
      service.hold(context(), { tokens: 10 }),
      service.capture(hold, {}),
      service.release(hold, 'reason'),
      service.reverse('rec-1', 'reason'),
      service.getStatus('tenant-1', { type: 'user', id: 'u1' }),
    ]
    for (const call of calls) {
      const error = await call.catch((e: unknown) => e)
      expect(codeOf(error)).toBe('AI_TOKENS_NOT_CONFIGURED')
    }
  })
})
