/**
 * @fileoverview The single classification of every ledger record field, shared by the payload
 * hash and the replay fingerprint so the two cannot disagree about what a field is. A `request`
 * field describes what the caller asked for or the provider reported; a `derived` field is
 * computed when the call runs and changes with the clock or with configuration (the rating and
 * the markup). `rated-cost` is the raw cost, a derived field except when the provider reports it,
 * and `occurred-at` is a request field only when the caller supplied it; otherwise it defaults to
 * the current time. `identity` and `lifecycle` fields never describe the call.
 *
 * The type check below makes the compiler refuse a record field that has no role.
 * @layer server
 */

import type { NewUsageRecord } from '../../shared'

/** What a ledger record field describes. */
export type FieldRole = 'identity' | 'request' | 'derived' | 'rated-cost' | 'occurred-at' | 'lifecycle'

/** The fields of every role. */
export const ROLE_FIELDS = {
  identity: ['tenantId', 'idempotencyKey'],
  request: [
    'scope',
    'beneficiary',
    'requestedBy',
    'provider',
    'model',
    'requestedModel',
    'operation',
    'serviceTier',
    'feature',
    'tags',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWrite5mTokens',
    'cacheWrite1hTokens',
    'reasoningTokens',
    'audioInTokens',
    'audioOutTokens',
    'imageInTokens',
    'imageOutTokens',
    'totalTokens',
    'extraUnits',
    'correlationId',
    'requestId',
    'isSystemCost',
    'systemCostCategory',
    'enforced',
    'reversesRecordId',
  ],
  derived: ['priceVersionId', 'surchargeNanoUsd', 'billedCostNanoUsd', 'markupMultiplier', 'currency', 'priceMissing'],
  'rated-cost': ['rawCostNanoUsd'],
  'occurred-at': ['occurredAt'],
  lifecycle: ['status', 'reversedByRecordId'],
} as const satisfies Record<FieldRole, readonly (keyof NewUsageRecord)[]>

/** The record fields no role lists; the assertion below fails to compile while this is not empty. */
export type UnclassifiedField = Exclude<keyof NewUsageRecord, (typeof ROLE_FIELDS)[FieldRole][number]>

/** Compile-time proof that no record field is left without a role. */
export const EVERY_FIELD_HAS_A_ROLE: [UnclassifiedField] extends [never] ? true : false = true

/** The fields of a record whose roles are in `roles`. */
export function pickByRole(record: NewUsageRecord, roles: ReadonlySet<FieldRole>): Partial<NewUsageRecord> {
  const picked: Record<string, unknown> = {}
  for (const role of roles) {
    for (const key of ROLE_FIELDS[role]) picked[key] = record[key]
  }
  return picked
}
