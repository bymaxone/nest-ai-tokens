/**
 * @fileoverview The cost of a usage at a rate, computed beside the guard of the realm: the guard runs in the same synchronous step as the
 * arithmetic, so no hop of the event loop lies between the last check and the amount.
 * @layer server
 */

import { computeCostNanoUsd } from '../../shared'
import type { CostBreakdown } from '../../shared'
import type { NormalizedUsage, PriceVersion } from '../../shared'
import { assertCleanRealm } from './prototype-guard'

/**
 * The cost of `usage` at `rate`, refused when the realm is not the engine's.
 *
 * @param usage The normalized usage.
 * @param rate The price version.
 * @returns The cost breakdown.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` while the realm differs from the engine's.
 */
export function ratedCost(usage: NormalizedUsage, rate: PriceVersion): CostBreakdown {
  assertCleanRealm()
  return computeCostNanoUsd(usage, rate)
}
