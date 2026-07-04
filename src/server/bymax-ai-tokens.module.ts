/**
 * @fileoverview The `@Global()` dynamic module (spec §2.1/§4.4/§4.6). `forRoot()`
 * validates and resolves the options synchronously; `forRootAsync()` resolves them
 * from injected dependencies (`useFactory`/`useClass`/`useExisting`). Both feed the
 * SAME options-agnostic core providers (each derives its value from the resolved
 * `BYMAX_AI_TOKENS_OPTIONS` token, so wiring is shared by construction), fanning the
 * single `store` object out under each per-port token. `forRoot()` registers the
 * wallet/budget providers only when their feature block is present; `forRootAsync()`
 * — which cannot inspect the options at module-definition time — registers them
 * unconditionally, resolving to `null` when disabled (services treat `null` as
 * absent). The module is global so the guard/interceptor are injectable anywhere.
 * @layer server/module
 */

import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common'
import { ModuleRef, Reflector } from '@nestjs/core'
import {
  BYMAX_AI_TOKENS_BUDGET_COUNTER,
  BYMAX_AI_TOKENS_BUDGET_STORE,
  BYMAX_AI_TOKENS_CONTENT_STORE,
  BYMAX_AI_TOKENS_EVENT_SINK,
  BYMAX_AI_TOKENS_LEDGER_STORE,
  BYMAX_AI_TOKENS_LOGGER,
  BYMAX_AI_TOKENS_OPTIONS,
  BYMAX_AI_TOKENS_PRICING_STORE,
  BYMAX_AI_TOKENS_TELEMETRY,
  BYMAX_AI_TOKENS_TOKENIZER,
  BYMAX_AI_TOKENS_WALLET_STORE,
} from './bymax-ai-tokens.constants'
import { applyDefaults, validateOptions } from './config'
import type { ResolvedAiTokensOptions } from './config'
import { AiTokensException } from './errors'
import { EventDispatcher } from './events/event-dispatcher'
import {
  createBudgetEventHooks,
  createLedgerAuditHook,
  createMeteringEventHooks,
  createWalletEventHooks,
} from './events/event-hooks'
import { BudgetGuard, MeteringInterceptor } from './enforcement'
import { HoldReaper } from './enforcement/hold-reaper'
import type {
  BymaxAiTokensModuleAsyncOptions,
  BymaxAiTokensModuleOptions,
  BymaxAiTokensModuleOptionsFactory,
  IBudgetStore,
  ILedgerStore,
  IPricingStore,
  ITelemetrySink,
  IWalletStore,
} from './interfaces'
import { TelemetryEmitter } from './telemetry/otel-emitter'
import { ContentCapture } from './services/content-capture'
import { BudgetService, LedgerService, MarkupResolver, MeteringService, PricingService, UsageReportService, WalletService } from './services'

/** The tokens always provided and exported, regardless of which features are enabled. */
const CORE_TOKENS = [
  BYMAX_AI_TOKENS_OPTIONS,
  BYMAX_AI_TOKENS_LEDGER_STORE,
  BYMAX_AI_TOKENS_PRICING_STORE,
  BYMAX_AI_TOKENS_TOKENIZER,
  BYMAX_AI_TOKENS_EVENT_SINK,
  BYMAX_AI_TOKENS_TELEMETRY,
  BYMAX_AI_TOKENS_CONTENT_STORE,
  BYMAX_AI_TOKENS_LOGGER,
]

/** The services always exported by both configuration paths. */
const CORE_SERVICE_EXPORTS = [PricingService, LedgerService, MeteringService, MeteringInterceptor, UsageReportService]

/** All wallet/budget tokens + services (exported unconditionally by `forRootAsync`). */
const FEATURE_EXPORTS = [BYMAX_AI_TOKENS_WALLET_STORE, BYMAX_AI_TOKENS_BUDGET_STORE, BYMAX_AI_TOKENS_BUDGET_COUNTER, WalletService, BudgetService, BudgetGuard]

/** Build a token provider whose value is derived from the resolved options. */
function fromOptions(token: symbol, factory: (options: ResolvedAiTokensOptions) => unknown): Provider {
  return { provide: token, useFactory: factory, inject: [BYMAX_AI_TOKENS_OPTIONS] }
}

