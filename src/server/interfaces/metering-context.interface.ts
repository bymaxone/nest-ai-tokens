/**
 * @fileoverview The per-call metering context and the metered-result wrapper
 * (spec §11.1). The context carries the payer scope, feature, normalization
 * instructions, and idempotency key. It is TRUSTED INPUT — the host builds it
 * from its VERIFIED auth layer, never from client-supplied body/query fields.
 * @layer server
 */

import type { MeteringScope, ProviderPreset, RatingMode, ServiceTier, UsageRecord } from '../../shared'

/** Everything the metering path needs about one call. */
export interface MeteringContext {
  tenantId: string
  /** The PAYER — enforcement target. */
  scope: MeteringScope
  /** Optional distinct beneficiary (reporting dimension). */
  beneficiary?: MeteringScope
  /** Optional actor id (audit). */
  requestedBy?: string
  feature: string
  tags?: string[]
  /** Normalization/rating instructions for `meter()`/interceptor. */
  preset?: ProviderPreset
  ratingMode?: RatingMode
  /** Price-lookup override for deployment-named models (Azure/Bedrock) — §6.6. */
  baseModel?: string
  /** Declared tier when it cannot come from the response (e.g. Batch API result files). */
  serviceTier?: ServiceTier
  /** Non-token line items the provider does not report in usage. */
  extraUnits?: Record<string, number>
  /** Strongly recommended; derive with `deriveIdempotencyKey(payload)` (§8.4). */
  idempotencyKey?: string
  correlationId?: string
  /** `record()` only: also debit wallet + consume budgets post-hoc. Default `false`. */
  enforce?: boolean
  isSystemCost?: boolean
  systemCostCategory?: string
}

/** The wrapper `meter()` returns: the function result plus its settled usage record. */
export interface MeterResult<T> {
  result: T
  usage: UsageRecord
}

/** The pure pre-flight cost estimate `estimateCost()` returns. */
export interface CostEstimate {
  rawCostNanoUsd: bigint
  billedCostNanoUsd: bigint
}
