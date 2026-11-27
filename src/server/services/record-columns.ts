/**
 * @fileoverview The ledger columns of a metered call: the attribution and identity columns shared by the settled and the
 * pending append, the append input of a settled `record()`, and the model the record is stored under. Pure functions
 * over the call's context and rating, used by the metering facade. Internal — not part of the public barrel.
 * @layer server
 */

import { defined } from '../utils/defined'
import type { NormalizedUsage, ServiceTier, UsageRecord } from '../../shared'
import type { MeteringContext } from '../interfaces'
import type { LedgerAppendInput } from './ledger.service'
import type { ResolvedMarkup } from './markup.resolver'
import type { RatingResult } from './record-replay'
import { sumTokenCounts, type TokenCounts } from './hold-support'

/** Build the ledger append input for a settled `record()` (§8.2 columns). */
export function buildAppendInput(args: {
  normalized: NormalizedUsage
  context: MeteringContext
  serviceTier: ServiceTier
  occurredAt: Date
  rating: RatingResult
  markup: ResolvedMarkup
  ratedUnits: Record<string, number>
  enforced: boolean
}): LedgerAppendInput {
  const { normalized, context, serviceTier, occurredAt, rating, markup, ratedUnits, enforced } = args
  return {
    ...baseColumns(normalized, context, serviceTier),
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    cacheReadTokens: normalized.cacheReadTokens,
    cacheWrite5mTokens: normalized.cacheWrite5mTokens,
    cacheWrite1hTokens: normalized.cacheWrite1hTokens,
    reasoningTokens: normalized.reasoningTokens,
    audioInTokens: normalized.audioInTokens,
    audioOutTokens: normalized.audioOutTokens,
    imageInTokens: normalized.imageInTokens,
    imageOutTokens: normalized.imageOutTokens,
    ...(Object.keys(ratedUnits).length > 0 ? { extraUnits: ratedUnits } : {}),
    priceVersionId: rating.priceVersionId,
    rawCostNanoUsd: rating.rawCostNanoUsd,
    surchargeNanoUsd: rating.surchargeNanoUsd,
    billedCostNanoUsd: markup.apply(rating.rawCostNanoUsd),
    markupMultiplier: markup.multiplier,
    currency: 'USD',
    priceMissing: rating.priceMissing,
    status: 'posted',
    isSystemCost: context.isSystemCost ?? false,
    ...defined({ systemCostCategory: context.systemCostCategory }),
    enforced,
    occurredAt,
  }
}

/**
 * Name the model after `baseModel` when the response carried none (a Bedrock Converse
 * response has no model id), so a record stores the same model a hold + capture does.
 * A model the response did carry is never replaced.
 */
export function withBaseModel(usage: NormalizedUsage, baseModel: string | undefined): NormalizedUsage {
  return usage.model === '' && baseModel !== undefined ? { ...usage, model: baseModel } : usage
}

/** The attribution/identity columns shared by settled and pending appends. */
export function baseColumns(
  usage: Pick<NormalizedUsage, 'provider' | 'model' | 'operation'>,
  context: MeteringContext,
  serviceTier: ServiceTier,
): Pick<LedgerAppendInput, 'tenantId' | 'scope' | 'beneficiary' | 'requestedBy' | 'provider' | 'model' | 'requestedModel' | 'operation' | 'serviceTier' | 'feature' | 'tags' | 'correlationId'> {
  return {
    tenantId: context.tenantId,
    scope: context.scope,
    ...defined({ beneficiary: context.beneficiary }),
    ...defined({ requestedBy: context.requestedBy }),
    provider: usage.provider,
    model: usage.model,
    ...defined({ requestedModel: context.baseModel }),
    operation: usage.operation,
    serviceTier,
    feature: context.feature,
    tags: context.tags ?? [],
    ...defined({ correlationId: context.correlationId }),
  }
}

/**
 * The settlement patch of a `pending → posted` transition: the actual token counts, the rated cost and the pricing metadata, and the
 * tool units the call was billed for (none when it had none).
 */
export function settlementPatch(counts: TokenCounts, rating: RatingResult, markup: ResolvedMarkup, ratedUnits: Record<string, number>): Partial<UsageRecord> {
  return {
    ...counts,
    totalTokens: sumTokenCounts(counts),
    rawCostNanoUsd: rating.rawCostNanoUsd,
    surchargeNanoUsd: rating.surchargeNanoUsd,
    billedCostNanoUsd: markup.apply(rating.rawCostNanoUsd),
    markupMultiplier: markup.multiplier,
    priceVersionId: rating.priceVersionId,
    priceMissing: rating.priceMissing,
    ...(Object.keys(ratedUnits).length > 0 ? { extraUnits: ratedUnits } : {}),
  }
}
