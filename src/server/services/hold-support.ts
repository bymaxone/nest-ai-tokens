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
import { AI_OPERATIONS, TOKEN_CATEGORIES, computeCostNanoUsd } from '../../shared'
import { AiTokensException } from '../errors'
import type { HoldEstimate, MeteringContext } from '../interfaces'
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

/** Whether a value is a complete, well-typed {@link NormalizedUsage} (every token field finite). */
export function isNormalizedUsage(usage: unknown): usage is NormalizedUsage {
  // Stryker disable next-line ConditionalExpression -- redundant sub-condition: the `typeof usage !== 'object' → false` variant leaves `usage === null`, and any non-object non-null value is still rejected downstream by `typeof candidate.provider !== 'string'`, so it is behavior-preserving
  if (typeof usage !== 'object' || usage === null) return false
  const candidate = usage as Record<string, unknown>
  if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') return false
  if (typeof candidate.operation !== 'string' || !(AI_OPERATIONS as readonly string[]).includes(candidate.operation)) {
    return false
  }
  // Stryker disable next-line ConditionalExpression -- redundant sub-condition: the `typeof candidate[field] === 'number' → true` variant still fails the `Number.isFinite(candidate[field])` operand for a non-number field, so `.every` returns false either way
  return TOKEN_FIELDS.every((field) => typeof candidate[field] === 'number' && Number.isFinite(candidate[field]))
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
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { baseModel: undefined } is equivalent to {} because resolveRate reads input.baseModel (undefined either way) — same cache key and same `baseModel !== undefined` resolution branch
      ...(context.baseModel !== undefined ? { baseModel: context.baseModel } : {}),
    })
    const rawEstimateNanoUsd = rate === null ? 0n : computeCostNanoUsd(usage, rate).totalNanoUsd
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
    // Stryker disable next-line ObjectLiteral -- error context is internal diagnostics; tests check error code only
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
      // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics
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
  if (isNormalizedUsage(usage)) return usage
  if (normalizer !== undefined) {
    try {
      return normalizer(usage)
    } catch (error) {
      if (error instanceof AiTokensException) throw error
      // Stryker disable next-line ObjectLiteral,StringLiteral -- error context and reason are internal diagnostics
      throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'the normalizer could not read the usage token fields' })
    }
  }
  // Stryker disable next-line ObjectLiteral -- error context is internal diagnostics
  throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, {
    // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics
    reason: 'capture requires an already-normalized usage or a preset normalizer',
  })
}