/**
 * The options-agnostic core providers shared by both configuration paths. Every
 * value derives from the injected {@link BYMAX_AI_TOKENS_OPTIONS} token, so the sync
 * and async paths wire an identical provider set (the `OPTIONS` provider itself
 * differs — `useValue` vs `useFactory`).
 */
function buildCoreProviders(): Provider[] {
  return [...buildInfraProviders(), ...buildServiceProviders()]
}

/** The fanned-out store/port tokens plus the pricing/ledger/markup/dispatcher primitives. */
function buildInfraProviders(): Provider[] {
  return [
    fromOptions(BYMAX_AI_TOKENS_LEDGER_STORE, (o) => o.store),
    fromOptions(BYMAX_AI_TOKENS_PRICING_STORE, (o) => o.store),
    fromOptions(BYMAX_AI_TOKENS_TOKENIZER, (o) => o.tokenizer ?? null),
    fromOptions(BYMAX_AI_TOKENS_EVENT_SINK, (o) => o.events.sink ?? null),
    fromOptions(BYMAX_AI_TOKENS_TELEMETRY, (o) => (o.telemetry.enabled ? o.telemetry.sink : null)),
    fromOptions(BYMAX_AI_TOKENS_CONTENT_STORE, (o) => (o.content.enabled ? o.content.store : null)),
    { provide: BYMAX_AI_TOKENS_LOGGER, useValue: null },
    {
      provide: PricingService,
      useFactory: (options: ResolvedAiTokensOptions, store: IPricingStore): PricingService => new PricingService(options, store),
      inject: [BYMAX_AI_TOKENS_OPTIONS, BYMAX_AI_TOKENS_PRICING_STORE],
    },
    {
      provide: EventDispatcher,
      useFactory: (moduleRef: ModuleRef, options: ResolvedAiTokensOptions): EventDispatcher => new EventDispatcher(moduleRef, options),
      inject: [ModuleRef, BYMAX_AI_TOKENS_OPTIONS],
    },
    {
      provide: LedgerService,
      useFactory: (options: ResolvedAiTokensOptions, store: ILedgerStore, dispatcher: EventDispatcher): LedgerService =>
        new LedgerService(store, options, createLedgerAuditHook(dispatcher)),
      inject: [BYMAX_AI_TOKENS_OPTIONS, BYMAX_AI_TOKENS_LEDGER_STORE, EventDispatcher],
    },
    {
      provide: MarkupResolver,
      useFactory: (options: ResolvedAiTokensOptions): MarkupResolver => new MarkupResolver(options),
      inject: [BYMAX_AI_TOKENS_OPTIONS],
    },
  ]
}

/** The facade services + the hold reaper and interceptor (options-agnostic). */
function buildServiceProviders(): Provider[] {
  return [
    {
      provide: MeteringService,
      useFactory: (
        ledger: LedgerService,
        pricing: PricingService,
        markup: MarkupResolver,
        options: ResolvedAiTokensOptions,
        dispatcher: EventDispatcher,
        telemetrySink: ITelemetrySink | null,
        wallets?: WalletService | null,
        budgets?: BudgetService | null,
      ): MeteringService =>
        new MeteringService(ledger, pricing, markup, options, createMeteringEventHooks(dispatcher), wallets, budgets, undefined, new TelemetryEmitter(telemetrySink), new ContentCapture(options.content)),
      inject: [
        LedgerService,
        PricingService,
        MarkupResolver,
        BYMAX_AI_TOKENS_OPTIONS,
        EventDispatcher,
        BYMAX_AI_TOKENS_TELEMETRY,
        { token: WalletService, optional: true },
        { token: BudgetService, optional: true },
      ],
    },
    {
      // Registered unconditionally: hold() writes pending rows whenever it is used,
      // even without wallets/budgets, and a stranded hold must still be reclaimed.
      provide: HoldReaper,
      useFactory: (ledger: LedgerService, metering: MeteringService, options: ResolvedAiTokensOptions): HoldReaper => new HoldReaper(ledger, metering, options),
      inject: [LedgerService, MeteringService, BYMAX_AI_TOKENS_OPTIONS],
    },
    {
      provide: UsageReportService,
      useFactory: (options: ResolvedAiTokensOptions, ledgerStore: ILedgerStore, pricingStore: IPricingStore, dispatcher: EventDispatcher): UsageReportService =>
        new UsageReportService(ledgerStore, pricingStore, options, (action, details) => void dispatcher.audit(action, details)),
      inject: [BYMAX_AI_TOKENS_OPTIONS, BYMAX_AI_TOKENS_LEDGER_STORE, BYMAX_AI_TOKENS_PRICING_STORE, EventDispatcher],
    },
    MeteringInterceptor,
  ]
}

