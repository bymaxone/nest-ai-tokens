/**
 * @fileoverview The ledger persistence port (spec §15.1). The append-only usage
 * ledger: idempotent append, atomic state transitions, and aggregate queries.
 * Implemented by the official Prisma adapter or a custom store.
 * @layer server
 */

import type { LedgerFilter, NewUsageRecord, UsageRecord, UsageStatus } from '../../shared'

/** Aggregate cost totals returned by {@link ILedgerStore.sumCost}. */
export interface LedgerCostSummary {
  rawCostNanoUsd: bigint
  billedCostNanoUsd: bigint
  surchargeNanoUsd: bigint
  totalTokens: number
  records: number
}

/** The append-only usage ledger port. */
export interface ILedgerStore {
  /**
   * Upsert on `(tenantId, idempotencyKey)` — a replay returns the existing record
   * iff the payload hash matches; a different hash is a conflict (§8.4).
   */
  append(record: NewUsageRecord, payloadHash: string): Promise<UsageRecord>
  /**
   * State transitions only (§8.3): `pending→posted` (settle, amounts patched),
   * `pending→released`, `posted→reversed` (annotation only — amount fields
   * rejected). Atomic: returns `null` when the record was not in the expected
   * source state (how exactly one reaper replica wins an expired hold).
   */
  transition(
    id: string,
    from: UsageStatus,
    to: UsageStatus,
    patch?: Partial<UsageRecord>,
  ): Promise<UsageRecord | null>
  /** Look up a record by its per-tenant idempotency key. */
  findByIdempotencyKey(tenantId: string, key: string): Promise<UsageRecord | null>
  /**
   * Load one record by its global id — the reversal path loads the original to
   * negate it into a compensating record (§8.5). Returns `null` when absent.
   */
  findById(id: string): Promise<UsageRecord | null>
  /** Find pending holds older than `olderThan` for the reaper sweep. */
  findExpiredHolds(olderThan: Date, limit: number): Promise<UsageRecord[]>
  /** Query records by filter. */
  query(filter: LedgerFilter): Promise<UsageRecord[]>
  /** Aggregate cost/token totals for a filter. */
  sumCost(filter: LedgerFilter): Promise<LedgerCostSummary>
  /** The last posted record's hash for a tenant (hash-chain continuation). */
  lastHash(tenantId: string): Promise<string | null>
}
