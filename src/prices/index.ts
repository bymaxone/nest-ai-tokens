/**
 * @fileoverview Public barrel for the data-only `./prices` subpath — the pinned
 * `MODEL_PRICES_SEED` snapshot of per-model prices in bigint nano-USD per million
 * tokens (snapshot 2026-07; methodology in `scripts/convert-litellm-prices.mjs`).
 * Zero runtime dependencies; imported lazily by the server on first boot. This
 * subpath does not import `./shared` at runtime (types only, erased at build).
 * @layer prices
 */

export { MODEL_PRICES_SEED } from './model-prices.seed'
export type { SeedPriceRow } from './model-prices.seed'
