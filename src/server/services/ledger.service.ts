/**
 * @fileoverview `LedgerService` — the append-only usage ledger core over
 * `ILedgerStore` (spec §8). This task delivers exactly-once append (payload-hash
 * replay-or-conflict, §8.4), filtered queries, and cost aggregation. Balance and
 * spend math sums `posted` + `reversed` records only (§8.3), so those are the
 * default query statuses. The service NEVER issues an `UPDATE`/`DELETE` of a
 * posted amount — corrections are compensating records and the sole permitted
 * post-posting mutation is the annotation-only `posted → reversed` flip.
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
}
