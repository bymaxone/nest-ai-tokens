/**
 * @fileoverview The pieces of `record()` that decide whether a call whose idempotency key the
 * ledger already holds is a replay of the stored call. A replay returns the stored record and
 * runs nothing else; a call whose request differs conflicts. Internal — not part of the public
 * barrel.
 * @layer server
 */

import type { AiTokensErrorResponse, NewUsageRecord, NormalizedUsage, UsageRecord, UsageStatus } from '../../shared'
import { AiTokensException } from '../errors'
import type { ReplayBasis } from '../utils/replay-match'
import { sameRequest } from '../utils/replay-match'
import type { ResolvedMarkup } from './markup.resolver'

/** The resolved rating of one call, in exact bigint nano-USD. */
export interface RatingResult {
  rawCostNanoUsd: bigint
  surchargeNanoUsd: bigint
  priceVersionId: string | null
  priceMissing: boolean
}

/** The result of one `record()` call: the record and whether it was a replay of an earlier call. */
export interface RecordOutcome {
  record: UsageRecord
  replayed: boolean
}

/** The markup of a call that is only being compared, not billed. */
export const NEUTRAL_MARKUP: ResolvedMarkup = { multiplier: 1, apply: (raw: bigint): bigint => raw }

/**
 * The cost a provider-reported call carries.
 *
 * @param usage The normalized usage of the call.
 * @returns The provider's cost.
 * @throws {AiTokensException} `AI_TOKENS_USAGE_MALFORMED` when the usage carries no cost.
 */
export function requireReportedCost(usage: NormalizedUsage): bigint {
  const cost = usage.providerReportedCostNanoUsd
  if (cost === undefined) {
    // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason text are internal diagnostics; tests check error code only
    throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'provider-reported rating requires providerReportedCostNanoUsd' })
  }
  return cost
}

/**
 * The rating of a call that is only being compared. The raw cost is part of the request only when
 * the provider reports it, and then a usage without one is malformed whether or not the key is stored.
 */
export function unratedFor(normalized: NormalizedUsage, basis: ReplayBasis): RatingResult {
  const raw = basis.providerReported ? requireReportedCost(normalized) : 0n
  return { rawCostNanoUsd: raw, surchargeNanoUsd: 0n, priceVersionId: null, priceMissing: false }
}

/** Whether an error is the ledger reporting a key already used for a different payload. */
export function isIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof AiTokensException)) return false
  const body = error.getResponse() as AiTokensErrorResponse
  return body.error.code === 'AI_TOKENS_IDEMPOTENCY_CONFLICT'
}

/** The statuses of a recorded call. A hold that has not been captured is not one, whatever its fields say. */
const RECORDED: ReadonlySet<UsageStatus> = new Set<UsageStatus>(['posted', 'reversed'])

/** The stored record when it is a recorded call with the same request as this call, else the idempotency conflict. */
export function replayOf(stored: UsageRecord, request: NewUsageRecord, basis: ReplayBasis): UsageRecord {
  if (RECORDED.has(stored.status) && sameRequest(stored, request, basis)) return stored
  // Stryker disable next-line ObjectLiteral: error context is internal diagnostics; tests check error code only
  throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, { tenantId: stored.tenantId, idempotencyKey: stored.idempotencyKey })
}
