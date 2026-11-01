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
import type { FieldRole } from './payload-fields'
import { pickByRole } from './payload-fields'

/** Every field that describes the metered call, request or derived. */
const HASHED_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>(['request', 'derived', 'rated-cost', 'occurred-at'])

/**
 * Compute the canonical payload hash for a ledger record. Equal metered content
 * yields an identical hash regardless of the (possibly random) idempotency key.
 *
 * @param record The record about to be appended.
 * @returns A 64-character lowercase hex SHA-256 digest of the record's content.
 */
export function computePayloadHash(record: NewUsageRecord): string {
  return deriveIdempotencyKey(pickByRole(record, HASHED_ROLES))
}
