import type { NormalizedUsage } from '../types/normalized-usage'
import type { PriceVersion } from '../types/price-version'
import { computeCostNanoUsd } from './compute-cost'

function price(overrides: Partial<PriceVersion>): PriceVersion {
  return {
    id: 'p',
    provider: 'openai',
    model: 'm',
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 0n,
    outputNanoUsdPerMillion: 0n,
    cacheReadNanoUsdPerMillion: 0n,
    cacheWrite5mNanoUsdPerMillion: 0n,
    cacheWrite1hNanoUsdPerMillion: 0n,
    reasoningNanoUsdPerMillion: 0n,
    audioInNanoUsdPerMillion: 0n,
    audioOutNanoUsdPerMillion: 0n,
    imageInNanoUsdPerMillion: 0n,
    imageOutNanoUsdPerMillion: 0n,
    currency: 'USD',
    effectiveFrom: new Date(0),
    effectiveTo: null,
    source: 'test',
    ...overrides,
  }
}

function usage(overrides: Partial<NormalizedUsage>): NormalizedUsage {
  return {
    provider: 'openai',
    model: 'm',
    operation: 'chat',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
    ...overrides,
  }
}

describe('computeCostNanoUsd', () => {
  /** The spec §7.1 worked example: 1,000 Opus input tokens at $5/M is $0.005. */
  it('computes the worked example exactly', () => {
    const result = computeCostNanoUsd(usage({ inputTokens: 1000 }), price({ inputNanoUsdPerMillion: 5_000_000_000n }))
    expect(result).toEqual({ totalNanoUsd: 5_000_000n, tokenNanoUsd: 5_000_000n, surchargeNanoUsd: 0n })
  })

  /** Every token category contributes at its own rate. */
  it('rates every token category', () => {
    const result = computeCostNanoUsd(
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWrite5mTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
        reasoningTokens: 1_000_000,
        audioInTokens: 1_000_000,
        audioOutTokens: 1_000_000,
        imageInTokens: 1_000_000,
        imageOutTokens: 1_000_000,
      }),
      price({
        inputNanoUsdPerMillion: 1n,
        outputNanoUsdPerMillion: 2n,
        cacheReadNanoUsdPerMillion: 3n,
        cacheWrite5mNanoUsdPerMillion: 4n,
        cacheWrite1hNanoUsdPerMillion: 5n,
        reasoningNanoUsdPerMillion: 6n,
        audioInNanoUsdPerMillion: 7n,
        audioOutNanoUsdPerMillion: 8n,
        imageInNanoUsdPerMillion: 9n,
        imageOutNanoUsdPerMillion: 10n,
      }),
    )
    expect(result.tokenNanoUsd).toBe(1n + 2n + 3n + 4n + 5n + 6n + 7n + 8n + 9n + 10n)
  })

  describe('long-context tier (all-or-nothing)', () => {
    const tiered = price({
      inputNanoUsdPerMillion: 1_000_000n,
      outputNanoUsdPerMillion: 1_000_000n,
      tierThresholdTokens: 100,
      tierInputNanoUsdPerMillion: 3_000_000n,
      tierOutputNanoUsdPerMillion: 3_000_000n,
    })

    /** Below the threshold uses base rates. */
    it('uses base rates below the threshold', () => {
      const result = computeCostNanoUsd(usage({ inputTokens: 50 }), tiered)
      expect(result.tokenNanoUsd).toBe((50n * 1_000_000n) / 1_000_000n)
    })

    /** At the threshold uses base rates (strictly greater triggers the tier). */
    it('uses base rates exactly at the threshold', () => {
      const result = computeCostNanoUsd(usage({ inputTokens: 100 }), tiered)
      expect(result.tokenNanoUsd).toBe((100n * 1_000_000n) / 1_000_000n)
    })

    /** Above the threshold switches the whole call to tier rates. */
    it('uses tier rates above the threshold', () => {
      const result = computeCostNanoUsd(usage({ inputTokens: 150, outputTokens: 10 }), tiered)
      expect(result.tokenNanoUsd).toBe((150n * 3_000_000n) / 1_000_000n + (10n * 3_000_000n) / 1_000_000n)
    })

    /** The threshold counts ALL input-side categories, not just plain input. */
    it('counts cache tokens toward the threshold', () => {
      const result = computeCostNanoUsd(usage({ inputTokens: 60, cacheReadTokens: 60 }), tiered)
      // totalInput = 120 > 100 → tier input rate applies to the 60 plain input tokens.
      expect(result.tokenNanoUsd).toBe((60n * 3_000_000n) / 1_000_000n)
    })

    /**
     * Cache-WRITE tokens (5m and 1h) must also count toward the tier threshold.
     * Here the 30 + 30 cache-write tokens are exactly what pushes totalInput past
     * the 100-token threshold. Flipping either `+` in the totalInput sum to `-`
     * would drop the total to 50 (below the threshold) and silently apply the
     * cheaper base input rate — so pinning the tier rate here kills both
     * ArithmeticOperator mutants on the cache-write terms.
     */
    it('counts cache-write tokens toward the threshold', () => {
      const result = computeCostNanoUsd(usage({ inputTokens: 50, cacheWrite5mTokens: 30, cacheWrite1hTokens: 30 }), tiered)
      // totalInput = 50 + 30 + 30 = 110 > 100 → tier input rate applies to the 50 input tokens.
      expect(result.tokenNanoUsd).toBe((50n * 3_000_000n) / 1_000_000n)
    })

    /** Above the threshold with no tier rates falls back to the base rates. */
    it('falls back to base rates when tier rates are absent', () => {
      const noTierRates = price({
        inputNanoUsdPerMillion: 2_000_000n,
        outputNanoUsdPerMillion: 2_000_000n,
        tierThresholdTokens: 100,
      })
      const result = computeCostNanoUsd(usage({ inputTokens: 150, outputTokens: 10 }), noTierRates)
      expect(result.tokenNanoUsd).toBe((150n * 2_000_000n) / 1_000_000n + (10n * 2_000_000n) / 1_000_000n)
    })
  })

  describe('surcharges (unitRates intersection)', () => {
    /** Units present in both serverToolUse and unitRates are billed. */
    it('bills units present in both maps', () => {
      const result = computeCostNanoUsd(
        usage({ serverToolUse: { web_search_requests: 2 } }),
        price({ unitRates: { web_search_requests: 10_000_000n } }),
      )
      expect(result.surchargeNanoUsd).toBe(20_000_000n)
      expect(result.totalNanoUsd).toBe(20_000_000n)
    })

    /** A unit reported but not priced is ignored (not an error). */
    it('ignores a reported unit missing from unitRates', () => {
      const result = computeCostNanoUsd(
        usage({ serverToolUse: { unknown_unit: 5 } }),
        price({ unitRates: { web_search_requests: 10_000_000n } }),
      )
      expect(result.surchargeNanoUsd).toBe(0n)
    })

    /** A priced unit not reported contributes nothing. */
    it('ignores a priced unit that was not reported', () => {
      const result = computeCostNanoUsd(usage({}), price({ unitRates: { web_search_requests: 10_000_000n } }))
      expect(result.surchargeNanoUsd).toBe(0n)
    })

    /** No unitRates at all leaves the surcharge at zero. */
    it('handles a missing unitRates map', () => {
      const result = computeCostNanoUsd(usage({ serverToolUse: { web_search_requests: 2 } }), price({}))
      expect(result.surchargeNanoUsd).toBe(0n)
    })
  })
})
