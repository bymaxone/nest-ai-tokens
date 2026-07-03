import { SERVICE_TIERS } from '../shared/constants/service-tiers.constants'
import { AI_OPERATIONS } from '../shared/constants/operations.constants'
import { computeCostNanoUsd } from '../shared/pricing/compute-cost'
import type { NormalizedUsage } from '../shared/types/normalized-usage'
import type { PriceVersion } from '../shared/types/price-version'
import type { SeedPriceRow } from './model-prices.seed'
import { MODEL_PRICES_SEED } from './model-prices.seed'

const RATE_FIELDS = [
  'inputNanoUsdPerMillion',
  'outputNanoUsdPerMillion',
  'cacheReadNanoUsdPerMillion',
  'cacheWrite5mNanoUsdPerMillion',
  'cacheWrite1hNanoUsdPerMillion',
  'reasoningNanoUsdPerMillion',
  'audioInNanoUsdPerMillion',
  'audioOutNanoUsdPerMillion',
  'imageInNanoUsdPerMillion',
  'imageOutNanoUsdPerMillion',
] as const

describe('MODEL_PRICES_SEED', () => {
  /** Every row conforms to the PriceVersion row shape with integer (bigint) rates. */
  it('validates every row against the PriceVersion shape', () => {
    for (const row of MODEL_PRICES_SEED) {
      expect(typeof row.provider).toBe('string')
      expect(row.provider.length).toBeGreaterThan(0)
      expect(row.model.length).toBeGreaterThan(0)
      expect(AI_OPERATIONS).toContain(row.operation)
      expect(SERVICE_TIERS).toContain(row.serviceTier)
      expect(row.currency).toBe('USD')
      expect(row.source).toBe('snapshot')
      for (const field of RATE_FIELDS) {
        expect(typeof row[field]).toBe('bigint')
        expect(row[field] >= 0n).toBe(true)
      }
    }
  })

  /** No two rows share the same (provider, model, operation, serviceTier) key. */
  it('has no duplicate resolution keys', () => {
    const keys = MODEL_PRICES_SEED.map(
      (row) => `${row.provider}|${row.model}|${row.operation}|${row.serviceTier}`,
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  /** Tier and unit-rate fields, when present, are also non-negative bigints. */
  it('keeps optional tier and unit rates non-negative', () => {
    for (const row of MODEL_PRICES_SEED) {
      if (row.tierInputNanoUsdPerMillion !== undefined) {
        expect(row.tierInputNanoUsdPerMillion >= 0n).toBe(true)
      }
      if (row.tierOutputNanoUsdPerMillion !== undefined) {
        expect(row.tierOutputNanoUsdPerMillion >= 0n).toBe(true)
      }
      if (row.unitRates !== undefined) {
        for (const value of Object.values(row.unitRates)) expect(value >= 0n).toBe(true)
      }
    }
  })

  /** The snapshot covers the mandated model families across every seeded provider. */
  it('covers the required model families', () => {
    const has = (provider: string, modelPrefix: string): boolean =>
      MODEL_PRICES_SEED.some((row) => row.provider === provider && row.model.startsWith(modelPrefix))
    expect(has('openai', 'gpt-5')).toBe(true)
    expect(has('openai', 'text-embedding-3-small')).toBe(true)
    expect(has('openai', 'text-embedding-3-large')).toBe(true)
    expect(has('anthropic', 'claude-opus')).toBe(true)
    expect(has('anthropic', 'claude-sonnet')).toBe(true)
    expect(has('anthropic', 'claude-haiku')).toBe(true)
    expect(has('gemini', 'gemini-2.5-pro')).toBe(true)
    expect(has('gemini', 'gemini-2.5-flash')).toBe(true)
    expect(has('mistral', 'mistral-large')).toBe(true)
    expect(has('mistral', 'mistral-medium')).toBe(true)
    expect(has('mistral', 'mistral-small')).toBe(true)
    expect(has('deepseek', 'deepseek')).toBe(true)
    expect(has('xai', 'grok')).toBe(true)
    expect(has('groq', 'llama')).toBe(true)
  })

  /** Anthropic cache rates follow the 0.1× / 1.25× / 2× of input multiples. */
  it('prices Anthropic cache tiers as multiples of input', () => {
    const opus = MODEL_PRICES_SEED.find(
      (row) => row.provider === 'anthropic' && row.model === 'claude-opus-4' && row.serviceTier === 'standard',
    )
    expect(opus).toBeDefined()
    if (opus === undefined) return
    expect(opus.cacheReadNanoUsdPerMillion).toBe(opus.inputNanoUsdPerMillion / 10n)
    expect(opus.cacheWrite5mNanoUsdPerMillion).toBe((opus.inputNanoUsdPerMillion * 125n) / 100n)
    expect(opus.cacheWrite1hNanoUsdPerMillion).toBe(opus.inputNanoUsdPerMillion * 2n)
  })

  /** Gemini rows carry the long-context tier threshold and rates. */
  it('includes Gemini long-context tier rows', () => {
    const geminiTiered = MODEL_PRICES_SEED.filter(
      (row) => row.provider === 'gemini' && row.tierThresholdTokens !== undefined,
    )
    expect(geminiTiered.length).toBeGreaterThanOrEqual(2)
    for (const row of geminiTiered) expect(row.tierThresholdTokens).toBe(200_000)
  })

  /** Complete a seed row into a priceable {@link PriceVersion}. */
  const toPriceVersion = (row: SeedPriceRow): PriceVersion => ({
    ...row,
    id: 'seed',
    effectiveFrom: new Date(0),
    effectiveTo: null,
  })

  /** A zeroed usage carrying only the given server-tool counts. */
  const usageWithTools = (serverToolUse: Record<string, number>): NormalizedUsage => ({
    provider: 'anthropic',
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
    serverToolUse,
  })

  /**
   * Every seeded web-search surcharge is keyed on `web_search_requests` — the
   * exact count key the normalizers emit — so it actually bills through the cost
   * engine end-to-end (the OpenAI `web_search_call` mismatch was unreachable).
   */
  it('bills every seeded web-search surcharge through computeCostNanoUsd', () => {
    const seeded = MODEL_PRICES_SEED.filter((row) => row.unitRates?.web_search_requests !== undefined)
    expect(seeded.some((row) => row.provider === 'openai')).toBe(true)
    expect(seeded.some((row) => row.provider === 'anthropic')).toBe(true)
    for (const row of seeded) {
      const rate = row.unitRates?.web_search_requests
      expect(rate).toBeDefined()
      if (rate === undefined) continue
      const result = computeCostNanoUsd(usageWithTools({ web_search_requests: 3 }), toPriceVersion(row))
      expect(result.surchargeNanoUsd).toBe(3n * rate)
      expect(result.totalNanoUsd).toBe(3n * rate)
    }
  })
})
