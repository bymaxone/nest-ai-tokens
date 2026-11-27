/**
 * @fileoverview The claim row of an orphan wallet debit: the released row a sweep appends under the key of a debit that no
 * ledger row stands behind. It is never a call: its provider and feature carry a fixed value, its status is `released`
 * so no usage read counts it, and it keeps the wallet's debit key in `requestId` so that the refund it owes is the
 * rollback refund of that same debit, which is given back once however many parties try.
 * @layer server
 */

import type { Logger } from '@nestjs/common'
import type { UsageRecord } from '../../shared'
import { AiTokensException } from '../errors'
import { suppliedDetails } from './detail-text'

/** The reason on the effects-owed marker of a claim row: the owed effect is the wallet refund and nothing else. */
export const ORPHAN_DEBIT_REASON = 'orphan-debit'
/** The fixed provider and feature of a claim row. */
export const ORPHAN_CLAIM = 'orphan-claim'
/** Stable log key for a late append that met a claim row; the line carries the claim row id and nothing else. */
export const LATE_APPEND_LOG_KEY = 'ai_tokens.orphan_claim.late_append'

/** The wallet debit key prefixes of a hold and of an enforced record, with the refund the inline rollback of each sends. */
const DEBITS = [
  { prefix: 'hold:', refundPrefix: 'hold-rollback:', reason: 'hold rollback' },
  { prefix: 'record:', refundPrefix: 'record-rollback:', reason: 'enforcement rollback' },
] as const

/** The prefixes of the debit keys the sweep lists. */
export const DEBIT_PREFIXES: string[] = DEBITS.map((debit) => debit.prefix)

/** The ledger key a wallet debit key belongs to, or `null` when the key is neither a hold's nor a record's. */
export function ledgerKeyOfDebit(debitKey: string): string | null {
  const debit = DEBITS.find((candidate) => debitKey.startsWith(candidate.prefix))
  return debit === undefined ? null : debitKey.slice(debit.prefix.length)
}

/**
 * The refund the inline rollback of a debit sends: its key and its reason. The claim's refund repeats both exactly, because
 * the wallet replays a refund only for an identical payload, so a debit the rollback already returned is not returned twice.
 */
export function rollbackOfDebit(debitKey: string): { key: string; reason: string } | null {
  const debit = DEBITS.find((candidate) => debitKey.startsWith(candidate.prefix))
  return debit === undefined
    ? null
    : { key: `${debit.refundPrefix}${debitKey.slice(debit.prefix.length)}`, reason: debit.reason }
}

/** Whether a ledger row is the claim of an orphan debit. */
export function isOrphanClaim(row: Pick<UsageRecord, 'provider' | 'feature'>): boolean {
  return row.provider === ORPHAN_CLAIM && row.feature === ORPHAN_CLAIM
}

/**
 * The refusal of a call whose key the sweep claimed: one warn line naming the claim row, never an amount or a payer, and the
 * idempotency conflict a different payload under the key gets.
 *
 * @param logger Where the line is written.
 * @param claim The claim row found under the key.
 */
export function lateAppend(logger: Logger, claim: UsageRecord): AiTokensException {
  logger.warn(`${LATE_APPEND_LOG_KEY} claim=${claim.id}`)
  return new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, suppliedDetails({ tenantId: claim.tenantId, idempotencyKey: claim.idempotencyKey }))
}

/**
 * Whether a row can share the wallet debit of a call of one kind. A claim stands for the single debit its `requestId` names,
 * and a hold and a record on one key debit under different keys, so a claim shares only the debit of its own kind.
 *
 * @param row The row found under the key.
 * @param kind The debit key prefix of the call that is asking.
 */
export function claimShares(
  row: Pick<UsageRecord, 'provider' | 'feature' | 'requestId'>,
  kind: (typeof DEBIT_PREFIXES)[number],
): boolean {
  return isOrphanClaim(row) && row.requestId?.startsWith(kind) === true
}
