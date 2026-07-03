import { Test } from '@nestjs/testing'
import {
  applyMarkup,
  computeCostNanoUsd,
  normalizeOpenAiChatUsage,
  normalizeOpenAiCompatibleUsage,
} from '../shared'
import type { AiTokensEvent } from '../shared'
import { InMemoryLedgerStore } from '../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../test/fakes/in-memory-pricing-store'
import {
  BYMAX_AI_TOKENS_BUDGET_COUNTER,
  BYMAX_AI_TOKENS_BUDGET_STORE,
  BYMAX_AI_TOKENS_CONTENT_STORE,
  BYMAX_AI_TOKENS_OPTIONS,
  BYMAX_AI_TOKENS_PRICING_STORE,
  BYMAX_AI_TOKENS_TELEMETRY,
  BYMAX_AI_TOKENS_WALLET_STORE,
} from './bymax-ai-tokens.constants'
import { BymaxAiTokensModule } from './bymax-ai-tokens.module'
import type { ResolvedAiTokensOptions } from './config'
import { providerPresets } from './config/provider-presets'
import type { IAiTokensStore } from './interfaces'
import { LedgerService, MeteringService, PricingService } from './services'

/** A store passing validation for every feature: real pricing, stubbed ledger/wallet/budget. */
function makeStore(): IAiTokensStore {
  const noop = (): Promise<never> => Promise.reject(new Error('not used in this test'))
  return Object.assign(new InMemoryPricingStore(), {
    append: noop,
    transition: noop,
    findByIdempotencyKey: noop,
    findById: noop,
    findExpiredHolds: noop,
    query: noop,
    sumCost: noop,
    lastHash: noop,
    getWallet: noop,
    appendEntry: noop,
    conditionalDebit: noop,
    openGrants: noop,
    listEntries: noop,
    reconcile: noop,
    upsert: noop,
    remove: noop,
    findBudgetById: noop,
    findMatching: noop,
    conditionalConsume: noop,
    adjustWindow: noop,
    getWindow: noop,
    setWindowStart: noop,
  })
}

/** A store with working ledger + pricing halves (wallet/budget unused this phase). */
function makeLiveStore(): IAiTokensStore {
  const ledger = new InMemoryLedgerStore()
  const pricing = new InMemoryPricingStore()
  const reject = (): Promise<never> => Promise.reject(new Error('feature not enabled'))
  return {
    append: ledger.append.bind(ledger),
    transition: ledger.transition.bind(ledger),
    findByIdempotencyKey: ledger.findByIdempotencyKey.bind(ledger),
    findById: ledger.findById.bind(ledger),
    findExpiredHolds: ledger.findExpiredHolds.bind(ledger),
    query: ledger.query.bind(ledger),
    sumCost: ledger.sumCost.bind(ledger),
    lastHash: ledger.lastHash.bind(ledger),
    resolveRate: pricing.resolveRate.bind(pricing),
    upsertPrice: pricing.upsertPrice.bind(pricing),
    getPriceHistory: pricing.getPriceHistory.bind(pricing),
    listModels: pricing.listModels.bind(pricing),
    getWallet: reject,
    appendEntry: reject,
    conditionalDebit: reject,
    openGrants: reject,
    listEntries: reject,
    reconcile: reject,
    upsert: reject,
    remove: reject,
    findBudgetById: reject,
    findMatching: reject,
    conditionalConsume: reject,
    adjustWindow: reject,
    getWindow: reject,
    setWindowStart: reject,
  }
}

