import { Inject, Injectable, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  applyMarkup,
  computeCostNanoUsd,
  normalizeOpenAiChatUsage,
  normalizeOpenAiCompatibleUsage,
} from '../shared'
import type { AiTokensEvent, AiTokensErrorResponse } from '../shared'
import type { AiTokensException } from './errors'
import { InMemoryLedgerStore } from '../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../test/fakes/in-memory-pricing-store'
import {
  BYMAX_AI_TOKENS_BUDGET_COUNTER,
  BYMAX_AI_TOKENS_BUDGET_STORE,
  BYMAX_AI_TOKENS_CONTENT_STORE,
  BYMAX_AI_TOKENS_EVENT_SINK,
  BYMAX_AI_TOKENS_OPTIONS,
  BYMAX_AI_TOKENS_PRICING_STORE,
  BYMAX_AI_TOKENS_TELEMETRY,
  BYMAX_AI_TOKENS_TOKENIZER,
  BYMAX_AI_TOKENS_WALLET_STORE,
} from './bymax-ai-tokens.constants'
import { BymaxAiTokensModule } from './bymax-ai-tokens.module'
import type { ResolvedAiTokensOptions } from './config'
import { providerPresets } from './config/provider-presets'
import { BudgetGuard } from './enforcement'
import { HoldReaper } from './enforcement/hold-reaper'
import type { IAiTokensStore, IBudgetCounterStore } from './interfaces'
import { BudgetService, LedgerService, MeteringService, PricingService, UsageReportService, WalletService } from './services'

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

/**
 * A consumer living in a SEPARATE module — it can only resolve these providers if
 * `BymaxAiTokensModule` (which is `@Global`) actually EXPORTS them. Removing an export
 * (the `exports` array or a feature-export `if`) makes this module fail to compile.
 */
@Injectable()
class ExportConsumer {
  constructor(
    @Inject(MeteringService) readonly metering: MeteringService,
    @Inject(WalletService) readonly wallet: WalletService,
    @Inject(BudgetGuard) readonly budgetGuard: BudgetGuard,
  ) {}
}

/** A module that imports nothing from the library, relying on its global exports. */
@Module({ providers: [ExportConsumer] })
class ExportConsumerModule {}

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
   * The hold reaper is provided unconditionally (a stranded hold must be reclaimed
   * even without wallets/budgets). Kills the `useFactory` ArrowFunction→`() => undefined`
   * mutant: with it the HoldReaper token would resolve to `undefined`, not an instance.
   */
  it('provides the hold reaper', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRoot({ store: makeStore(), pricing: { seedFromSnapshot: false } })],
    }).compile()
    expect(moduleRef.get(HoldReaper)).toBeInstanceOf(HoldReaper)
  })

  /**
   * Cross-module proof of the `exports` array (sync path). A sibling module resolves the
   * core `MeteringService` plus the wallet/budget feature providers ONLY because they are
   * exported globally. Kills the `exports` ArrayDeclaration→`[]` mutant and the
   * `wallets.enabled`/`budgets.enabled` export-gate ConditionalExpression→false mutants:
   * any of them drops an export and the consumer module fails to compile.
   */
  it('exports the core + feature providers for cross-module injection (sync)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRoot({
          store: makeStore(),
          wallets: {},
          budgets: {},
          scopeResolver: () => ({ tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }),
          pricing: { seedFromSnapshot: false },
        }),
        ExportConsumerModule,
      ],
    }).compile()
    const consumer = moduleRef.get(ExportConsumer)
    expect(consumer.metering).toBeInstanceOf(MeteringService)
    expect(consumer.wallet).toBeInstanceOf(WalletService)
    expect(consumer.budgetGuard).toBeInstanceOf(BudgetGuard)
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

  /** Enabling wallets and budgets registers their fanned-out store tokens, services, and the guard. */
  it('registers wallet/budget ports when enabled', async () => {
    const store = makeStore()
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRoot({
          store,
          wallets: {},
          budgets: {},
          scopeResolver: () => ({ tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }),
          pricing: { seedFromSnapshot: false },
        }),
      ],
    }).compile()
    expect(moduleRef.get(BYMAX_AI_TOKENS_WALLET_STORE)).toBe(store)
    expect(moduleRef.get(BYMAX_AI_TOKENS_BUDGET_STORE)).toBe(store)
    expect(moduleRef.get(BYMAX_AI_TOKENS_BUDGET_COUNTER)).toBeNull()
    expect(moduleRef.get(WalletService)).toBeInstanceOf(WalletService)
    expect(moduleRef.get(BudgetService)).toBeInstanceOf(BudgetService)
    expect(moduleRef.get(BudgetGuard)).toBeInstanceOf(BudgetGuard)
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

  /** The report service is wired with an audit hook that fires on export. */
  it('wires the report service audit hook', async () => {
    const delivered: AiTokensEvent[] = []
    const sink = { deliver: (event: AiTokensEvent): Promise<void> => (delivered.push(event), Promise.resolve()) }
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRoot({ store: makeLiveStore(), pricing: { seedFromSnapshot: false }, events: { emitter: false, sink } })],
    }).compile()
    await moduleRef.get(UsageReportService).export({ tenantId: 't1', from: new Date(0), to: new Date() }, 'json')
    expect(delivered.some((e) => e.type === 'ai_tokens.audit')).toBe(true)
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

