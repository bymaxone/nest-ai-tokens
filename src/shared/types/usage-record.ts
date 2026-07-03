/**
 * @fileoverview The immutable ledger row for one AI call (or its hold), its
 * lifecycle status, the ledger query filter, and the append insert type.
 * @layer shared
 */

import type { AiOperation } from '../constants/operations.constants'
import type { ServiceTier } from '../constants/service-tiers.constants'
import type { MeteringScope, ProviderId } from './catalogs'

/** Lifecycle status of a usage record (see spec §8.3). */
export type UsageStatus = 'pending' | 'posted' | 'reversed' | 'released'

/**
 * One append-only ledger entry for a single AI call (or its hold). All money is
 * integer nano-USD; token counts are plain `number`.
 */
export interface UsageRecord {
  id: string
  tenantId: string
  /** The PAYER — the subject whose wallet/budget is consumed. */
  scope: MeteringScope
  /** Optional distinct beneficiary (reporting dimension only). */
  beneficiary?: MeteringScope
  /** Optional actor who triggered the call (audit). */
  requestedBy?: string
  provider: ProviderId
  /** Model reported by the response (pricing follows this). */
  model: string
  /** Model the host requested, when supplied (drift audit; §6.6). */
  requestedModel?: string
  operation: AiOperation
  serviceTier: ServiceTier
  /** Caller-supplied logical operation, e.g. `'workout.generate'`. */
  feature: string
  /** Free-form cost-attribution labels (≤ 10), e.g. `['team:research']`. */
  tags: string[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  reasoningTokens: number
  audioInTokens: number
  audioOutTokens: number
  imageInTokens: number
  imageOutTokens: number
  totalTokens: number
  /** Non-token line items actually rated, e.g. `{ web_search_request: 2 }`. */
  extraUnits?: Record<string, number>
  /** `null` for provider-reported mode or a priceMissing record. */
  priceVersionId: string | null
  /** Provider cost (tokens + surcharges). */
  rawCostNanoUsd: bigint
  /** The non-token share of `rawCostNanoUsd`. */
  surchargeNanoUsd: bigint
  /** After markup — what the customer pays. */
  billedCostNanoUsd: bigint
  /** The resolved 4-dp markup value actually applied. */
  markupMultiplier: number
  /** `'USD'` in v0.1 (§7.4). */
  currency: string
  /** Rated at 0 in non-strict mode; a backfill target. */
  priceMissing: boolean
  status: UsageStatus
  /** Set on a posted record when a compensating record reversed it (§8.5). */
  reversedByRecordId?: string
  /** Set on a compensating record, pointing back at the record it negates. */
  reversesRecordId?: string
  /** Unique per `(tenantId, idempotencyKey)`. */
  idempotencyKey: string
  /** Ties an invoice line back to app logs. */
  correlationId?: string
  /** Provider request id. */
  requestId?: string
  /** Platform-absorbed — never consumes wallet/budget. */
  isSystemCost: boolean
  /** e.g. `'workout_generation_retry'`. */
  systemCostCategory?: string
  /** True when this record consumed wallet/budget (reconciliation predicate §10.7). */
  enforced: boolean
  /** Previous chain hash (optional per-tenant hash chain, §8.6). */
  prevHash?: string
  /** This record's chain hash (optional per-tenant hash chain, §8.6). */
  hash?: string
  /** When the LLM call happened. */
  occurredAt: Date
  createdAt: Date
  /** Pending-row settlements only. */
  updatedAt: Date
}

/**
 * Caller-supplied fields for `ILedgerStore.append`. The store computes
 * `id`/`hash`/`prevHash`/`createdAt`/`updatedAt`.
 */
export type NewUsageRecord = Omit<
  UsageRecord,
  'id' | 'prevHash' | 'hash' | 'createdAt' | 'updatedAt'
>

/** Query filter for the ledger store. */
export interface LedgerFilter {
  tenantId: string
  scope?: MeteringScope
  beneficiary?: MeteringScope
  feature?: string
  features?: string[]
  provider?: ProviderId
  model?: string
  operation?: AiOperation
  serviceTier?: ServiceTier
  tags?: string[]
  isSystemCost?: boolean
  systemCostCategory?: string
  status?: UsageStatus[]
  enforcedOnly?: boolean
  from?: Date
  to?: Date
  limit?: number
  offset?: number
}
