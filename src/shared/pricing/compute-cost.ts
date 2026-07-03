/**
 * @fileoverview The pure cost engine (spec §7.1). Computes the provider cost of a
 * {@link NormalizedUsage} against a {@link PriceVersion} in exact bigint nano-USD.
 * The long-context tier is all-or-nothing: when total input crosses the
 * threshold, the tier rates replace the base input/output rates for the WHOLE
 * call. Non-token line items are rated via `unitRates`. The token and surcharge
 * parts are returned separately so reports can distinguish them.
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import type { PriceVersion } from '../types/price-version'
import { perMillion } from './money'

/** The separable parts of a computed provider cost, all in nano-USD. */
export interface CostBreakdown {
  /** Token cost plus surcharges. */
  totalNanoUsd: bigint
  /** The token-only share. */
  tokenNanoUsd: bigint
  /** The non-token (server tool use) share. */
  surchargeNanoUsd: bigint
}

/**
 * Compute the provider cost of a normalized usage against a price version.
 *
 * @param usage The normalized usage.
 * @param rate The effective-dated price version.
 * @returns The exact cost broken into token and surcharge parts.
 * @example
 * // 1,000 Opus input tokens at $5/M → 5_000_000n nano-USD ($0.005).
 * computeCostNanoUsd(usage, rate).totalNanoUsd
 */
export function computeCostNanoUsd(usage: NormalizedUsage, rate: PriceVersion): CostBreakdown {
  const totalInput =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens
  const overTier = rate.tierThresholdTokens != null && totalInput > rate.tierThresholdTokens
  const inputRate = overTier
    ? (rate.tierInputNanoUsdPerMillion ?? rate.inputNanoUsdPerMillion)
    : rate.inputNanoUsdPerMillion
  const outputRate = overTier
    ? (rate.tierOutputNanoUsdPerMillion ?? rate.outputNanoUsdPerMillion)
    : rate.outputNanoUsdPerMillion

  const tokenNanoUsd =
    perMillion(usage.inputTokens, inputRate) +
    perMillion(usage.outputTokens, outputRate) +
    perMillion(usage.cacheReadTokens, rate.cacheReadNanoUsdPerMillion) +
    perMillion(usage.cacheWrite5mTokens, rate.cacheWrite5mNanoUsdPerMillion) +
    perMillion(usage.cacheWrite1hTokens, rate.cacheWrite1hNanoUsdPerMillion) +
    perMillion(usage.reasoningTokens, rate.reasoningNanoUsdPerMillion) +
    perMillion(usage.audioInTokens, rate.audioInNanoUsdPerMillion) +
    perMillion(usage.audioOutTokens, rate.audioOutNanoUsdPerMillion) +
    perMillion(usage.imageInTokens, rate.imageInNanoUsdPerMillion) +
    perMillion(usage.imageOutTokens, rate.imageOutNanoUsdPerMillion)

  let surchargeNanoUsd = 0n
  for (const [unit, count] of Object.entries({ ...usage.serverToolUse })) {
    const unitRate = rate.unitRates?.[unit]
    if (unitRate != null) surchargeNanoUsd += BigInt(count) * unitRate
  }

  return { totalNanoUsd: tokenNanoUsd + surchargeNanoUsd, tokenNanoUsd, surchargeNanoUsd }
}
