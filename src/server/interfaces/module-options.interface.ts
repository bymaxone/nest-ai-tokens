/**
 * @fileoverview The module configuration contract (spec §4.1) and the async
 * dynamic-module options pattern. `store` is required; every feature block is
 * opt-in and enables its service/guard only when present. All persisted money is
 * nano-USD regardless of `currency` — that setting is presentation-only (§7.4).
 * @layer server
 */

import type { ExecutionContext, ModuleMetadata, Type } from '@nestjs/common'
import type { Budget, BudgetPolicy, BudgetStatus, RatingMode } from '../../shared'
import type { IAiTokensStore } from './ai-tokens-store.interface'
import type { IBudgetCounterStore } from './budget-counter-store.interface'
import type { IContentStore } from './content-store.interface'
import type { IEventSink } from './event-sink.interface'
import type { IMarkupPolicy } from './markup-policy.interface'
import type { ITelemetrySink } from './telemetry-sink.interface'
import type { ITokenizer } from './tokenizer.interface'
import type { MeteringContext } from './metering-context.interface'

/** The synchronous configuration for `BymaxAiTokensModule.forRoot()`. */
export interface BymaxAiTokensModuleOptions {
  /** Persistence adapter implementing the storage ports. REQUIRED. */
  store: IAiTokensStore

  /**
   * Resolves the metering scope from the current request for `BudgetGuard` and
   * `MeteringInterceptor`. TRUSTED INPUT: read the host's VERIFIED auth context
   * (JWT claims/session), never client-supplied body/query fields. REQUIRED only
   * when the guard/interceptor/decorators are used.
   */
  scopeResolver?: (ctx: ExecutionContext) => MeteringContext | Promise<MeteringContext>

  /** Default rating mode; overridable per call/preset. Default `'rate-table'`. */
  ratingMode?: RatingMode

  /** Presentation currency for reports/exports/status. Persisted money is always nano-USD. Default `'USD'`. */
  currency?: string

  /**
   * FX resolver USD → `currency`, returning integer nano-units of `currency` per
   * USD. REQUIRED when `currency !== 'USD'` (else `AI_TOKENS_FX_REQUIRED` at init).
   */
  fx?: (date: Date, currency: string) => Promise<bigint> | bigint

  /** Price registry behavior. */
  pricing?: {
    /** Seed from `MODEL_PRICES_SEED` on first boot (idempotent, advisory-locked). Default `true`. */
    seedFromSnapshot?: boolean
    /** Throw `AI_TOKENS_PRICE_NOT_FOUND` when no rate matches; else cost 0 + `priceMissing`. Default `true`. */
    strict?: boolean
    /** In-memory rate cache TTL. Default `300_000` ms. */
    cacheTtlMs?: number
    /** Model-ID alias map consulted during rate resolution (§6.6). */
    modelAliases?: Record<string, string>
  }

  /**
   * Markup / margin — a flat multiplier or a policy object. Validated finite, `> 0`,
   * at most 4 decimal places. Default `1.0` (bill at cost).
   */
  markup?: number | IMarkupPolicy

  /** Enables `WalletService` when present. */
  wallets?: {
    /** 1 credit = this many nano-USD. Default `1_000_000_000n` (1 credit = $1). */
    creditRateNanoUsd?: bigint
    /** Allowed negative balance (postpaid overdraft) in nano-USD. Default `0n`. */
    overdraftNanoUsd?: bigint
    /** Grant burn order. Default `'expiry'`. */
    burnOrder?: 'expiry' | 'priority' | 'fifo'
  }

  /** Enables `BudgetService` + `BudgetGuard` when present. */
  budgets?: {
    /** Default enforcement policy when a budget is exceeded. Default `'block'`. */
    defaultPolicy?: BudgetPolicy
    /** Soft-alert thresholds as fractions of the limit. Default `[0.8, 1.0]`. */
    alertThresholds?: number[]
    /** Optional live cross-replica spend counter (Redis). Falls back to DB atomic consume. */
    counter?: IBudgetCounterStore
    /** Enforce budgets as a hard ceiling even if the counter store is unavailable. Default `true`. */
    failClosed?: boolean
    /** Host callback invoked when a matched budget has policy `'throttle'`. */
    onThrottle?: (ctx: { context: MeteringContext; budget: Budget; status: BudgetStatus }) => void | Promise<void>
  }

  /** Hold lifecycle (applies whenever `hold()`/`meter()` is used). */
  holds?: {
    /** Pending-hold TTL; expired holds are swept. Default `3_600` s. */
    ttlSeconds?: number
    /** Reaper sweep interval. Default `300` s. */
    reaperIntervalSeconds?: number
  }

  /** Ledger extras. */
  ledger?: {
    /** Per-tenant tamper-evident hash chain over posted records (§8.6). Default `false`. */
    hashChain?: boolean
  }

  /** Pre-flight token estimation used by `hold()` when the caller supplies text instead of counts. */
  tokenizer?: ITokenizer

  /** Typed event emission (§12). */
  events?: {
    /** Emit through `@nestjs/event-emitter` when installed. Default `true`. */
    emitter?: boolean
    /** Additional programmatic sink (webhooks, queues). */
    sink?: IEventSink
  }

  /** OpenTelemetry emission of `gen_ai.*` attributes and metrics. */
  telemetry?: {
    sink?: ITelemetrySink
    /** Emit token-usage + duration metrics. Default `true` when a sink is present. */
    metrics?: boolean
  }

  /** Reporting + export. */
  reporting?: {
    /** Max rows a single export streams before requiring pagination. Default `1_000_000`. */
    maxExportRows?: number
  }

  /**
   * PII policy for the optional prompt/response text sidecar. The immutable ledger
   * NEVER stores text. Default `undefined` (no text is ever stored).
   */
  content?: {
    store: IContentStore
    /** Mask function applied before persistence. */
    mask?: (text: string) => string
    /** Retention in seconds. Default `604_800` (7 days). */
    ttlSeconds?: number
  }
}

/** Factory contract for `useExisting` / `useClass` async configuration. */
export interface BymaxAiTokensModuleOptionsFactory {
  createAiTokensOptions(): BymaxAiTokensModuleOptions | Promise<BymaxAiTokensModuleOptions>
}

/**
 * Asynchronous configuration for `BymaxAiTokensModule.forRootAsync()` — the
 * standard NestJS async dynamic-module options shape (the async factory is not
 * yet wired; the contract is defined here).
 */
export interface BymaxAiTokensModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: unknown[]) => BymaxAiTokensModuleOptions | Promise<BymaxAiTokensModuleOptions>
  inject?: readonly (string | symbol | Type<unknown>)[]
  useExisting?: Type<BymaxAiTokensModuleOptionsFactory>
  useClass?: Type<BymaxAiTokensModuleOptionsFactory>
}
