/**
 * @fileoverview `LedgerService` — the append-only usage ledger core over
 * `ILedgerStore` (spec §8): exactly-once append (payload-hash replay-or-conflict,
 * §8.4), filtered queries, cost aggregation, the lifecycle state machine
 * (`transition`, §8.3), and the ledger-only compensation primitive (`reverse`,
 * §8.5 steps 1–2). Balance and spend math sums `posted` + `reversed` records only
 * (§8.3), so those are the default query statuses. The service NEVER issues an
 * `UPDATE`/`DELETE` of a posted amount — corrections are compensating records
 * (a `posted` row with negated amounts) and the sole permitted post-posting
 * mutation is the annotation-only `posted → reversed` flip.
 * @layer server
 */

import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { LedgerFilter, NewUsageRecord, UsageRecord, UsageStatus } from '../../shared'
import { AiTokensException } from '../errors'
import type { ILedgerStore, LedgerCostSummary } from '../interfaces'
import { computePayloadHash } from '../utils/payload-hash'
import { isLedgerIdempotencyConflict } from './ledger-idempotency-conflict'

/** The statuses that contribute to balance/spend sums (§8.3). */
const BALANCE_STATUSES: readonly UsageStatus[] = ['posted', 'reversed']

/** The amount fields a `posted → reversed` annotation or a `released` void may never patch (§8.5). */
const AMOUNT_FIELDS: readonly (keyof UsageRecord)[] = [
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
  'rawCostNanoUsd',
  'surchargeNanoUsd',
  'billedCostNanoUsd',
]

/** The token categories summed into a record's `totalTokens`. */
type TokenCounts = Pick<
  NewUsageRecord,
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWrite5mTokens'
  | 'cacheWrite1hTokens'
  | 'reasoningTokens'
  | 'audioInTokens'
  | 'audioOutTokens'
  | 'imageInTokens'
  | 'imageOutTokens'
>

/**
 * Caller-supplied fields for {@link LedgerService.append}; the service derives
 * `idempotencyKey` (from `ctxKey` or a random UUID) and `totalTokens`.
 */
export type LedgerAppendInput = Omit<NewUsageRecord, 'idempotencyKey' | 'totalTokens'>

/** Sum every token category into the record's `totalTokens` total. */
function sumTokens(counts: TokenCounts): number {
  return (
    counts.inputTokens +
    counts.outputTokens +
    counts.cacheReadTokens +
    counts.cacheWrite5mTokens +
    counts.cacheWrite1hTokens +
    counts.reasoningTokens +
    counts.audioInTokens +
    counts.audioOutTokens +
    counts.imageInTokens +
    counts.imageOutTokens
  )
}

@Injectable()
export class LedgerService {
  /**
   * @param store The append-only ledger store port.
   */
  constructor(private readonly store: ILedgerStore) {}

