/**
 * @fileoverview Internal helpers for the auth-hold lifecycle (spec §11.1/§2.2):
 * resolving a {@link HoldEstimate} to a rated reservation, mapping a
 * {@link NormalizedUsage} to the ledger's token columns, and normalizing the
 * provider usage handed to `capture()`. A `{ tokens }` or `{ amountNanoUsd }`
 * estimate carries no response model, and a settlement (`pending → posted`) may
 * NOT patch identity columns (§8.3) — so those variants record a documented
 * placeholder provider/model that capture does not overwrite; hosts needing the
 * exact model on the ledger use the `{ provider, model, … }` variant. No
 * prompt/response text passes through here. Internal — not part of the public barrel.
 * @layer server
 */

import type {
  AiOperation,
  NormalizedUsage,
  PriceVersion,
  ProviderId,
  ServiceTier,
} from '../../shared'
import { AI_OPERATIONS, TOKEN_CATEGORIES } from '../../shared'
import { ratedCost } from '../utils/rated-cost'
import { AiTokensException } from '../errors'
import { setErrorMessage } from '../errors/set-error-message'
import type { HoldCaller, HoldEstimate, MeteringContext } from '../interfaces'
import { assertObject, assertOptionalText, assertText, labelOf } from '../utils/argument-guards'
import { isCount, isNonNegativeBigint } from '../utils/numeric-guards'
import type { PricingService } from './pricing.service'

/** The placeholder recorded for a token/amount estimate that carries no model (§11.1). */
const UNSPECIFIED = 'unspecified'
/** Nano-USD-per-million divisor for a per-token rate (matches the cost engine, §7.1). */
const PER_MILLION = 1_000_000n

/** The ledger's ten token columns, derived once from the rated categories (§5). */
const TOKEN_FIELDS = TOKEN_CATEGORIES.map((category) => `${category}Tokens` as keyof TokenCounts)

/** The ten per-category token counts an estimate or a settlement writes. */
export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  reasoningTokens: number
  audioInTokens: number
  audioOutTokens: number
  imageInTokens: number
  imageOutTokens: number
}

/** A rated hold estimate: the reservation cost, its token total, and the placeholder call identity. */
export interface ResolvedHoldEstimate {
  provider: ProviderId
  model: string
  operation: AiOperation
  serviceTier: ServiceTier
  /** Raw (pre-markup) estimated cost in nano-USD. */
  rawEstimateNanoUsd: bigint
  /** Total estimated tokens (sum of the per-category counts). */
  estimatedTokens: number
  /** The per-category token counts to persist on the pending row. */
  tokenCounts: TokenCounts
}

/** All ten token counts zeroed. */
export function zeroTokenCounts(): TokenCounts {
  return {
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
  }
}

/** Extract the ten token counts from a normalized usage. */
export function tokenCountsOf(usage: NormalizedUsage): TokenCounts {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWrite5mTokens: usage.cacheWrite5mTokens,
    cacheWrite1hTokens: usage.cacheWrite1hTokens,
    reasoningTokens: usage.reasoningTokens,
    audioInTokens: usage.audioInTokens,
    audioOutTokens: usage.audioOutTokens,
    imageInTokens: usage.imageInTokens,
    imageOutTokens: usage.imageOutTokens,
  }
}

/** Sum every category into the record's `totalTokens`. */
export function sumTokenCounts(counts: TokenCounts): number {
  return TOKEN_FIELDS.reduce((total, field) => total + counts[field], 0)
}

/**
 * Refuse a usage whose counts or cost cannot be billed: every token count and tool unit count must be a whole number from 0 to the
 * largest safe integer, and a provider-reported cost must not be negative. A count is never repaired: a negative one flowing into the
 * signed settlement leg credits back more than was reserved and drives budget consumption negative, and the cost arithmetic converts
 * each count to a `BigInt`, which takes whole numbers only. `isNormalizedUsage` only proves each field is finite, so the guarantee is
 * enforced here, on the value every cost and settlement is computed from.
 *
 * @param usage The normalized usage, from a normalizer or from the host.
 * @returns The same usage.
 * @throws {AiTokensException} `AI_TOKENS_USAGE_MALFORMED` for a count that is not a whole number of 0 or more, a negative reported cost, or tokens that add up to more than a ledger row stores.
 */
export function checkUsageCounts(usage: NormalizedUsage): NormalizedUsage {
  const counts = tokenCountsOf(usage)
  const units = Object.values(usage.serverToolUse ?? {})
  const cost = usage.providerReportedCostNanoUsd
  if (TOKEN_FIELDS.every((field) => isCount(counts[field])) && units.every(isCount) && (cost === undefined || isNonNegativeBigint(cost))) return checkStorableTokens(usage)
  throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, {
    reason: 'every token and tool unit count of a usage must be a whole number from 0 to the largest safe integer, and a reported cost must not be negative',
  })
}

/**
 * The tool units of a usage that have a count above 0 and no rate of their own in the price, by the name a refusal may carry. A unit named
 * like an inherited property (`constructor`) has no rate of its own.
 *
 * @param usage The usage being rated.
 * @param rate The price version it is rated at.
 * @returns The unit names, in the order the usage lists them.
 */
