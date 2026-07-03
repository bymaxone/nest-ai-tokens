/**
 * @fileoverview The default option values (spec §4.2), as-const. `applyDefaults`
 * merges host options over these to produce a `ResolvedAiTokensOptions`.
 * @layer server
 */

/** Every default value from the spec §4.2 table. */
export const DEFAULT_AI_TOKENS_OPTIONS = {
  ratingMode: 'rate-table',
  currency: 'USD',
  markup: 1.0,
  pricing: { seedFromSnapshot: true, strict: true, cacheTtlMs: 300_000 },
  wallets: { creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
  budgets: { defaultPolicy: 'block', alertThresholds: [0.8, 1.0], failClosed: true },
  holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
  ledger: { hashChain: false },
  events: { emitter: true },
  telemetry: { metrics: true },
  reporting: { maxExportRows: 1_000_000 },
  content: { ttlSeconds: 604_800 },
} as const
