/**
 * @fileoverview Decides whether a stored ledger record is the same REQUEST as a new one, so a
 * retry that repeats the request but not the values computed while serving it (a defaulted
 * `occurredAt`, the price in force, the markup) is a replay and not a conflict. It reads the
 * field roles in `payload-fields` and the same canonical JSON as the payload hash, so what counts
 * as equal (key order, `undefined`, bigint, dates) cannot drift between the two.
 * @layer server
 */

import type { NewUsageRecord } from '../../shared'
import { deriveIdempotencyKey } from '../../shared'
import type { FieldRole } from './payload-fields'
import { pickByRole } from './payload-fields'

/** What the new request tells us about which conditional fields it controls. */
export interface ReplayBasis {
  /** The rating comes from the provider's own cost, so the raw cost is part of the request. */
  providerReported: boolean
  /** The caller passed `occurredAt`; otherwise it was defaulted to the current time. */
  occurredAtSupplied: boolean
  /** The model the response carried, before an empty one was named after `baseModel`. */
  responseModel: string
}

/** The digest of the fields that describe the request. */
export function requestFingerprint(record: NewUsageRecord, basis: Pick<ReplayBasis, 'providerReported' | 'occurredAtSupplied'>): string {
  const roles = new Set<FieldRole>(['request'])
  if (basis.providerReported) roles.add('rated-cost')
  if (basis.occurredAtSupplied) roles.add('occurred-at')
  return deriveIdempotencyKey(pickByRole(record, roles))
}

/**
 * Whether `stored` is the same request as `candidate`. A stored empty model matches a candidate
 * whose response carried none, whether the row kept the empty model or the name filled in from
 * `baseModel`.
 *
 * @param stored The record the idempotency key already holds.
 * @param candidate The record this call would append.
 * @param basis Which conditional fields the new request controls.
 * @returns `true` when every request field is equal.
 */
export function sameRequest(stored: NewUsageRecord, candidate: NewUsageRecord, basis: ReplayBasis): boolean {
  const stand = requestFingerprint(stored, basis)
  if (requestFingerprint(candidate, basis) === stand) return true
  return requestFingerprint({ ...candidate, model: basis.responseModel }, basis) === stand
}
