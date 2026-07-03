/**
 * @fileoverview The auth-hold types (spec §11.1). A {@link Hold} is a plain
 * serializable object that survives process boundaries; `capture()`/`release()`
 * revalidate it against the store AND the caller's tenant/scope (§14.4). A
 * {@link HoldEstimate} is the discriminated union of ways to size a hold.
 * @layer server
 */

import type { AiOperation, MeteringScope, ProviderId, ServiceTier } from '../../shared'

/** A reservation over real wallet/budget headroom, settled by `capture()`. */
export interface Hold {
  /** Equals the pending `UsageRecord` id. */
  id: string
  tenantId: string
  scope: MeteringScope
  estimatedTokens: number
  /** Billed (post-markup) estimate. */
  estimatedCostNanoUsd: bigint
  expiresAt: Date
}

/** The three ways to size a hold, as a discriminated union. */
export type HoldEstimate =
  | {
      provider: ProviderId
      model: string
      operation: AiOperation
      serviceTier?: ServiceTier
      inputTokens: number
      maxOutputTokens: number
    }
  | { tokens: number }
  | { amountNanoUsd: bigint }
