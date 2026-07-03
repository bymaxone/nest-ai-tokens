/**
 * @fileoverview The event envelope, the event-type union, and one payload type
 * per event in the catalog (see spec §12). Delivery is at-least-once, so `id` is
 * the consumer's dedupe key. `bigint` payload fields cross a JSON boundary as
 * decimal strings (§15.5) — in-process delivery keeps them as `bigint`.
 * @layer shared
 */

import type { AiOperation } from '../constants/operations.constants'
import type { ServiceTier } from '../constants/service-tiers.constants'
import type { MeteringScope, ProviderId } from './catalogs'
import type { BudgetPolicy } from './budget'

/** Every event `type` the library emits. */
export type AiTokensEventType =
  | 'ai_tokens.usage.recorded'
  | 'ai_tokens.usage.reversed'
  | 'ai_tokens.hold.released'
  | 'ai_tokens.budget.threshold_crossed'
  | 'ai_tokens.budget.exceeded'
  | 'ai_tokens.budget.projected_exceeded'
  | 'ai_tokens.wallet.low_balance'
  | 'ai_tokens.wallet.depleted'
  | 'ai_tokens.wallet.granted'
  | 'ai_tokens.price.missing'
  | 'ai_tokens.audit'

/** The at-least-once event envelope. */
export interface AiTokensEvent<T = unknown> {
  /** UUID — the consumer's dedupe key. */
  id: string
  type: AiTokensEventType
  occurredAt: Date
  tenantId: string
  scope?: MeteringScope
  data: T
}

/** A per-window spend snapshot shared by budget event payloads. */
export interface BudgetDimensionSnapshot {
  nanoUsd?: bigint
  tokens?: number
  count?: number
}

/** `ai_tokens.usage.recorded` payload. */
export interface UsageRecordedEventData {
  usageRecordId: string
  feature: string
  provider: ProviderId
  model: string
  serviceTier: ServiceTier
  totalTokens: number
  rawCostNanoUsd: bigint
  billedCostNanoUsd: bigint
  enforced: boolean
  isSystemCost: boolean
}

/** `ai_tokens.usage.reversed` payload. */
export interface UsageReversedEventData {
  usageRecordId: string
  reversalRecordId: string
  reason: string
}

/** `ai_tokens.hold.released` payload. */
export interface HoldReleasedEventData {
  holdId: string
  reason: string
  expired: boolean
}

/** `ai_tokens.budget.threshold_crossed` payload. */
export interface BudgetThresholdCrossedEventData {
  budgetId: string
  threshold: number
  usedFraction: number
  limit: BudgetDimensionSnapshot
  spent: BudgetDimensionSnapshot
  remaining: BudgetDimensionSnapshot
  resetsAt: Date | null
}

/** `ai_tokens.budget.exceeded` payload. */
export interface BudgetExceededEventData {
  budgetId: string
  policy: BudgetPolicy
  dimension: 'cost' | 'tokens' | 'count'
  limit: BudgetDimensionSnapshot
  spent: BudgetDimensionSnapshot
  resetsAt: Date | null
}

/** `ai_tokens.budget.projected_exceeded` payload. */
export interface BudgetProjectedExceededEventData {
  budgetId: string
  projectedAt: Date
  usedFraction: number
  resetsAt: Date | null
}

/** `ai_tokens.wallet.low_balance` payload. */
export interface WalletLowBalanceEventData {
  walletId: string
  balanceNanoUsd: bigint
  thresholdFraction: number
}

/** `ai_tokens.wallet.depleted` payload. */
export interface WalletDepletedEventData {
  walletId: string
  balanceNanoUsd: bigint
}

/** `ai_tokens.wallet.granted` payload. */
export interface WalletGrantedEventData {
  walletId: string
  entryId: string
  amountNanoUsd: bigint
  expiresAt?: Date
}

/** `ai_tokens.price.missing` payload. */
export interface PriceMissingEventData {
  provider: ProviderId
  model: string
  operation: AiOperation
  serviceTier: ServiceTier
  usageRecordId: string
}

/** `ai_tokens.audit` payload — an admin-plane mutation (§14.4). */
export interface AuditEventData {
  action: string
  actor?: string
  details: Record<string, unknown>
}
