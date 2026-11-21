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
import { isBudgetPolicy, isRatingMode } from '../utils/enum-guards'
import { withoutNullish } from './without-nullish'
import { isFraction, isNonNegativeBigint, isPositiveBigint } from '../utils/numeric-guards'
import { DEFAULT_AI_TOKENS_OPTIONS as D } from './default-options.constants'

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
  'findBudgetById',
  'findMatching',
  'conditionalConsume',
  'adjustWindow',
  'consumeWindowOnce',
  'adjustWindowOnce',
  'commitReference',
  'dropReference',
  'getWindow',
  'setWindowStart',
] as const

/** Build the invalid-config exception with an actionable reason. */
function invalidConfig(reason: string): AiTokensException {
  // Stryker disable next-line ObjectLiteral: error context { reason } is internal diagnostics; tests check error code only
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
  // Stryker disable next-line StringLiteral: error reason text is internal diagnostics; tests check error code only
  if (store === undefined) throw invalidConfig('options.store is required')
  const missingLedger = firstMissingMethod(options.store, LEDGER_METHODS)
  if (missingLedger !== undefined) {
    // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
    throw invalidConfig(`store is missing the required ledger method "${missingLedger}"`)
  }
  const missingPricing = firstMissingMethod(options.store, PRICING_METHODS)
  if (missingPricing !== undefined) {
    // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
    throw invalidConfig(`store is missing the required pricing method "${missingPricing}"`)
  }
}

/** Assert enabled feature blocks have their store port methods present. */
function validateFeaturePorts(options: BymaxAiTokensModuleOptions): void {
  if (options.wallets !== undefined) {
    const missing = firstMissingMethod(options.store, WALLET_METHODS)
    // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
    if (missing !== undefined) throw invalidConfig(`wallets enabled but store is missing "${missing}"`)
  }
  if (options.budgets !== undefined) {
    const missing = firstMissingMethod(options.store, BUDGET_METHODS)
    // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
    if (missing !== undefined) throw invalidConfig(`budgets enabled but store is missing "${missing}"`)
  }
}

/** Require an fx resolver when the presentation currency is not USD. */
function validateCurrency(options: BymaxAiTokensModuleOptions): void {
  if (options.currency !== undefined && options.currency !== 'USD' && options.fx === undefined) {
    throw new AiTokensException('AI_TOKENS_FX_REQUIRED')
  }
}

/** Validate the markup multiplier (finite, > 0) or that the policy implements resolve(). */
function validateMarkup(markup: number | IMarkupPolicy | undefined): void {
  if (markup === undefined) return
  if (typeof markup === 'number') {
    try {
      resolveMultiplier4dp(markup)
    } catch {
      // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
      throw invalidConfig('markup must be a finite number greater than 0')
    }
    return
  }
  if (typeof markup.resolve !== 'function') {
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    throw invalidConfig('markup policy must implement a resolve() method')
  }
}

/** The groups whose omission leaves a limit or a protection off, so that a group which failed to load must not read as omitted. */
const NULL_REFUSED_GROUPS = ['budgets', 'wallets', 'ledger'] as const

/**
 * Refuse a null where an omitted option leaves a limit or a protection off: no budget enforcement, no wallet balance, and the
 * integrity chain of the ledger, which is off by default. A group or a chain flag that failed to load as null must not be read
 * as "off". It is read from the options as given, before nulls are dropped.
 */
function validateProtections(given: BymaxAiTokensModuleOptions): void {
  for (const group of NULL_REFUSED_GROUPS) {
    const value: unknown = Reflect.get(given, group)
    if (value === null) {
      // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
      throw invalidConfig(`${group} must be an object, or left out`)
    }
  }
  const ledger: unknown = Reflect.get(given, 'ledger')
  if (typeof ledger !== 'object' || ledger === null) return
  const hashChain: unknown = Reflect.get(ledger, 'hashChain')
  // The flag is read as truthy, so a string such as 'false' would switch the chain on, and null is not a way to leave it off.
  if (hashChain !== undefined && typeof hashChain !== 'boolean') {
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    throw invalidConfig('ledger.hashChain must be true or false')
  }
}

/** The options that are functions the library calls. */
const FUNCTION_OPTIONS = ['scopeResolver', 'fx'] as const

/** The options that are groups of options the library reads fields of. */
const GROUP_OPTIONS = ['pricing', 'wallets', 'budgets', 'holds', 'settlement', 'ledger', 'events', 'telemetry', 'reporting', 'content'] as const

/** The options inside a group that are switches, each read as truthy, so that a string such as `'false'` would switch it on. */
const SWITCH_OPTIONS = [
  ['pricing', 'seedFromSnapshot'],
  ['pricing', 'strict'],
  ['budgets', 'failClosed'],
  ['settlement', 'enabled'],
  ['events', 'emitter'],
  ['telemetry', 'metrics'],
] as const

/** Refuse a function option that is not a function, a group option that is not an object and a switch that is not a boolean: each would be read as left out, or as on. */
function validateShapes(options: BymaxAiTokensModuleOptions): void {
  for (const name of FUNCTION_OPTIONS) {
    const value: unknown = Reflect.get(options, name)
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    if (value !== undefined && typeof value !== 'function') throw invalidConfig(`${name} must be a function`)
  }
  for (const name of GROUP_OPTIONS) {
    const value: unknown = Reflect.get(options, name)
    // A null group was dropped from the options before this point, so what is not an object here is a value of another kind.
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    if (value !== undefined && (typeof value !== 'object' || Array.isArray(value))) throw invalidConfig(`${name} must be an object`)
  }
  for (const [group, name] of SWITCH_OPTIONS) {
    const value: unknown = Reflect.get(Reflect.get(options, group) ?? {}, name)
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    if (value !== undefined && typeof value !== 'boolean') throw invalidConfig(`${group}.${name} must be true or false`)
  }
}

