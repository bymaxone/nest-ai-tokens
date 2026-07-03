/**
 * @fileoverview The `@Global()` dynamic module (spec §2.1/§4.6). `forRoot()`
 * validates and resolves the options, then fans the single `store` object out
 * under each per-port DI token; opt-in features register their store tokens only
 * when configured. The module is global so the guard/interceptor are injectable
 * anywhere and exactly one ledger/pricing instance exists per app. Only the
 * synchronous `forRoot` is provided here.
 * @layer server/module
 */

import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
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
import { EventDispatcher } from './events/event-dispatcher'
import {
  createBudgetEventHooks,
  createLedgerAuditHook,
  createMeteringEventHooks,
  createWalletEventHooks,
} from './events/event-hooks'
import { BudgetGuard } from './enforcement'
import { HoldReaper } from './enforcement/hold-reaper'
import type { BymaxAiTokensModuleOptions, IBudgetStore, ILedgerStore, IPricingStore, IWalletStore } from './interfaces'
import { BudgetService, LedgerService, MarkupResolver, MeteringService, PricingService, WalletService } from './services'

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

/** Build the always-present providers: the resolved options, fanned-out ports, and PricingService. */
function buildCoreProviders(resolved: ResolvedAiTokensOptions): Provider[] {
  return [
    { provide: BYMAX_AI_TOKENS_OPTIONS, useValue: resolved },
    { provide: BYMAX_AI_TOKENS_LEDGER_STORE, useValue: resolved.store },
    { provide: BYMAX_AI_TOKENS_PRICING_STORE, useValue: resolved.store },
    { provide: BYMAX_AI_TOKENS_TOKENIZER, useValue: resolved.tokenizer ?? null },
    { provide: BYMAX_AI_TOKENS_EVENT_SINK, useValue: resolved.events.sink ?? null },
    { provide: BYMAX_AI_TOKENS_TELEMETRY, useValue: resolved.telemetry.enabled ? resolved.telemetry.sink : null },
    { provide: BYMAX_AI_TOKENS_CONTENT_STORE, useValue: resolved.content.enabled ? resolved.content.store : null },
    { provide: BYMAX_AI_TOKENS_LOGGER, useValue: null },
    {
      provide: PricingService,
      useFactory: (options: ResolvedAiTokensOptions, store: IPricingStore): PricingService =>
        new PricingService(options, store),
      inject: [BYMAX_AI_TOKENS_OPTIONS, BYMAX_AI_TOKENS_PRICING_STORE],
    },
    {
      provide: EventDispatcher,
      useFactory: (moduleRef: ModuleRef, options: ResolvedAiTokensOptions): EventDispatcher =>
        new EventDispatcher(moduleRef, options),
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
    {
      provide: MeteringService,
      useFactory: (
        ledger: LedgerService,
        pricing: PricingService,
        markup: MarkupResolver,
        options: ResolvedAiTokensOptions,
        dispatcher: EventDispatcher,
        wallets?: WalletService,
        budgets?: BudgetService,
      ): MeteringService =>
        new MeteringService(ledger, pricing, markup, options, createMeteringEventHooks(dispatcher), wallets, budgets),
      inject: [
        LedgerService,
        PricingService,
        MarkupResolver,
        BYMAX_AI_TOKENS_OPTIONS,
        EventDispatcher,
        { token: WalletService, optional: true },
        { token: BudgetService, optional: true },
      ],
    },
    {
      // Registered unconditionally: hold() writes pending rows whenever it is used,
      // even without wallets/budgets, and a stranded hold must still be reclaimed.
      provide: HoldReaper,
      useFactory: (ledger: LedgerService, metering: MeteringService, options: ResolvedAiTokensOptions): HoldReaper =>
        new HoldReaper(ledger, metering, options),
      inject: [LedgerService, MeteringService, BYMAX_AI_TOKENS_OPTIONS],
    },
  ]
}

/** Wallet/budget port tokens and services register only when their feature block is present (§4.6). */
function buildFeatureProviders(resolved: ResolvedAiTokensOptions): Provider[] {
  const providers: Provider[] = []
  if (resolved.wallets.enabled) {
    const walletOptions = resolved.wallets
    providers.push({ provide: BYMAX_AI_TOKENS_WALLET_STORE, useValue: resolved.store })
    providers.push({
      provide: WalletService,
      useFactory: (store: IWalletStore, dispatcher: EventDispatcher): WalletService =>
        new WalletService(store, walletOptions, createWalletEventHooks(dispatcher)),
      inject: [BYMAX_AI_TOKENS_WALLET_STORE, EventDispatcher],
    })
  }
  if (resolved.budgets.enabled) {
    const budgetOptions = resolved.budgets
    providers.push({ provide: BYMAX_AI_TOKENS_BUDGET_STORE, useValue: resolved.store })
    providers.push({ provide: BYMAX_AI_TOKENS_BUDGET_COUNTER, useValue: resolved.budgets.counter ?? null })
    providers.push({
      provide: BudgetService,
      useFactory: (store: IBudgetStore, ledger: LedgerService, dispatcher: EventDispatcher): BudgetService =>
        new BudgetService(store, ledger, budgetOptions, undefined, createBudgetEventHooks(dispatcher)),
      inject: [BYMAX_AI_TOKENS_BUDGET_STORE, LedgerService, EventDispatcher],
    })
    providers.push(BudgetGuard)
  }
  return providers
}

/** The tokens and services exported for each enabled feature. */
function buildFeatureExports(
  resolved: ResolvedAiTokensOptions,
): (symbol | typeof WalletService | typeof BudgetService | typeof BudgetGuard)[] {
  const tokens: (symbol | typeof WalletService | typeof BudgetService | typeof BudgetGuard)[] = []
  if (resolved.wallets.enabled) tokens.push(BYMAX_AI_TOKENS_WALLET_STORE, WalletService)
  if (resolved.budgets.enabled) tokens.push(BYMAX_AI_TOKENS_BUDGET_STORE, BYMAX_AI_TOKENS_BUDGET_COUNTER, BudgetService, BudgetGuard)
  return tokens
}

@Global()
@Module({})
export class BymaxAiTokensModule {
  /**
   * Configure the module synchronously. Validates and resolves the options, then
   * returns the wired dynamic module. `PricingService.onModuleInit` seeds the
   * price registry when `pricing.seedFromSnapshot` is enabled.
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
      providers: [...buildCoreProviders(resolved), ...buildFeatureProviders(resolved)],
      exports: [...CORE_TOKENS, PricingService, LedgerService, MeteringService, ...buildFeatureExports(resolved)],
    }
  }
}
