/**
 * @fileoverview The effective-dated price row and its insert type. Rates are
 * integer nano-USD per 1,000,000 tokens (or per unit for non-token line items),
 * so every cost computation is exact integer math.
 * @layer shared
 */

import type { AiOperation } from '../constants/operations.constants'
import type { ServiceTier } from '../constants/service-tiers.constants'
import type { ProviderId } from './catalogs'

/**
 * One immutable, effective-dated price version for a (provider, model, operation,
 * serviceTier) tuple. A call is rated at the row in effect at its timestamp.
 */
export interface PriceVersion {
  id: string
  provider: ProviderId
  model: string
  operation: AiOperation
  /** Part of the resolution key; `'standard'` is the default. */
  serviceTier: ServiceTier
  /** Rates as integer nano-USD per 1,000,000 tokens. */
  inputNanoUsdPerMillion: bigint
  outputNanoUsdPerMillion: bigint
  cacheReadNanoUsdPerMillion: bigint
  cacheWrite5mNanoUsdPerMillion: bigint
  cacheWrite1hNanoUsdPerMillion: bigint
  /** Usually equals output; kept separate for models that price reasoning differently. */
  reasoningNanoUsdPerMillion: bigint
  audioInNanoUsdPerMillion: bigint
  audioOutNanoUsdPerMillion: bigint
  imageInNanoUsdPerMillion: bigint
  imageOutNanoUsdPerMillion: bigint
  /**
   * Long-context tier threshold: when total input (all input-side categories)
   * exceeds this, the tier rates replace the base input/output rates for the
   * WHOLE call (all-or-nothing, matching Gemini's billing).
   */
  tierThresholdTokens?: number
  tierInputNanoUsdPerMillion?: bigint
  tierOutputNanoUsdPerMillion?: bigint
  /**
   * Non-token line items in nano-USD PER UNIT, matched against
   * `NormalizedUsage.serverToolUse` / `MeteringContext.extraUnits` — e.g.
   * `{ web_search_request: 10_000_000n }` ($0.01 per web-search call).
   */
  unitRates?: Record<string, bigint>
  currency: 'USD'
  effectiveFrom: Date
  /** `null` = current; set when a newer row supersedes it. */
  effectiveTo: Date | null
  /** Provenance: `'snapshot' | 'manual' | 'import'`. */
  source: string
}

/**
 * Caller-supplied fields for `upsertPrice`. Rates default to `0n` and
 * `serviceTier` to `'standard'`; the store assigns `id` and closes the previous
 * open row's `effectiveTo`.
 */
export type NewPriceVersion = Partial<Omit<PriceVersion, 'id' | 'effectiveTo'>> &
  Pick<PriceVersion, 'provider' | 'model' | 'operation'>