/** The wallet service provider — an instance when wallets are enabled, else `null`. */
function walletServiceProvider(): Provider {
  return {
    provide: WalletService,
    useFactory: (options: ResolvedAiTokensOptions, store: IWalletStore, dispatcher: EventDispatcher): WalletService | null =>
      options.wallets.enabled ? new WalletService(store, options.wallets, createWalletEventHooks(dispatcher)) : null,
    inject: [BYMAX_AI_TOKENS_OPTIONS, BYMAX_AI_TOKENS_WALLET_STORE, EventDispatcher],
  }
}

/** The budget service provider — an instance when budgets are enabled, else `null`. */
function budgetServiceProvider(): Provider {
  return {
    provide: BudgetService,
    useFactory: (options: ResolvedAiTokensOptions, store: IBudgetStore, ledger: LedgerService, dispatcher: EventDispatcher): BudgetService | null =>
      options.budgets.enabled ? new BudgetService(store, ledger, options.budgets, undefined, createBudgetEventHooks(dispatcher)) : null,
    inject: [BYMAX_AI_TOKENS_OPTIONS, BYMAX_AI_TOKENS_BUDGET_STORE, LedgerService, EventDispatcher],
  }
}

/** The budget guard provider — an instance when budgets are enabled, else `null`. */
function budgetGuardProvider(): Provider {
  return {
    provide: BudgetGuard,
    useFactory: (options: ResolvedAiTokensOptions, budgets: BudgetService, metering: MeteringService, reflector: Reflector): BudgetGuard | null =>
      options.budgets.enabled ? new BudgetGuard(budgets, metering, reflector, options) : null,
    inject: [BYMAX_AI_TOKENS_OPTIONS, BudgetService, MeteringService, Reflector],
  }
}

/** Wallet/budget providers registered ONLY when their feature block is present (sync path, §4.6). */
function buildSyncFeatureProviders(resolved: ResolvedAiTokensOptions): Provider[] {
  const providers: Provider[] = []
  if (resolved.wallets.enabled) {
    providers.push({ provide: BYMAX_AI_TOKENS_WALLET_STORE, useValue: resolved.store }, walletServiceProvider())
  }
  if (resolved.budgets.enabled) {
    providers.push(
      { provide: BYMAX_AI_TOKENS_BUDGET_STORE, useValue: resolved.store },
      { provide: BYMAX_AI_TOKENS_BUDGET_COUNTER, useValue: resolved.budgets.counter ?? null },
      budgetServiceProvider(),
      budgetGuardProvider(),
    )
  }
  return providers
}

/** Wallet/budget providers registered UNCONDITIONALLY (async path), resolving to `null` when disabled. */
function buildAsyncFeatureProviders(): Provider[] {
  return [
    fromOptions(BYMAX_AI_TOKENS_WALLET_STORE, (o) => (o.wallets.enabled ? o.store : null)),
    fromOptions(BYMAX_AI_TOKENS_BUDGET_STORE, (o) => (o.budgets.enabled ? o.store : null)),
    fromOptions(BYMAX_AI_TOKENS_BUDGET_COUNTER, (o) => (o.budgets.enabled ? (o.budgets.counter ?? null) : null)),
    walletServiceProvider(),
    budgetServiceProvider(),
    budgetGuardProvider(),
  ]
}

/** The exported tokens/services for the enabled features (sync path). */
function buildSyncFeatureExports(resolved: ResolvedAiTokensOptions): (symbol | typeof WalletService | typeof BudgetService | typeof BudgetGuard)[] {
  const tokens: (symbol | typeof WalletService | typeof BudgetService | typeof BudgetGuard)[] = []
  if (resolved.wallets.enabled) tokens.push(BYMAX_AI_TOKENS_WALLET_STORE, WalletService)
  if (resolved.budgets.enabled) tokens.push(BYMAX_AI_TOKENS_BUDGET_STORE, BYMAX_AI_TOKENS_BUDGET_COUNTER, BudgetService, BudgetGuard)
  return tokens
}

