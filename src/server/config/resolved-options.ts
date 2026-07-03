/**
 * @fileoverview The fully-resolved options every service consumes (spec §4.2/§4.6).
 * Each opt-in feature is a discriminated union — `{ enabled: false }` or
 * `{ enabled: true, ...resolved }` — so services never branch on `undefined`.
 * @layer server
 */

import type { ExecutionContext } from '@nestjs/common'
import type { Budget, BudgetPolicy, BudgetStatus, RatingMode } from '../../shared'
import type {
  IAiTokensStore,
  IBudgetCounterStore,
  IContentStore,
  IEventSink,
  IMarkupPolicy,
  ITelemetrySink,
  ITokenizer,
  MeteringContext,
} from '../interfaces'

/** Resolved pricing behavior. */
export interface ResolvedPricingOptions {
  seedFromSnapshot: boolean
  strict: boolean
  cacheTtlMs: number
  modelAliases: Record<string, string>
}

/** Resolved hold lifecycle. */
export interface ResolvedHoldsOptions {
  ttlSeconds: number
  reaperIntervalSeconds: number
}

/** Resolved ledger extras. */
export interface ResolvedLedgerOptions {
  hashChain: boolean
}

/** Resolved event emission. */
export interface ResolvedEventsOptions {
  emitter: boolean
  sink?: IEventSink | undefined
}

/** Resolved reporting limits. */
export interface ResolvedReportingOptions {
  maxExportRows: number
}

/** Resolved wallet feature (disabled or fully-resolved). */
export type ResolvedWalletsOptions =
  | { enabled: false }
  | {
      enabled: true
      creditRateNanoUsd: bigint
      overdraftNanoUsd: bigint
      burnOrder: 'expiry' | 'priority' | 'fifo'
    }

/** Resolved budget feature (disabled or fully-resolved). */
export type ResolvedBudgetsOptions =
  | { enabled: false }
  | {
      enabled: true
      defaultPolicy: BudgetPolicy
      alertThresholds: readonly number[]
      failClosed: boolean
      counter?: IBudgetCounterStore | undefined
      onThrottle?: BudgetThrottleCallback | undefined
    }

/** The host callback invoked when a matched budget has policy `'throttle'`. */
export type BudgetThrottleCallback = (ctx: {
  context: MeteringContext
  budget: Budget
  status: BudgetStatus
}) => void | Promise<void>

/** Resolved telemetry feature (disabled or fully-resolved). */
export type ResolvedTelemetryOptions =
  | { enabled: false }
  | { enabled: true; sink: ITelemetrySink; metrics: boolean }

/** Resolved content sidecar feature (disabled or fully-resolved). */
export type ResolvedContentOptions =
  | { enabled: false }
  | {
      enabled: true
      store: IContentStore
      mask?: ((text: string) => string) | undefined
      ttlSeconds: number
    }

/** The fully-resolved options object bound under `BYMAX_AI_TOKENS_OPTIONS`. */
export interface ResolvedAiTokensOptions {
  store: IAiTokensStore
  scopeResolver?: ((ctx: ExecutionContext) => MeteringContext | Promise<MeteringContext>) | undefined
  ratingMode: RatingMode
  currency: string
  fx?: ((date: Date, currency: string) => Promise<bigint> | bigint) | undefined
  /** A resolved 4-dp multiplier or a markup policy. */
  markup: number | IMarkupPolicy
  pricing: ResolvedPricingOptions
  wallets: ResolvedWalletsOptions
  budgets: ResolvedBudgetsOptions
  holds: ResolvedHoldsOptions
  ledger: ResolvedLedgerOptions
  tokenizer?: ITokenizer | undefined
  events: ResolvedEventsOptions
  telemetry: ResolvedTelemetryOptions
  reporting: ResolvedReportingOptions
  content: ResolvedContentOptions
}