export function unpricedUnits(usage: NormalizedUsage, rate: PriceVersion): string[] {
  return Object.entries(usage.serverToolUse ?? {}).filter(([unit, count]) => count > 0 && !(rate.unitRates !== undefined && Object.hasOwn(rate.unitRates, unit))).map(([unit]) => labelOf(unit))
}

/** The most tokens one ledger row stores: its token columns are 32-bit integers. */
const LEDGER_MAX_TOKENS = 2_147_483_647

/**
 * Refuse a usage whose tokens add up to more than a ledger row stores, before anything is debited: a row the store cannot hold would be
 * refused after the wallet was charged, with no row to show for it.
 *
 * @param usage The usage whose counts passed {@link checkUsageCounts}.
 * @returns The same usage.
 * @throws {AiTokensException} `AI_TOKENS_USAGE_MALFORMED` when the tokens add up to more than {@link LEDGER_MAX_TOKENS}.
 */
function checkStorableTokens(usage: NormalizedUsage): NormalizedUsage {
  if (sumTokenCounts(tokenCountsOf(usage)) <= LEDGER_MAX_TOKENS) return usage
  throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'the tokens of a usage add up to more than a ledger row stores (2147483647)' })
}

/** Whether a value is a complete, well-typed {@link NormalizedUsage} (every token field finite). */
export function isNormalizedUsage(usage: unknown): usage is NormalizedUsage {
  if (typeof usage !== 'object' || usage === null) return false
  const candidate = usage as Record<string, unknown>
  if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') return false
  if (typeof candidate.operation !== 'string' || !(AI_OPERATIONS as readonly string[]).includes(candidate.operation)) {
    return false
  }
  return TOKEN_FIELDS.every((field) => Number.isFinite(candidate[field]))
}

/** Discriminate a `{ provider, model, … }` estimate (variant A). */
function isRatedEstimate(estimate: HoldEstimate): estimate is Extract<HoldEstimate, { provider: ProviderId }> {
  return 'provider' in estimate
}

/** Discriminate a `{ tokens }` estimate (variant B). */
function isTokenEstimate(estimate: HoldEstimate): estimate is { tokens: number } {
  return 'tokens' in estimate
}

/** Build the synthetic usage a `{ provider, model, … }` estimate rates against. */
function syntheticUsage(estimate: Extract<HoldEstimate, { provider: ProviderId }>, serviceTier: ServiceTier): NormalizedUsage {
  return {
    provider: estimate.provider,
    model: estimate.model,
    operation: estimate.operation,
    serviceTier,
    ...zeroTokenCounts(),
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.maxOutputTokens,
  }
}

/**
 * Refuse a hold estimate that is not an object, whose identity is not text, whose amounts are not whole non-negative counts or whose
 * amount is not a non-negative bigint, naming the field and echoing no value.
 *
 * @param estimate The estimate as the caller passed it.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the first field that is not valid.
 */
export function assertHoldEstimate(estimate: HoldEstimate): void {
  assertObject('estimate', estimate)
  if (isRatedEstimate(estimate)) {
    assertText('estimate.provider', estimate.provider)
    assertText('estimate.model', estimate.model)
    assertText('estimate.operation', estimate.operation)
    assertOptionalText('estimate.serviceTier', estimate.serviceTier)
  }
  const fields: [string, unknown][] = isRatedEstimate(estimate)
    ? [['inputTokens', estimate.inputTokens], ['maxOutputTokens', estimate.maxOutputTokens]]
    : isTokenEstimate(estimate)
      ? [['tokens', estimate.tokens]]
      : []
  for (const [name, value] of fields) {
    if (!isCount(value)) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: `${name} of a hold estimate must be a whole number of 0 or more` })
  }
  if (!isRatedEstimate(estimate) && !isTokenEstimate(estimate) && !isNonNegativeBigint(estimate.amountNanoUsd)) {
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'amountNanoUsd of a hold estimate must be a bigint from 0 to 9223372036854775807' })
  }
}

/**
 * Rate a {@link HoldEstimate} into a reservation. Variant A rates a synthetic
 * usage at the model's effective price; variant B (`{ tokens }`, requires
 * `context.preset`) rates the count at the model's input rate (a stable per-token
 * choice) when `context.baseModel` names a priced model, else reserves quota only;
 * variant C (`{ amountNanoUsd }`) is already raw-rated. Markup is applied by the caller.
 *
 * @param pricing The pricing service (rate resolution).
 * @param context The metering context (preset/baseModel/tier).
 * @param estimate The hold estimate variant.
 * @param at The instant to resolve the effective price at.
 * @returns The rated reservation.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when a `{ tokens }` estimate lacks `context.preset`.
 */
export async function resolveHoldEstimate(
  pricing: PricingService,
  context: MeteringContext,
  estimate: HoldEstimate,
  at: Date,
): Promise<ResolvedHoldEstimate> {
  const resolved = await rateHoldEstimate(pricing, context, estimate, at)
  // A reservation is made before the row is appended: an estimate the row cannot store would be charged and then fail with no row to show for it.
  if (resolved.estimatedTokens > LEDGER_MAX_TOKENS) {
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'the tokens of a hold estimate add up to more than a ledger row stores (2147483647)' })
  }
  return resolved
}

