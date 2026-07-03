/**
 * @fileoverview The internal ledger payload hash (spec §8.4). Reuses the shared
 * canonical-JSON SHA-256 (`deriveIdempotencyKey`) over the immutable content of a
 * usage record so a replay with the same `(tenantId, idempotencyKey)` can be told
 * apart from a genuine conflict. Only fields that describe WHAT was metered
 * participate; lifecycle/annotation/store-computed fields are excluded so a
 * legitimate settlement or reversal annotation never changes an existing record's
 * hash.
 *
 * Participating fields: `scope`, `beneficiary`, `requestedBy`, `provider`,
 * `model`, `requestedModel`, `operation`, `serviceTier`, `feature`, `tags`, every
 * token category, `totalTokens`, `extraUnits`, `priceVersionId`, `rawCostNanoUsd`,
 * `surchargeNanoUsd`, `billedCostNanoUsd`, `markupMultiplier`, `currency`,
 * `priceMissing`, `correlationId`, `requestId`, `isSystemCost`,
 * `systemCostCategory`, `enforced`, `reversesRecordId`, `occurredAt`.
 *
 * Excluded (mutable, annotation, or store-computed): `id`, `idempotencyKey`,
 * `status`, `reversedByRecordId`, `prevHash`, `hash`, `createdAt`, `updatedAt`.
 * @layer server
 */

import type { NewUsageRecord } from '../../shared'
import { deriveIdempotencyKey } from '../../shared'

/**
 * Compute the canonical payload hash for a ledger record. Equal metered content
 * yields an identical hash regardless of the (possibly random) idempotency key.
 *
 * @param record The record about to be appended.
 * @returns A 64-character lowercase hex SHA-256 digest of the record's content.
 */
export function computePayloadHash(record: NewUsageRecord): string {
  return deriveIdempotencyKey({
    scope: record.scope,
    beneficiary: record.beneficiary,
    requestedBy: record.requestedBy,
    provider: record.provider,
    model: record.model,
    requestedModel: record.requestedModel,
    operation: record.operation,
    serviceTier: record.serviceTier,
    feature: record.feature,
    tags: record.tags,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWrite5mTokens: record.cacheWrite5mTokens,
    cacheWrite1hTokens: record.cacheWrite1hTokens,
    reasoningTokens: record.reasoningTokens,
    audioInTokens: record.audioInTokens,
    audioOutTokens: record.audioOutTokens,
    imageInTokens: record.imageInTokens,
    imageOutTokens: record.imageOutTokens,
    totalTokens: record.totalTokens,
    extraUnits: record.extraUnits,
    priceVersionId: record.priceVersionId,
    rawCostNanoUsd: record.rawCostNanoUsd,
    surchargeNanoUsd: record.surchargeNanoUsd,
    billedCostNanoUsd: record.billedCostNanoUsd,
    markupMultiplier: record.markupMultiplier,
    currency: record.currency,
    priceMissing: record.priceMissing,
    correlationId: record.correlationId,
    requestId: record.requestId,
    isSystemCost: record.isSystemCost,
    systemCostCategory: record.systemCostCategory,
    enforced: record.enforced,
    reversesRecordId: record.reversesRecordId,
    occurredAt: record.occurredAt,
  })
}
