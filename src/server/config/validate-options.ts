/**
 * @fileoverview Best-effort structural validation of the module options at init
 * (spec §4.6). Every failure raises `AI_TOKENS_INVALID_CONFIG` with an actionable
 * `details.reason` — except a non-USD currency without an fx resolver, which
 * raises `AI_TOKENS_FX_REQUIRED`. Validation performs has-method checks only; it
 * never calls the store.
 * @layer server
 */

import { resolveMultiplier4dp } from '../../shared'
import type { BymaxAiTokensModuleOptions, IMarkupPolicy } from '../interfaces'
import { AiTokensException } from '../errors'

const LEDGER_METHODS = [
  'append',
  'transition',
  'findByIdempotencyKey',
  'findById',
  'findExpiredHolds',
  'query',
  'sumCost',
  'lastHash',
] as const
const PRICING_METHODS = ['resolveRate', 'upsertPrice', 'getPriceHistory', 'listModels'] as const
const WALLET_METHODS = [
  'getWallet',
  'appendEntry',
  'conditionalDebit',
  'openGrants',
  'listEntries',
  'reconcile',
] as const
const BUDGET_METHODS = [
  'upsert',
  'remove',
  'findMatching',
  'conditionalConsume',
  'adjustWindow',
  'getWindow',
  'setWindowStart',
] as const

/** Build the invalid-config exception with an actionable reason. */
function invalidConfig(reason: string): AiTokensException {
  return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
}

/** The first method name in `methods` that is not a function on `store`, or `undefined`. */
function firstMissingMethod(store: object, methods: readonly string[]): string | undefined {
  const record = store as Record<string, unknown>
  return methods.find((method) => typeof record[method] !== 'function')
}

/** Assert the store exists and implements the always-required ledger + pricing ports. */
function validateStorePorts(options: BymaxAiTokensModuleOptions): void {
  const store: unknown = options.store
  if (store === undefined || store === null) throw invalidConfig('options.store is required')
  const missingLedger = firstMissingMethod(options.store, LEDGER_METHODS)
  if (missingLedger !== undefined) {
    throw invalidConfig(`store is missing the required ledger method "${missingLedger}"`)
  }
  const missingPricing = firstMissingMethod(options.store, PRICING_METHODS)
  if (missingPricing !== undefined) {
    throw invalidConfig(`store is missing the required pricing method "${missingPricing}"`)
  }
}

/** Assert enabled feature blocks have their store port methods present. */
function validateFeaturePorts(options: BymaxAiTokensModuleOptions): void {
  if (options.wallets !== undefined) {
    const missing = firstMissingMethod(options.store, WALLET_METHODS)
    if (missing !== undefined) throw invalidConfig(`wallets enabled but store is missing "${missing}"`)
  }
  if (options.budgets !== undefined) {
    const missing = firstMissingMethod(options.store, BUDGET_METHODS)
    if (missing !== undefined) throw invalidConfig(`budgets enabled but store is missing "${missing}"`)
  }
}

/** Require an fx resolver when the presentation currency is not USD. */
function validateCurrency(options: BymaxAiTokensModuleOptions): void {
  if (options.currency !== undefined && options.currency !== 'USD' && options.fx === undefined) {
    throw new AiTokensException('AI_TOKENS_FX_REQUIRED', undefined, { currency: options.currency })
  }
}

/** Validate the markup multiplier (finite, > 0) or that the policy implements resolve(). */
function validateMarkup(markup: number | IMarkupPolicy | undefined): void {
  if (markup === undefined) return
  if (typeof markup === 'number') {
    try {
      resolveMultiplier4dp(markup)
    } catch {
      throw invalidConfig(`markup must be a finite number greater than 0, received ${String(markup)}`)
    }
    return
  }
  if (typeof markup.resolve !== 'function') {
    throw invalidConfig('markup policy must implement a resolve() method')
  }
}

/** Validate that budget alert thresholds fall within (0, 1]. */
function validateBudgetThresholds(options: BymaxAiTokensModuleOptions): void {
  const thresholds = options.budgets?.alertThresholds
  if (thresholds === undefined) return
  for (const threshold of thresholds) {
    if (!(threshold > 0 && threshold <= 1)) {
      throw invalidConfig(`budget alert thresholds must be within (0, 1], received ${String(threshold)}`)
    }
  }
}

/** Validate hold TTL and reaper interval are positive. */
function validateHolds(options: BymaxAiTokensModuleOptions): void {
  const holds = options.holds
  if (holds === undefined) return
  if (holds.ttlSeconds !== undefined && holds.ttlSeconds <= 0) {
    throw invalidConfig('holds.ttlSeconds must be greater than 0')
  }
  if (holds.reaperIntervalSeconds !== undefined && holds.reaperIntervalSeconds <= 0) {
    throw invalidConfig('holds.reaperIntervalSeconds must be greater than 0')
  }
}

/**
 * Validate the pricing cache TTL. `PricingService.resolveRate()` divides the call
 * timestamp by `cacheTtlMs` to compute the cache bucket, so a `0`, negative,
 * non-integer, or non-finite value yields invalid buckets/expirations; reject it
 * at init.
 */
function validatePricing(options: BymaxAiTokensModuleOptions): void {
  const cacheTtlMs = options.pricing?.cacheTtlMs
  if (cacheTtlMs === undefined) return
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs <= 0) {
    throw invalidConfig(
      `pricing.cacheTtlMs must be a positive integer number of milliseconds, received ${String(cacheTtlMs)}`,
    )
  }
}

/** Validate wallet credit rate (> 0) and overdraft (>= 0). */
function validateWallets(options: BymaxAiTokensModuleOptions): void {
  const wallets = options.wallets
  if (wallets === undefined) return
  if (wallets.creditRateNanoUsd !== undefined && wallets.creditRateNanoUsd <= 0n) {
    throw invalidConfig('wallets.creditRateNanoUsd must be greater than 0')
  }
  if (wallets.overdraftNanoUsd !== undefined && wallets.overdraftNanoUsd < 0n) {
    throw invalidConfig('wallets.overdraftNanoUsd must not be negative')
  }
}

/**
 * Validate the module options at init, throwing a typed exception on the first
 * failure.
 *
 * @param options The host-provided module options.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` or `AI_TOKENS_FX_REQUIRED`.
 */
export function validateOptions(options: BymaxAiTokensModuleOptions): void {
  validateStorePorts(options)
  validateFeaturePorts(options)
  validateCurrency(options)
  validateMarkup(options.markup)
  validateBudgetThresholds(options)
  validateHolds(options)
  validateWallets(options)
  validatePricing(options)
}
