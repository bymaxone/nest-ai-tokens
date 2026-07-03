#!/usr/bin/env node
// @ts-check
//
// Offline converter: LiteLLM `model_prices_and_context_window.json` → seed rows
// in bigint nano-USD per 1,000,000 tokens. Committed for provenance and manual
// refresh only — it is NOT imported by src/ and NOT run in CI. Point-in-time
// pricing is intentional; live fetching is a v0.2 CLI concern.
//
// Usage:
//   node scripts/convert-litellm-prices.mjs path/to/model_prices_and_context_window.json
//
import { readFileSync } from 'node:fs'

// A per-token USD cost becomes nano-USD per million tokens by multiplying by
// 1e9 (nano per USD) × 1e6 (tokens per million) = 1e15.
const USD_PER_TOKEN_TO_NANO_PER_MILLION = 1e15

/**
 * Convert a per-token USD cost to an integer nano-USD-per-million string suffixed
 * with `n` (a bigint literal), rounding half away from zero.
 * @param {number | undefined} costPerToken
 * @returns {string}
 */
function toNanoPerMillion(costPerToken) {
  if (typeof costPerToken !== 'number' || !Number.isFinite(costPerToken)) return '0n'
  return `${BigInt(Math.round(costPerToken * USD_PER_TOKEN_TO_NANO_PER_MILLION)).toString()}n`
}

/**
 * Map a LiteLLM entry to the seed rate fields for a given tier suffix
 * (`''` = standard, `_batches`, `_flex`, `_priority`).
 * @param {Record<string, number>} entry
 * @param {string} tierSuffix
 */
function rateFields(entry, tierSuffix) {
  return {
    inputNanoUsdPerMillion: toNanoPerMillion(entry[`input_cost_per_token${tierSuffix}`]),
    outputNanoUsdPerMillion: toNanoPerMillion(entry[`output_cost_per_token${tierSuffix}`]),
    cacheReadNanoUsdPerMillion: toNanoPerMillion(entry['cache_read_input_token_cost']),
    cacheWrite5mNanoUsdPerMillion: toNanoPerMillion(entry['cache_creation_input_token_cost']),
    reasoningNanoUsdPerMillion: toNanoPerMillion(entry[`output_cost_per_token${tierSuffix}`]),
  }
}

const [, , sourcePath] = process.argv
if (!sourcePath) {
  console.error('Usage: node scripts/convert-litellm-prices.mjs <model_prices.json>')
  process.exit(1)
}

/** @type {Record<string, Record<string, number>>} */
const catalog = JSON.parse(readFileSync(sourcePath, 'utf8'))
const tiers = [
  { suffix: '', serviceTier: 'standard' },
  { suffix: '_batches', serviceTier: 'batch' },
  { suffix: '_flex', serviceTier: 'flex' },
  { suffix: '_priority', serviceTier: 'priority' },
]

const rows = []
for (const [model, entry] of Object.entries(catalog)) {
  if (model === 'sample_spec') continue
  for (const { suffix, serviceTier } of tiers) {
    if (suffix !== '' && entry[`input_cost_per_token${suffix}`] === undefined) continue
    rows.push({
      provider: entry['litellm_provider'] ?? 'unknown',
      model,
      operation: entry['mode'] === 'embedding' ? 'embeddings' : 'chat',
      serviceTier,
      ...rateFields(entry, suffix),
      searchUnitRate: toNanoPerMillion(entry['search_context_cost_per_query']),
    })
  }
}

// Emit the rows as a starting point for a hand-curated snapshot revision.
console.log(JSON.stringify(rows, null, 2))
