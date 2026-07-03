/**
 * @fileoverview Pinned per-model price snapshot in bigint nano-USD per 1,000,000
 * tokens (unit rates are per unit). Converted offline from published provider
 * pricing (methodology mirrors LiteLLM's `model_prices_and_context_window.json`,
 * see `scripts/convert-litellm-prices.mjs`). Snapshot date: 2026-07. Pinning
 * keeps rates point-in-time stable; hosts add or override models via
 * `PricingService.upsertPrice()`. Data only — the exported array carries no
 * behavior. Each row's `source` is `'snapshot'`; rates flagged `VERIFY` should be
 * spot-checked against the provider's pricing page during review.
 * @layer prices
 */

import type { AiOperation } from '../shared/constants/operations.constants'
import type { ServiceTier } from '../shared/constants/service-tiers.constants'
import type { ProviderId } from '../shared/types/catalogs'
import type { PriceVersion } from '../shared/types/price-version'

/** A seed price row: a {@link PriceVersion} without the store-assigned identity/effective-date fields. */
export type SeedPriceRow = Omit<PriceVersion, 'id' | 'effectiveFrom' | 'effectiveTo'>

/** The ten per-million token rate fields of a {@link PriceVersion}. */
type RateFields = Pick<
  PriceVersion,
  | 'inputNanoUsdPerMillion'
  | 'outputNanoUsdPerMillion'
  | 'cacheReadNanoUsdPerMillion'
  | 'cacheWrite5mNanoUsdPerMillion'
  | 'cacheWrite1hNanoUsdPerMillion'
  | 'reasoningNanoUsdPerMillion'
  | 'audioInNanoUsdPerMillion'
  | 'audioOutNanoUsdPerMillion'
  | 'imageInNanoUsdPerMillion'
  | 'imageOutNanoUsdPerMillion'
>

/** Every rate field zeroed; a row spreads its non-zero rates over this base. */
const ZERO_RATES: RateFields = {
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
}

/** The shorthand a seed entry is written as before {@link makeRow} normalizes it. */
interface SeedInput {
  provider: ProviderId
  model: string
  operation?: AiOperation
  serviceTier?: ServiceTier
  rates: Partial<RateFields>
  tierThresholdTokens?: number
  tierInputNanoUsdPerMillion?: bigint
  tierOutputNanoUsdPerMillion?: bigint
  unitRates?: Record<string, bigint>
}

/** Normalize a {@link SeedInput} into a full {@link SeedPriceRow} (fills zero rates and defaults). */
function makeRow(input: SeedInput): SeedPriceRow {
  return {
    provider: input.provider,
    model: input.model,
    operation: input.operation ?? 'chat',
    serviceTier: input.serviceTier ?? 'standard',
    ...ZERO_RATES,
    ...input.rates,
    ...(input.tierThresholdTokens !== undefined ? { tierThresholdTokens: input.tierThresholdTokens } : {}),
    ...(input.tierInputNanoUsdPerMillion !== undefined
      ? { tierInputNanoUsdPerMillion: input.tierInputNanoUsdPerMillion }
      : {}),
    ...(input.tierOutputNanoUsdPerMillion !== undefined
      ? { tierOutputNanoUsdPerMillion: input.tierOutputNanoUsdPerMillion }
      : {}),
    ...(input.unitRates !== undefined ? { unitRates: input.unitRates } : {}),
    currency: 'USD',
    source: 'snapshot',
  }
}

/**
 * The pinned price snapshot. Rated at published standard-tier prices unless the
 * row's `serviceTier` says otherwise; batch rows are ~50% of standard.
 */