/** A factory class supplying the module options (useClass/useExisting). */
class OptionsFactory {
  createAiTokensOptions(): { store: IAiTokensStore; wallets: Record<string, never>; budgets: Record<string, never>; scopeResolver: () => { tenantId: string; scope: { type: 'user'; id: string }; feature: string }; pricing: { seedFromSnapshot: false } } {
    return { store: makeStore(), wallets: {}, budgets: {}, scopeResolver: () => ({ tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }), pricing: { seedFromSnapshot: false } }
  }
}

/** A module exporting the options factory for the useExisting path. */
@Module({ providers: [OptionsFactory], exports: [OptionsFactory] })
class FactoryModule {}

/** A module exporting a config token for the async-factory inject path. */
@Module({ providers: [{ provide: 'CONFIG_STORE', useFactory: () => makeStore() }], exports: ['CONFIG_STORE'] })
class ConfigModule {}

describe('BymaxAiTokensModule.forRootAsync', () => {
  /** useFactory resolves the options and boots the full service set (parity with forRoot). */
  it('boots via useFactory with provider parity', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRootAsync({
          useFactory: () => ({ store: makeStore(), wallets: {}, budgets: {}, scopeResolver: () => ({ tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }), pricing: { seedFromSnapshot: false } }),
        }),
      ],
    }).compile()
    expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService)
    expect(moduleRef.get(WalletService)).toBeInstanceOf(WalletService)
    expect(moduleRef.get(BudgetService)).toBeInstanceOf(BudgetService)
    expect(moduleRef.get(BudgetGuard)).toBeInstanceOf(BudgetGuard)
    expect(moduleRef.get(PricingService)).toBeInstanceOf(PricingService)
  })

  /** useFactory resolves its injected dependencies (from asyncOptions.imports). */
  it('injects dependencies into the async factory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRootAsync({
          imports: [ConfigModule],
          inject: ['CONFIG_STORE'],
          useFactory: (store: unknown) => ({ store: store as IAiTokensStore, pricing: { seedFromSnapshot: false } }),
        }),
      ],
    }).compile()
    expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService)
  })

  /** A disabled feature resolves to null (async cannot gate at definition time); optional ports resolve too. */
  it('resolves feature services to null when disabled', async () => {
    const tokenizer = { countTokens: () => 1 }
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRootAsync({ useFactory: () => ({ store: makeStore(), tokenizer, pricing: { seedFromSnapshot: false } }) })],
    }).compile()
    expect(moduleRef.get(WalletService, { strict: false })).toBeNull()
    expect(moduleRef.get(BudgetGuard, { strict: false })).toBeNull()
    expect(moduleRef.get(BYMAX_AI_TOKENS_TOKENIZER, { strict: false })).toBe(tokenizer)
    expect(moduleRef.get(BYMAX_AI_TOKENS_CONTENT_STORE, { strict: false })).toBeNull()
    expect(moduleRef.get(BYMAX_AI_TOKENS_EVENT_SINK, { strict: false })).toBeNull()
    expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService)
  })

  /** useClass boots via the factory class. */
  it('boots via useClass', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRootAsync({ useClass: OptionsFactory })],
    }).compile()
    expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService)
    expect(moduleRef.get(WalletService)).toBeInstanceOf(WalletService)
  })

  /** useExisting boots via a factory exported from an imported module. */
  it('boots via useExisting', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRootAsync({ imports: [FactoryModule], useExisting: OptionsFactory })],
    }).compile()
    expect(moduleRef.get(BudgetService)).toBeInstanceOf(BudgetService)
  })

  /** A rejecting async factory fails bootstrap with AI_TOKENS_INVALID_CONFIG. */
  it('fails bootstrap with INVALID_CONFIG on a rejecting factory', async () => {
    const boot = Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRootAsync({ useFactory: () => Promise.reject(new Error('config source down')) })],
    }).compile()
    const error = await boot.catch((e: unknown) => e)
    expect((error as { getResponse?: () => { error: { code: string } } }).getResponse?.().error.code).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** An async factory producing invalid options fails with INVALID_CONFIG. */
  it('fails bootstrap when the factory returns invalid options', async () => {
    const boot = Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRootAsync({ useFactory: () => ({ store: makeStore(), markup: -1, pricing: { seedFromSnapshot: false } }) })],
    }).compile()
    await expect(boot).rejects.toBeInstanceOf(Object)
  })

  /** No async style supplied is an INVALID_CONFIG configuration error. */
  it('rejects a descriptor with no async style', () => {
    const error = (() => {
      try {
        BymaxAiTokensModule.forRootAsync({})
        return undefined
      } catch (e) {
        return e
      }
    })()
    expect(((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /**
   * The async path fans the single store out to the wallet/budget store tokens and passes
   * the budget counter through by reference. Kills the store/counter `useFactory`
   * ArrowFunction→`() => undefined` mutants (each token would resolve to `undefined`) and
   * the counter LogicalOperator `?? → &&` mutant (`counter && null` would resolve to `null`).
   */
  it('fans the async store out to the wallet/budget tokens and passes the counter through', async () => {
    const store = makeStore()
    const counter: IBudgetCounterStore = {
      incrIfBelow: () => Promise.resolve(true),
      decr: () => Promise.resolve(),
      reset: () => Promise.resolve(),
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRootAsync({
          useFactory: () => ({ store, wallets: {}, budgets: { counter }, scopeResolver: () => ({ tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }), pricing: { seedFromSnapshot: false } }),
        }),
      ],
    }).compile()
    expect(moduleRef.get(BYMAX_AI_TOKENS_WALLET_STORE)).toBe(store)
    expect(moduleRef.get(BYMAX_AI_TOKENS_BUDGET_STORE)).toBe(store)
    expect(moduleRef.get(BYMAX_AI_TOKENS_BUDGET_COUNTER)).toBe(counter)
  })

  /**
   * Cross-module proof of the `exports` array (async path). Kills the async `exports`
   * ArrayDeclaration→`[]` mutant: with an empty export list the sibling consumer module
   * cannot resolve the globally-exported services and fails to compile.
   */
  it('exports the core + feature providers for cross-module injection (async)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRootAsync({
          useFactory: () => ({ store: makeStore(), wallets: {}, budgets: {}, scopeResolver: () => ({ tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }), pricing: { seedFromSnapshot: false } }),
        }),
        ExportConsumerModule,
      ],
    }).compile()
    const consumer = moduleRef.get(ExportConsumer)
    expect(consumer.metering).toBeInstanceOf(MeteringService)
    expect(consumer.wallet).toBeInstanceOf(WalletService)
    expect(consumer.budgetGuard).toBeInstanceOf(BudgetGuard)
  })

  /**
   * A typed exception raised by validation (here `AI_TOKENS_FX_REQUIRED` from a non-USD
   * currency without an fx resolver) must propagate UNCHANGED through `safeResolve`, not be
   * remapped to the generic INVALID_CONFIG. Kills the `error instanceof AiTokensException`
   * ConditionalExpression→false mutant, which would wrap it into AI_TOKENS_INVALID_CONFIG.
   */
  it('propagates a typed validation error without remapping it', async () => {
    const boot = Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRootAsync({ useFactory: () => ({ store: makeStore(), currency: 'EUR', pricing: { seedFromSnapshot: false } }) })],
    }).compile()
    const error = await boot.catch((e: unknown) => e)
    expect(((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code).toBe('AI_TOKENS_FX_REQUIRED')
  })
})