/** Refuse a budget policy or a rating mode that is not a documented value: a typo must not mean no limit, or another price. */
function validateEnums(options: BymaxAiTokensModuleOptions): void {
  if (options.budgets?.defaultPolicy !== undefined && !isBudgetPolicy(options.budgets.defaultPolicy)) {
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    throw invalidConfig('budgets.defaultPolicy must be one of block, throttle or allow')
  }
  if (options.ratingMode !== undefined && !isRatingMode(options.ratingMode)) {
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    throw invalidConfig('ratingMode must be one of rate-table or provider-reported')
  }
}

/** Validate that budget alert thresholds fall within (0, 1]. */
function validateBudgetThresholds(options: BymaxAiTokensModuleOptions): void {
  const thresholds = options.budgets?.alertThresholds
  if (thresholds === undefined) return
  // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
  if (!Array.isArray(thresholds)) throw invalidConfig('budget alert thresholds must be a list of numbers within (0, 1]')
  for (const threshold of thresholds as unknown[]) {
    if (!isFraction(threshold)) {
      // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
      throw invalidConfig('budget alert thresholds must be numbers within (0, 1]')
    }
  }
}

/** The longest delay `setInterval` runs: 2^31-1 milliseconds, a longer one fires every millisecond. */
const MAX_TIMER_SECONDS = 2_147_483

/** The longest TTL accepted, 2^31-1 seconds (about 68 years): its milliseconds added to a date stay a valid `Date`. */
const MAX_TTL_SECONDS = 2_147_483_647

/** Throw unless `value`, when given, is a finite integer from 1 to `max`, naming the option. */
function requireBoundedInteger(option: string, value: number | undefined, max: number): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 1 || value > max) {
    // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
    throw invalidConfig(`${option} must be an integer from 1 to ${String(max)}`)
  }
}

/** Validate hold TTL and reaper interval: bounded positive integers, the interval one `setInterval` can run. */
function validateHolds(options: BymaxAiTokensModuleOptions): void {
  const holds = options.holds
  if (holds === undefined) return
  requireBoundedInteger('holds.ttlSeconds', holds.ttlSeconds, MAX_TTL_SECONDS)
  requireBoundedInteger('holds.reaperIntervalSeconds', holds.reaperIntervalSeconds, MAX_TIMER_SECONDS)
}

/**
 * Validate the settlement sweep: a boolean switch, a grace of whole seconds that a timer unit can hold, and a retention
 * of whole seconds that exceeds both the grace and the hold TTL. The relations are checked on the effective values, the
 * defaults included, because a retention that is shorter than the longest a hold or a sweep can still judge a key would
 * delete the application that protects it.
 */
function validateSettlement(options: BymaxAiTokensModuleOptions): void {
  const settlement = options.settlement
  requireBoundedInteger('settlement.graceSeconds', settlement?.graceSeconds, MAX_TIMER_SECONDS)
  requireBoundedInteger('settlement.retentionSeconds', settlement?.retentionSeconds, MAX_TTL_SECONDS)
  const retention = settlement?.retentionSeconds ?? D.settlement.retentionSeconds
  const grace = settlement?.graceSeconds ?? D.settlement.graceSeconds
  const ttl = options.holds?.ttlSeconds ?? D.holds.ttlSeconds
  if (retention <= grace || retention <= ttl) {
    // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
    throw invalidConfig('settlement.retentionSeconds must exceed settlement.graceSeconds and holds.ttlSeconds')
  }
}

/** Validate the content-capture TTL and the report export cap: positive integers. */
function validateCounts(options: BymaxAiTokensModuleOptions): void {
  requireBoundedInteger('content.ttlSeconds', options.content?.ttlSeconds, MAX_TTL_SECONDS)
  requireBoundedInteger('reporting.maxExportRows', options.reporting?.maxExportRows, Number.MAX_SAFE_INTEGER)
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
      // Stryker disable next-line StringLiteral: error reason template is internal diagnostics
      'pricing.cacheTtlMs must be a positive integer number of milliseconds',
    )
  }
}

/** Validate wallet credit rate (> 0) and overdraft (>= 0). */
function validateWallets(options: BymaxAiTokensModuleOptions): void {
  const wallets = options.wallets
  if (wallets === undefined) return
  if (wallets.creditRateNanoUsd !== undefined && !isPositiveBigint(wallets.creditRateNanoUsd)) {
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    throw invalidConfig('wallets.creditRateNanoUsd must be a bigint from 1 to 9223372036854775807')
  }
  if (wallets.overdraftNanoUsd !== undefined && !isNonNegativeBigint(wallets.overdraftNanoUsd)) {
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    throw invalidConfig('wallets.overdraftNanoUsd must be a bigint from 0 to 9223372036854775807')
  }
}

/**
 * Validate the module options at init, throwing a typed exception on the first
 * failure.
 *
 * @param options The host-provided module options.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` or `AI_TOKENS_FX_REQUIRED`.
 */
export function validateOptions(given: BymaxAiTokensModuleOptions): void {
  validateProtections(given)
  const options = withoutNullish(given)
  validateShapes(options)
  validateStorePorts(options)
  validateFeaturePorts(options)
  validateEnums(options)
  validateCurrency(options)
  validateMarkup(options.markup)
  validateBudgetThresholds(options)
  validateHolds(options)
  validateSettlement(options)
  validateCounts(options)
  validateWallets(options)
  validatePricing(options)
}