export const MODEL_PRICES_SEED: readonly SeedPriceRow[] = [
  // ── OpenAI ───────────────────────────────────────────────────────────────
  // source: OpenAI pricing snapshot 2026-07 — gpt-5 $1.25/$10 per M, cached input $0.125/M.
  makeRow({
    provider: 'openai',
    model: 'gpt-5',
    rates: {
      inputNanoUsdPerMillion: 1_250_000_000n,
      outputNanoUsdPerMillion: 10_000_000_000n,
      cacheReadNanoUsdPerMillion: 125_000_000n,
      reasoningNanoUsdPerMillion: 10_000_000_000n,
    },
    unitRates: { web_search_call: 10_000_000n }, // VERIFY: $0.01 per built-in web-search call.
  }),
  // source: OpenAI pricing snapshot 2026-07 — Batch API ~50% of standard.
  makeRow({
    provider: 'openai',
    model: 'gpt-5',
    serviceTier: 'batch',
    rates: {
      inputNanoUsdPerMillion: 625_000_000n,
      outputNanoUsdPerMillion: 5_000_000_000n,
      cacheReadNanoUsdPerMillion: 62_500_000n,
      reasoningNanoUsdPerMillion: 5_000_000_000n,
    },
  }),
  // source: OpenAI pricing snapshot 2026-07 — gpt-5-mini $0.25/$2 per M.
  makeRow({
    provider: 'openai',
    model: 'gpt-5-mini',
    rates: {
      inputNanoUsdPerMillion: 250_000_000n,
      outputNanoUsdPerMillion: 2_000_000_000n,
      cacheReadNanoUsdPerMillion: 25_000_000n,
      reasoningNanoUsdPerMillion: 2_000_000_000n,
    },
  }),
  // source: OpenAI pricing snapshot 2026-07 — text-embedding-3-small $0.02/M.
  makeRow({
    provider: 'openai',
    model: 'text-embedding-3-small',
    operation: 'embeddings',
    rates: { inputNanoUsdPerMillion: 20_000_000n },
  }),
  // source: OpenAI pricing snapshot 2026-07 — text-embedding-3-large $0.13/M.
  makeRow({
    provider: 'openai',
    model: 'text-embedding-3-large',
    operation: 'embeddings',
    rates: { inputNanoUsdPerMillion: 130_000_000n },
  }),

  // ── Anthropic ────────────────────────────────────────────────────────────
  // source: Anthropic pricing snapshot 2026-07 — Opus $15/$75 per M; cache read 0.1×, write5m 1.25×, write1h 2× input.
  makeRow({
    provider: 'anthropic',
    model: 'claude-opus-4',
    rates: {
      inputNanoUsdPerMillion: 15_000_000_000n,
      outputNanoUsdPerMillion: 75_000_000_000n,
      cacheReadNanoUsdPerMillion: 1_500_000_000n,
      cacheWrite5mNanoUsdPerMillion: 18_750_000_000n,
      cacheWrite1hNanoUsdPerMillion: 30_000_000_000n,
      reasoningNanoUsdPerMillion: 75_000_000_000n,
    },
    unitRates: { web_search_requests: 10_000_000n }, // source: Anthropic web search $10 / 1,000 requests.
  }),
  // source: Anthropic pricing snapshot 2026-07 — Sonnet $3/$15 per M.
  makeRow({
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    rates: {
      inputNanoUsdPerMillion: 3_000_000_000n,
      outputNanoUsdPerMillion: 15_000_000_000n,
      cacheReadNanoUsdPerMillion: 300_000_000n,
      cacheWrite5mNanoUsdPerMillion: 3_750_000_000n,
      cacheWrite1hNanoUsdPerMillion: 6_000_000_000n,
      reasoningNanoUsdPerMillion: 15_000_000_000n,
    },
  }),
  // source: Anthropic pricing snapshot 2026-07 — Haiku $0.80/$4 per M.
  makeRow({
    provider: 'anthropic',
    model: 'claude-haiku-4',
    rates: {
      inputNanoUsdPerMillion: 800_000_000n,
      outputNanoUsdPerMillion: 4_000_000_000n,
      cacheReadNanoUsdPerMillion: 80_000_000n,
      cacheWrite5mNanoUsdPerMillion: 1_000_000_000n,
      cacheWrite1hNanoUsdPerMillion: 1_600_000_000n,
      reasoningNanoUsdPerMillion: 4_000_000_000n,
    },
  }),
  // source: Anthropic pricing snapshot 2026-07 — Sonnet Batch API ~50% of standard.
  makeRow({
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    serviceTier: 'batch',
    rates: {
      inputNanoUsdPerMillion: 1_500_000_000n,
      outputNanoUsdPerMillion: 7_500_000_000n,
      cacheReadNanoUsdPerMillion: 150_000_000n,
      cacheWrite5mNanoUsdPerMillion: 1_875_000_000n,
      cacheWrite1hNanoUsdPerMillion: 3_000_000_000n,
      reasoningNanoUsdPerMillion: 7_500_000_000n,
    },
  }),

  // ── Google Gemini ────────────────────────────────────────────────────────
  // source: Gemini pricing snapshot 2026-07 — 2.5 Pro $1.25/$10 (≤200k), $2.50/$15 above; cache read ~10% input.
  makeRow({
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    rates: {
      inputNanoUsdPerMillion: 1_250_000_000n,
      outputNanoUsdPerMillion: 10_000_000_000n,
      cacheReadNanoUsdPerMillion: 125_000_000n,
      reasoningNanoUsdPerMillion: 10_000_000_000n,
    },
    tierThresholdTokens: 200_000,
    tierInputNanoUsdPerMillion: 2_500_000_000n,
    tierOutputNanoUsdPerMillion: 15_000_000_000n,
  }),
  // source: Gemini pricing snapshot 2026-07 — 2.5 Flash $0.30/$2.50; long-context tier VERIFY.
  makeRow({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    rates: {
      inputNanoUsdPerMillion: 300_000_000n,
      outputNanoUsdPerMillion: 2_500_000_000n,
      cacheReadNanoUsdPerMillion: 30_000_000n,
      reasoningNanoUsdPerMillion: 2_500_000_000n,
    },
    tierThresholdTokens: 200_000, // VERIFY: Flash long-context surcharge.
    tierInputNanoUsdPerMillion: 600_000_000n,
    tierOutputNanoUsdPerMillion: 5_000_000_000n,
  }),

  // ── Mistral ──────────────────────────────────────────────────────────────
  // source: Mistral pricing snapshot 2026-07 — Large $2/$6 per M.
  makeRow({
    provider: 'mistral',
    model: 'mistral-large-latest',
    rates: { inputNanoUsdPerMillion: 2_000_000_000n, outputNanoUsdPerMillion: 6_000_000_000n },
  }),
  // source: Mistral pricing snapshot 2026-07 — Medium $0.40/$2 per M.
  makeRow({
    provider: 'mistral',
    model: 'mistral-medium-latest',
    rates: { inputNanoUsdPerMillion: 400_000_000n, outputNanoUsdPerMillion: 2_000_000_000n },
  }),
  // source: Mistral pricing snapshot 2026-07 — Small $0.10/$0.30 per M.
  makeRow({
    provider: 'mistral',
    model: 'mistral-small-latest',
    rates: { inputNanoUsdPerMillion: 100_000_000n, outputNanoUsdPerMillion: 300_000_000n },
  }),

  // ── DeepSeek / xAI / Groq (headline models) ──────────────────────────────
  // source: DeepSeek pricing snapshot 2026-07 — chat $0.27/$1.10 per M; cache hit $0.07/M.
  makeRow({
    provider: 'deepseek',
    model: 'deepseek-chat',
    rates: {
      inputNanoUsdPerMillion: 270_000_000n,
      outputNanoUsdPerMillion: 1_100_000_000n,
      cacheReadNanoUsdPerMillion: 70_000_000n,
    },
  }),
  // source: xAI pricing snapshot 2026-07 — Grok $3/$15 per M.
  makeRow({
    provider: 'xai',
    model: 'grok-4',
    rates: {
      inputNanoUsdPerMillion: 3_000_000_000n,
      outputNanoUsdPerMillion: 15_000_000_000n,
      reasoningNanoUsdPerMillion: 15_000_000_000n,
    },
  }),
  // source: Groq pricing snapshot 2026-07 — Llama 3.3 70B $0.59/$0.79 per M. VERIFY.
  makeRow({
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    rates: { inputNanoUsdPerMillion: 590_000_000n, outputNanoUsdPerMillion: 790_000_000n },
  }),
]
