/**
 * @fileoverview The auth-hold types (spec §11.1). A {@link Hold} is a plain,
 * method-free object that survives process boundaries (store it in Redis, hand it
 * to a worker); `capture()`/`release()` revalidate it against the store AND the
 * caller's tenant/scope (§14.4) and read the authoritative amounts from the pending
 * record, so the Hold's own fields are informational. Its `bigint` money field
 * crosses a JSON boundary via `toJsonSafe()` as a decimal string, exactly like every
 * other library value (§15.5) — never `JSON.stringify` a bigint directly. A
 * {@link HoldEstimate} is the discriminated union of ways to size a hold.
 * @layer server
 */

import type { AiOperation, MeteringScope, ProviderId, ServiceTier } from '../../shared'

/**
 * A reservation over real wallet/budget headroom, settled by `capture()`. Plain and
 * method-free; serialize with `toJsonSafe()` (its `bigint` field becomes a decimal
 * string, §15.5) to cross a process/JSON boundary.
 */
export interface Hold {
  /** Equals the pending `UsageRecord` id. */
  id: string
  tenantId: string
  scope: MeteringScope
  estimatedTokens: number
  /** Billed (post-markup) estimate. Serialize via `toJsonSafe()` at a JSON boundary (§15.5). */
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