  /**
   * Append a record exactly once. The idempotency key is `ctxKey` when supplied
   * — a content-derived key deduplicates retries (§8.4) — or a random UUID
   * otherwise, in which case the record is still written once but retries are NOT
   * deduplicated. A replay with a matching payload hash returns the stored record
   * unchanged and writes nothing; the same key with a different payload throws
   * `AI_TOKENS_IDEMPOTENCY_CONFLICT`.
   *
   * @param input The record content (without `idempotencyKey`/`totalTokens`).
   * @param ctxKey The host-supplied idempotency key, when available.
   * @returns The stored record (new or the existing one on a matching replay).
   * @throws {AiTokensException} `AI_TOKENS_IDEMPOTENCY_CONFLICT` on a payload mismatch.
   */
  async append(input: LedgerAppendInput, ctxKey?: string): Promise<UsageRecord> {
    const record: NewUsageRecord = {
      ...input,
      idempotencyKey: ctxKey ?? randomUUID(),
      totalTokens: sumTokens(input),
    }
    const payloadHash = computePayloadHash(record)
    try {
      return await this.store.append(record, payloadHash)
    } catch (error) {
      if (isLedgerIdempotencyConflict(error)) {
        throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
          tenantId: error.tenantId,
          idempotencyKey: error.idempotencyKey,
        })
      }
      throw error
    }
  }

  /**
   * Look up a record by its per-tenant idempotency key.
   *
   * @param tenantId The owning tenant.
   * @param key The idempotency key.
   * @returns The record, or `null` when none exists.
   */
  findByIdempotencyKey(tenantId: string, key: string): Promise<UsageRecord | null> {
    return this.store.findByIdempotencyKey(tenantId, key)
  }

  /**
   * Query records. When the filter omits `status`, it defaults to the
   * balance-contributing statuses (`posted`, `reversed`) so callers see settled
   * spend without special-casing (§8.3).
   *
   * @param filter The ledger query filter.
   * @returns The matching records.
   */
  query(filter: LedgerFilter): Promise<UsageRecord[]> {
    return this.store.query(this.withBalanceStatuses(filter))
  }

  /**
   * Aggregate cost/token totals. Defaults to `posted` + `reversed` records, so a
   * reversed record and its compensating negation net to zero (§8.3).
   *
   * @param filter The ledger query filter.
   * @returns The aggregate cost/token summary.
   */
  sumCost(filter: LedgerFilter): Promise<LedgerCostSummary> {
    return this.store.sumCost(this.withBalanceStatuses(filter))
  }

  /** Default the status filter to the balance-contributing statuses when unset. */
  private withBalanceStatuses(filter: LedgerFilter): LedgerFilter {
    return filter.status === undefined ? { ...filter, status: [...BALANCE_STATUSES] } : filter
  }

  /**
   * Move a record between lifecycle states (§8.3). Only three transitions are
   * legal — `pending → posted` (settlement, amounts patched), `pending → released`
   * (void, no amount patch), and `posted → reversed` (annotation with
   * `reversedByRecordId` only). An illegal `(from, to)` pair or an out-of-contract
   * patch is a caller bug and throws `AI_TOKENS_IDEMPOTENCY_CONFLICT`. A legal
   * transition whose record is NOT currently in `from` returns `null` — the atomic
   * claim that lets exactly one reaper replica win an expired hold (§8.3).
   *
   * @param id The record id.
   * @param from The required current status.
   * @param to The target status.
   * @param patch The fields to set alongside the status flip.
   * @returns The updated record, or `null` on a from-state mismatch.
   * @throws {AiTokensException} `AI_TOKENS_IDEMPOTENCY_CONFLICT` on an illegal transition/patch.
   */
  async transition(
    id: string,
    from: UsageStatus,
    to: UsageStatus,
    patch?: Partial<UsageRecord>,
  ): Promise<UsageRecord | null> {
    this.assertLegalTransition(from, to, patch)
    return this.store.transition(id, from, to, patch)
  }

  /**
   * Reverse a posted record with a compensating record (§8.5, ledger-only steps
   * 1–2). Appends a `posted` record that exactly negates the original's token
   * counts and costs (keyed `reverse:<id>`, so a retry is a clean replay), then
   * annotates the original `posted → reversed`. Reversing a `pending`/`released`
   * or already-`reversed` record is invalid and throws
   * `AI_TOKENS_IDEMPOTENCY_CONFLICT`.
   *
   * ADMIN PLANE: reversal is a privileged mutation — the host MUST restrict it to
   * privileged roles (§14.4). This ledger-only primitive does NOT touch wallets,
   * budgets, counters, or events, and does not persist `reason` (the immutable
   * record has no reason column); the orchestrating `MeteringService.reverse`
   * surfaces `reason` on the `ai_tokens.usage.reversed` event.
   *
   * @param recordId The id of the posted record to reverse.
   * @param reason The caller's stated reason (echoed in the conflict details when the record cannot be reversed).
   * @returns The compensating record.
   * @throws {AiTokensException} `AI_TOKENS_IDEMPOTENCY_CONFLICT` when the record is missing or not `posted`.
   */
  async reverse(recordId: string, reason: string): Promise<UsageRecord> {
    const original = await this.store.findById(recordId)
    if (original?.status !== 'posted') {
      throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
        reason: original === null ? 'record not found' : `cannot reverse a ${original.status} record`,
        recordId,
        requestedReason: reason,
      })
    }
    const compensating = await this.append(buildCompensatingRecord(original), `reverse:${recordId}`)
    await this.transition(original.id, 'posted', 'reversed', { reversedByRecordId: compensating.id })
    return compensating
  }

  /** Enforce the legality table and per-transition patch contract (§8.3/§8.5). */
  private assertLegalTransition(from: UsageStatus, to: UsageStatus, patch?: Partial<UsageRecord>): void {
    if (from === 'pending' && to === 'posted') return
    if (from === 'pending' && to === 'released') {
      this.assertNoAmountPatch(patch, `${from} → ${to}`)
      return
    }
    if (from === 'posted' && to === 'reversed') {
      this.assertOnlyKeys(patch, 'reversedByRecordId', `${from} → ${to}`)
      return
    }
    throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
      reason: `illegal transition ${from} → ${to}`,
    })
  }

  /** Reject a patch that mutates any amount field. */
  private assertNoAmountPatch(patch: Partial<UsageRecord> | undefined, label: string): void {
    if (patch === undefined) return
    for (const field of AMOUNT_FIELDS) {
      if (field in patch) {
        throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
          reason: `${label} may not patch amount fields`,
        })
      }
    }
  }

  /** Reject a patch that sets any key other than the single allowed annotation key. */
  private assertOnlyKeys(patch: Partial<UsageRecord> | undefined, allowed: keyof UsageRecord, label: string): void {
    if (patch === undefined) return
    for (const key of Object.keys(patch)) {
      if (key !== allowed) {
        throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
          reason: `${label} may only annotate ${allowed}`,
        })
      }
    }
  }
}

