/**
 * @fileoverview Public barrel for the main `.` (server) subpath — the NestJS
 * dynamic module, services, presets, ports, DI tokens, and errors. Re-exports the
 * full `./shared` surface so server consumers use a single import; `./shared`
 * exists for frontends/workers/edge code that must stay NestJS-free (§3.3).
 * @layer server
 */

export { BymaxAiTokensModule } from './bymax-ai-tokens.module'
export * from './bymax-ai-tokens.constants'
export { PricingService, LedgerService, MeteringService, WalletService, BudgetService } from './services'
export type {
  ResolveRateInput,
  LedgerAppendInput,
  RecordInput,
  EstimateCostInput,
  WalletServiceOptions,
  WalletBalance,
  GrantInput,
  DebitInput,
  RefundInput,
  AdjustInput,
  BudgetServiceOptions,
  UpsertBudgetInput,
} from './services'
export { toJsonSafe } from './utils/to-json-safe'
export type { JsonSafe } from './utils/to-json-safe'
export { StreamUsageCollector } from './streaming/stream-usage-collector'
export type { StreamUsageCollectorOptions } from './streaming/stream-usage-collector'
export { providerPresets } from './config/provider-presets'
export {
  BudgetGuard,
  MeteringInterceptor,
  Meter,
  RequireBudget,
  AiFeature,
  METER_METADATA,
  REQUIRE_BUDGET_METADATA,
  AI_FEATURE_METADATA,
} from './enforcement'
export type { RequestAiTokens, MeterConfig, RequireBudgetConfig } from './enforcement'
export * from './errors'
export type * from './interfaces'

// Re-export rule (family precedent): the server entry re-exports every ./shared symbol.
export * from '../shared'