describe('BymaxAiTokensModule', () => {
  /** A bare store boots the module with PricingService but no wallet/budget ports. */
  it('boots with only a store and gates wallet/budget ports', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRoot({ store: makeStore(), pricing: { seedFromSnapshot: false } })],
    }).compile()
    expect(moduleRef.get(PricingService)).toBeInstanceOf(PricingService)
    expect(() => {
      moduleRef.get(BYMAX_AI_TOKENS_WALLET_STORE)
    }).toThrow()
  })

  /** The ledger and metering services are provided (wiring the Ledger/Markup/Metering factories). */
  it('provides the ledger and metering services', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRoot({ store: makeStore(), pricing: { seedFromSnapshot: false } })],
    }).compile()
    expect(moduleRef.get(LedgerService)).toBeInstanceOf(LedgerService)
    expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService)
  })

  /**
   * Phase definition of done: record() writes a correct, marked-up ledger entry
   * and emits ai_tokens.usage.recorded (bigints as decimal strings) through the sink.
   */
  it('records a metered call end-to-end and emits usage.recorded', async () => {
    const delivered: AiTokensEvent[] = []
    const sink = {
      deliver: (event: AiTokensEvent): Promise<void> => {
        delivered.push(event)
        return Promise.resolve()
      },
    }
    const store = makeLiveStore()
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRoot({
          store,
          markup: 4,
          pricing: { seedFromSnapshot: false },
          events: { emitter: false, sink },
        }),
      ],
    }).compile()
    await moduleRef.init()

    await moduleRef.get(PricingService).upsertPrice({
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      inputNanoUsdPerMillion: 1_250_000_000n,
      outputNanoUsdPerMillion: 10_000_000_000n,
      effectiveFrom: new Date(0),
    })

    const record = await moduleRef.get(MeteringService).record({
      usage: { model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 500 } },
      preset: providerPresets.openaiChat,
      context: { tenantId: 't1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', idempotencyKey: 'k1' },
    })

    expect(record.billedCostNanoUsd).toBe(25_000_000n)
    const event = delivered.find((e) => e.type === 'ai_tokens.usage.recorded')
    expect(event).toMatchObject({
      tenantId: 't1',
      data: { usageRecordId: record.id, billedCostNanoUsd: '25000000', enforced: false },
    })
  })

  /** Enabling wallets and budgets registers their fanned-out store tokens. */
  it('registers wallet/budget ports when enabled', async () => {
    const store = makeStore()
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRoot({ store, wallets: {}, budgets: {}, pricing: { seedFromSnapshot: false } }),
      ],
    }).compile()
    expect(moduleRef.get(BYMAX_AI_TOKENS_WALLET_STORE)).toBe(store)
    expect(moduleRef.get(BYMAX_AI_TOKENS_BUDGET_STORE)).toBe(store)
    expect(moduleRef.get(BYMAX_AI_TOKENS_BUDGET_COUNTER)).toBeNull()
  })

  /** Telemetry sink and content store bind to their tokens when configured. */
  it('binds the telemetry sink and content store when enabled', async () => {
    const sink = { recordUsage: (): void => undefined }
    const contentStore = { put: () => Promise.resolve(), purge: () => Promise.resolve(0) }
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRoot({
          store: makeStore(),
          pricing: { seedFromSnapshot: false },
          telemetry: { sink },
          content: { store: contentStore },
        }),
      ],
    }).compile()
    expect(moduleRef.get(BYMAX_AI_TOKENS_TELEMETRY)).toBe(sink)
    expect(moduleRef.get(BYMAX_AI_TOKENS_CONTENT_STORE)).toBe(contentStore)
  })

  /** A host binding for the pricing-store token overrides the bundle's pricing half. */
  it('lets a host override the pricing store token', async () => {
    const override = new InMemoryPricingStore()
    await override.upsertPrice({
      provider: 'openai',
      model: 'override-model',
      operation: 'chat',
      inputNanoUsdPerMillion: 7n,
      effectiveFrom: new Date(0),
    })
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRoot({ store: makeStore(), pricing: { seedFromSnapshot: false } })],
    })
      .overrideProvider(BYMAX_AI_TOKENS_PRICING_STORE)
      .useValue(override)
      .compile()
    const pricing = moduleRef.get(PricingService)
    const rate = await pricing.resolveRate({ provider: 'openai', model: 'override-model', operation: 'chat', at: new Date() })
    expect(rate?.inputNanoUsdPerMillion).toBe(7n)
  })

  /** onModuleInit seeds the price registry from the snapshot. */
  it('seeds the price registry on module init', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRoot({ store: makeStore() })],
    }).compile()
    await moduleRef.init()
    const pricing = moduleRef.get(PricingService)
    const history = await pricing.getPriceHistory('openai', 'gpt-5', 'chat', 'standard')
    expect(history).toHaveLength(1)
  })

  /** Every preset carries the right provider/normalizer/ratingMode; the factory works. */
  it('exposes the provider presets', () => {
    expect(providerPresets.openaiChat).toEqual({
      provider: 'openai',
      normalizer: normalizeOpenAiChatUsage,
      ratingMode: 'rate-table',
    })
    expect(providerPresets.azureOpenai.provider).toBe('azure-openai')
    expect(providerPresets.openrouter.ratingMode).toBe('provider-reported')
    expect(providerPresets.vercelAiSdk.provider).toBe('openai')
    expect(providerPresets.openaiCompatible('deepseek')).toEqual({
      provider: 'deepseek',
      normalizer: normalizeOpenAiCompatibleUsage,
      ratingMode: 'rate-table',
    })
  })

  /**
   * Definition of Done: a raw OpenAI usage payload is normalized, rated against a
   * seeded price, and costed to an exact, hand-verifiable nano-USD amount.
   *
   * Normalized: input 800, output 400, cacheRead 200, reasoning 100.
   * Rate: input $1.25/M, output $10/M, cacheRead $0.125/M, reasoning $10/M.
   * raw = 1_000_000 + 4_000_000 + 25_000 + 1_000_000 = 6_025_000n; billed (×4) = 24_100_000n.
   */
  it('rates a raw OpenAI usage payload end-to-end', async () => {
    const store = makeStore()
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRoot({ store, markup: 4.0, pricing: { seedFromSnapshot: false } })],
    }).compile()
    const pricing = moduleRef.get(PricingService)
    await pricing.upsertPrice({
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      serviceTier: 'standard',
      inputNanoUsdPerMillion: 1_250_000_000n,
      outputNanoUsdPerMillion: 10_000_000_000n,
      cacheReadNanoUsdPerMillion: 125_000_000n,
      reasoningNanoUsdPerMillion: 10_000_000_000n,
      effectiveFrom: new Date(0),
    })

    const usage = normalizeOpenAiChatUsage({
      model: 'gpt-5',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 100 },
      },
    })
    const rate = await pricing.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: new Date() })
    if (rate === null) throw new Error('expected a resolved rate for gpt-5')
    const rawCostNanoUsd = computeCostNanoUsd(usage, rate).totalNanoUsd
    const options = moduleRef.get<ResolvedAiTokensOptions>(BYMAX_AI_TOKENS_OPTIONS)
    const billedCostNanoUsd = applyMarkup(rawCostNanoUsd, options.markup as number)

    expect(rawCostNanoUsd).toBe(6_025_000n)
    expect(billedCostNanoUsd).toBe(24_100_000n)
  })
})