/** Validate + resolve raw options loaded from an async source, mapping any failure to `AI_TOKENS_INVALID_CONFIG`. */
async function safeResolve(load: Promise<BymaxAiTokensModuleOptions>): Promise<ResolvedAiTokensOptions> {
  try {
    const raw = await load
    validateOptions(raw)
    return applyDefaults(raw)
  } catch (error) {
    if (error instanceof AiTokensException) throw error
    // Stryker disable next-line ObjectLiteral,StringLiteral -- error context and reason are internal diagnostics; tests check error code only
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'the async options factory rejected or produced invalid options' })
  }
}

/** Build the `BYMAX_AI_TOKENS_OPTIONS` provider (+ the factory class, for `useClass`) from the async descriptor. */
function buildAsyncOptionsProviders(descriptor: BymaxAiTokensModuleAsyncOptions): Provider[] {
  if (descriptor.useFactory !== undefined) {
    const factory = descriptor.useFactory
    return [
      {
        provide: BYMAX_AI_TOKENS_OPTIONS,
        useFactory: (...args: unknown[]): Promise<ResolvedAiTokensOptions> => safeResolve(Promise.resolve(factory(...args))),
        inject: [...(descriptor.inject ?? [])],
      },
    ]
  }
  const factoryToken = descriptor.useClass ?? descriptor.useExisting
  if (factoryToken === undefined) {
    // Stryker disable next-line ObjectLiteral,StringLiteral -- error context and reason are internal diagnostics; tests check error code only
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'forRootAsync requires useFactory, useClass, or useExisting' })
  }
  const optionsProvider: Provider = {
    provide: BYMAX_AI_TOKENS_OPTIONS,
    useFactory: (factory: BymaxAiTokensModuleOptionsFactory): Promise<ResolvedAiTokensOptions> => safeResolve(Promise.resolve(factory.createAiTokensOptions())),
    inject: [factoryToken],
  }
  return descriptor.useClass !== undefined ? [optionsProvider, { provide: descriptor.useClass, useClass: descriptor.useClass }] : [optionsProvider]
}

/**
 * The root NestJS dynamic module for `@bymax-one/nest-ai-tokens`. Register once
 * at application root with `forRoot()` or `forRootAsync()`. Exports the metering,
 * pricing, ledger, wallet, budget, report services and the enforcement primitives.
 */
@Global()
@Module({})
export class BymaxAiTokensModule {
  /**
   * Configure the module synchronously. Validates and resolves the options, then
   * returns the wired dynamic module. `PricingService.onModuleInit` seeds the price
   * registry when `pricing.seedFromSnapshot` is enabled.
   *
   * @param options The module options.
   * @returns The configured dynamic module.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` / `AI_TOKENS_FX_REQUIRED` on invalid options.
   */
  static forRoot(options: BymaxAiTokensModuleOptions): DynamicModule {
    validateOptions(options)
    const resolved = applyDefaults(options)
    return {
      module: BymaxAiTokensModule,
      providers: [{ provide: BYMAX_AI_TOKENS_OPTIONS, useValue: resolved }, ...buildCoreProviders(), ...buildSyncFeatureProviders(resolved)],
      exports: [...CORE_TOKENS, ...CORE_SERVICE_EXPORTS, ...buildSyncFeatureExports(resolved)],
    }
  }

  /**
   * Configure the module asynchronously, resolving the options from injected
   * dependencies via `useFactory`/`useClass`/`useExisting` — the family pattern.
   * The resolved options feed the SAME core providers as {@link forRoot}; the
   * wallet/budget providers are registered unconditionally and resolve to `null`
   * when their feature is disabled.
   *
   * @param asyncOptions The async options descriptor.
   * @returns The configured dynamic module.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when no async style is supplied or the factory rejects/produces invalid options.
   */
  static forRootAsync(asyncOptions: BymaxAiTokensModuleAsyncOptions): DynamicModule {
    return {
      module: BymaxAiTokensModule,
      imports: [...(asyncOptions.imports ?? [])],
      providers: [...buildAsyncOptionsProviders(asyncOptions), ...buildCoreProviders(), ...buildAsyncFeatureProviders()],
      exports: [...CORE_TOKENS, ...CORE_SERVICE_EXPORTS, ...FEATURE_EXPORTS],
    }
  }
}
