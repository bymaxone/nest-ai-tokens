/**
 * @fileoverview `LedgerService` — the append-only usage ledger core over
 * `ILedgerStore` (spec §8): exactly-once append (payload-hash replay-or-conflict,
 * §8.4), filtered queries, cost aggregation, the lifecycle state machine
 * (`transition`, §8.3), the ledger-only compensation primitive (`reverse`, §8.5
 * steps 1–2), and the opt-in per-tenant tamper-evident hash chain (§8.6). Balance
 * and spend math sums `posted` + `reversed` records only (§8.3), so those are the
 * default query statuses. The service NEVER issues an `UPDATE`/`DELETE` of a posted
 * amount — corrections are compensating records (a `posted` row with negated
 * amounts) and the sole permitted post-posting mutation is the annotation-only
 * `posted → reversed` flip.
 * @layer server
 */

import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { isLegalLedgerTransition, isLegalTransitionPatchKey } from '../../shared'
import type { LedgerFilter, NewUsageRecord, UsageRecord, UsageStatus } from '../../shared'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import type { ILedgerStore, LedgerCostSummary } from '../interfaces'
import { chainHash, type ChainVerification } from '../utils/hash-chain'
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

/** The resolved-options subset the ledger consumes (the hash-chain flag, §8.6). */
export type LedgerServiceOptions = Pick<ResolvedAiTokensOptions, 'ledger'>

/**
 * Audit hook invoked by {@link LedgerService.verifyChain}. The module wires it to
 * the event dispatcher's `ai_tokens.audit` emission; it defaults to a no-op so the
 * service has no dependency cycle on the dispatcher.
 */
export type LedgerAuditHook = (action: string, details: Record<string, unknown>) => void

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
   * @param options The resolved options carrying the hash-chain flag (§8.6).
   * @param audit The audit hook for chain verification; wired by the module.
   */
  constructor(
    private readonly store: ILedgerStore,
    private readonly options: LedgerServiceOptions = { ledger: { hashChain: false } },
    private readonly audit: LedgerAuditHook = (): void => undefined,
  ) {}

  /** Whether the per-tenant tamper-evident hash chain is enabled (§8.6). */
  private get hashChainEnabled(): boolean {
    return this.options.ledger.hashChain
  }

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
      return await this.store.append(record, payloadHash, this.hashChainEnabled)
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
   * legal — `pending → posted` (settlement; only the settlement amount/cost fields
   * may be patched), `pending → released` (void, no amount patch), and
   * `posted → reversed` (annotation with `reversedByRecordId` only). An illegal
   * `(from, to)` pair or an out-of-contract patch — including any attempt to mutate
   * an immutable field such as `id`/`tenantId`/`idempotencyKey` — is a caller bug
   * and throws `AI_TOKENS_IDEMPOTENCY_CONFLICT`. A legal
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
    return this.store.transition(id, from, to, patch, this.hashChainEnabled)
  }

  /**
   * Verify a tenant's tamper-evident hash chain (§8.6). Walks its settled records
   * (`posted` + `reversed`) in append order and recomputes each record's chain hash
   * from its stored `prevHash` link, comparing it to the stored `hash`; reports the
   * first record whose hash does not match (a post-hoc content modification).
   * Recomputing from each record's own stored link makes verification independent
   * of walk order and of any `from`/`to` window (the first in-range record keeps
   * its real predecessor link). Always emits an `ai_tokens.audit` hook.
   *
   * @param tenantId The tenant whose chain to verify.
   * @param from Optional inclusive lower bound on `occurredAt`.
   * @param to Optional inclusive upper bound on `occurredAt`.
   * @returns `{ valid: true }`, or `{ valid: false, brokenAtRecordId }`.
   */
  async verifyChain(tenantId: string, from?: Date, to?: Date): Promise<ChainVerification> {
    const filter: LedgerFilter = { tenantId, status: ['posted', 'reversed'] }
    if (from !== undefined) filter.from = from
    if (to !== undefined) filter.to = to

    const settled = await this.store.query(filter)
    let result: ChainVerification = { valid: true }
    for (const record of settled) {
      if (record.hash !== chainHash(record.prevHash ?? null, record)) {
        result = { valid: false, brokenAtRecordId: record.id }
        break
      }
    }

    const details: Record<string, unknown> = { tenantId, valid: result.valid }
    if (!result.valid) details.brokenAtRecordId = result.brokenAtRecordId
    this.audit('ai_tokens.chain.verified', details)
    return result
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

  /**
   * Enforce the legality table and per-transition patch contract (§8.3/§8.5) via
   * the shared guard the store adapters also consume, so the service layer and the
   * store boundary can never drift. Store-agnostic: it runs before the store
   * applies the patch, so even a store that assigns patches broadly can never
   * mutate an immutable field (`id`/`tenantId`/`idempotencyKey`) or write an
   * out-of-contract column.
   */
  private assertLegalTransition(from: UsageStatus, to: UsageStatus, patch?: Partial<UsageRecord>): void {
    if (!isLegalLedgerTransition(from, to)) {
      throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
        reason: `illegal transition ${from} → ${to}`,
      })
    }
    if (patch === undefined) return
    for (const key of Object.keys(patch)) {
      if (!isLegalTransitionPatchKey(from, to, key)) {
        throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
          reason: `${from} → ${to} may not patch "${key}"`,
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