/** Negate a record-unit map (compensating records carry negated non-token counts). */
function negateUnits(units: Record<string, number>): Record<string, number> {
  const negated: Record<string, number> = {}
  for (const [unit, count] of Object.entries(units)) negated[unit] = -count
  return negated
}

/** Build the compensating append input that exactly negates `original` (§8.5). */
function buildCompensatingRecord(original: UsageRecord): LedgerAppendInput {
  return {
    tenantId: original.tenantId,
    scope: original.scope,
    ...(original.beneficiary !== undefined ? { beneficiary: original.beneficiary } : {}),
    ...(original.requestedBy !== undefined ? { requestedBy: original.requestedBy } : {}),
    provider: original.provider,
    model: original.model,
    ...(original.requestedModel !== undefined ? { requestedModel: original.requestedModel } : {}),
    operation: original.operation,
    serviceTier: original.serviceTier,
    feature: original.feature,
    tags: original.tags,
    inputTokens: -original.inputTokens,
    outputTokens: -original.outputTokens,
    cacheReadTokens: -original.cacheReadTokens,
    cacheWrite5mTokens: -original.cacheWrite5mTokens,
    cacheWrite1hTokens: -original.cacheWrite1hTokens,
    reasoningTokens: -original.reasoningTokens,
    audioInTokens: -original.audioInTokens,
    audioOutTokens: -original.audioOutTokens,
    imageInTokens: -original.imageInTokens,
    imageOutTokens: -original.imageOutTokens,
    ...(original.extraUnits !== undefined ? { extraUnits: negateUnits(original.extraUnits) } : {}),
    priceVersionId: original.priceVersionId,
    rawCostNanoUsd: -original.rawCostNanoUsd,
    surchargeNanoUsd: -original.surchargeNanoUsd,
    billedCostNanoUsd: -original.billedCostNanoUsd,
    markupMultiplier: original.markupMultiplier,
    currency: original.currency,
    priceMissing: original.priceMissing,
    status: 'posted',
    reversesRecordId: original.id,
    ...(original.correlationId !== undefined ? { correlationId: original.correlationId } : {}),
    ...(original.requestId !== undefined ? { requestId: original.requestId } : {}),
    isSystemCost: original.isSystemCost,
    ...(original.systemCostCategory !== undefined ? { systemCostCategory: original.systemCostCategory } : {}),
    enforced: original.enforced,
    occurredAt: original.occurredAt,
  }
}