/** The reservation an estimate rates to, before the bound of a ledger row is checked. */
async function rateHoldEstimate(
  pricing: PricingService,
  context: MeteringContext,
  estimate: HoldEstimate,
  at: Date,
): Promise<ResolvedHoldEstimate> {
  const serviceTier = context.serviceTier ?? 'standard'
  if (isRatedEstimate(estimate)) {
    const tier = estimate.serviceTier ?? serviceTier
    const usage = syntheticUsage(estimate, tier)
    const rate = await pricing.resolveRate({
      provider: estimate.provider,
      model: estimate.model,
      operation: estimate.operation,
      serviceTier: tier,
      at,
      ...(context.baseModel !== undefined ? { baseModel: context.baseModel } : {}),
    })
    const rawEstimateNanoUsd = rate === null ? 0n : ratedCost(usage, rate).totalNanoUsd
    const tokenCounts: TokenCounts = { ...zeroTokenCounts(), inputTokens: estimate.inputTokens, outputTokens: estimate.maxOutputTokens }
    return { provider: estimate.provider, model: estimate.model, operation: estimate.operation, serviceTier: tier, rawEstimateNanoUsd, estimatedTokens: sumTokenCounts(tokenCounts), tokenCounts }
  }
  if (isTokenEstimate(estimate)) {
    return resolveTokenEstimate(pricing, context, estimate.tokens, serviceTier, at)
  }
  const tokenCounts = zeroTokenCounts()
  return {
    provider: context.preset?.provider ?? UNSPECIFIED,
    model: context.baseModel ?? UNSPECIFIED,
    operation: 'chat',
    serviceTier,
    rawEstimateNanoUsd: estimate.amountNanoUsd,
    estimatedTokens: 0,
    tokenCounts,
  }
}

/** Rate a `{ tokens }` estimate at the preset model's input rate (variant B). */
async function resolveTokenEstimate(
  pricing: PricingService,
  context: MeteringContext,
  tokens: number,
  serviceTier: ServiceTier,
  at: Date,
): Promise<ResolvedHoldEstimate> {
  if (context.preset === undefined) {
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
      reason: 'a { tokens } hold estimate requires context.preset to identify the provider',
    })
  }
  const provider = context.preset.provider
  const model = context.baseModel ?? UNSPECIFIED
  let rawEstimateNanoUsd = 0n
  if (context.baseModel !== undefined) {
    const rate: PriceVersion | null = await pricing.resolveRate({ provider, model, operation: 'chat', serviceTier, at })
    if (rate !== null) rawEstimateNanoUsd = (BigInt(tokens) * rate.inputNanoUsdPerMillion) / PER_MILLION
  }
  const tokenCounts: TokenCounts = { ...zeroTokenCounts(), inputTokens: tokens }
  return { provider, model, operation: 'chat', serviceTier, rawEstimateNanoUsd, estimatedTokens: tokens, tokenCounts }
}

/**
 * Normalize the usage handed to `capture()`: an already-normalized usage is
 * accepted as-is, a preset's normalizer parses a raw payload, and anything else is
 * malformed. Never reads prompt/response text.
 *
 * @param usage The provider usage (raw or normalized).
 * @param normalizer The preset normalizer, when the caller supplied a preset.
 * @returns The normalized usage.
 * @throws {AiTokensException} `AI_TOKENS_USAGE_MALFORMED` when the usage cannot be normalized.
 */
export function normalizeCaptureUsage(usage: unknown, normalizer?: (raw: unknown) => NormalizedUsage): NormalizedUsage {
  if (isNormalizedUsage(usage)) return checkUsageCounts(usage)
  if (normalizer !== undefined) {
    try {
      return checkUsageCounts(normalizer(usage))
    } catch (error) {
      if (error instanceof AiTokensException) throw error
      throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'the normalizer could not read the usage token fields' })
    }
  }
  throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, {
    reason: 'capture requires an already-normalized usage or a preset normalizer',
  })
}

/**
 * Throw unless `caller` is a tenant and a payer scope: `{ non-empty string tenantId, scope object with string type and id }`.
 * The compiler cannot vouch for an `any` or plain-JavaScript caller, and a wrong value in this position, such as a usage
 * object, would otherwise be read as a caller, so it is refused here, before the store is read, with a message that says
 * what to pass.
 *
 * @param caller The value passed as the caller.
 * @param signature The call to show in the message, e.g. `capture(hold, caller, usage)`.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG`.
 */
export function assertCaller(caller: unknown, signature: string): asserts caller is HoldCaller {
  const { tenantId, scope } = (caller ?? {}) as Partial<HoldCaller>
  if (typeof tenantId !== 'string' || tenantId === '' || typeof scope?.type !== 'string' || typeof scope.id !== 'string') {
    const message = `${signature}: the second argument must be the caller { tenantId, scope } (since 1.1.15)`
    throw setErrorMessage(new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: message }), message)
  }
}
