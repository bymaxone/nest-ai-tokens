/**
 * @fileoverview The ledger persistence port (spec §15.1). The append-only usage
 * ledger: idempotent append, atomic state transitions, and aggregate queries.
 * Implemented by the official Prisma adapter or a custom store.
 * @layer server
 */

import type { LedgerFilter, NewUsageRecord, UsageRecord, UsageStatus, UsageSummary } from '../../shared'

/** Aggregate cost totals returned by {@link ILedgerStore.sumCost}. */
export interface LedgerCostSummary {
  rawCostNanoUsd: bigint
  billedCostNanoUsd: bigint
  surchargeNanoUsd: bigint
  totalTokens: number
  records: number
}

/** A report group-by dimension (spec §13.1). */
export type ReportGroupBy =
  | 'day'
  | 'week'
  | 'month'
  | 'feature'
  | 'provider'
  | 'model'
  | 'operation'
  | 'serviceTier'
  | 'scope'
  | 'beneficiary'
  | 'tag'
  | 'systemCostCategory'

/** The append-only usage ledger port. */
export interface ILedgerStore {
  /**
   * Upsert on `(tenantId, idempotencyKey)` — a replay returns the existing record
   * iff the payload hash matches; a different hash is a conflict (§8.4). When
   * `hashChain` is true and the record is `posted`, the store reads the tenant's
   * last chain hash, computes this record's `prevHash`/`hash`, and persists them
   * ATOMICALLY under a per-tenant lock (§8.6) — the read-compute-write is one
   * serialized operation so concurrent appends never fork the chain. When false
   * (the default), no chain lookup or hashing occurs.
   */
  append(record: NewUsageRecord, payloadHash: string, hashChain?: boolean): Promise<UsageRecord>
  /**
   * State transitions only (§8.3): `pending→posted` (settle, amounts patched),
   * `pending→released`, `posted→reversed` (annotation only — amount fields
   * rejected). Atomic: returns `null` when the record was not in the expected
   * source state (how exactly one reaper replica wins an expired hold). When
   * `hashChain` is true and `to` is `posted` (settlement), the store computes and
   * persists the record's chain `prevHash`/`hash` under the same per-tenant lock (§8.6).
   */
  transition(
    id: string,
    from: UsageStatus,
    to: UsageStatus,
    patch?: Partial<UsageRecord>,
    hashChain?: boolean,
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
  /**
   * OPTIONAL scalable aggregation (spec §13.1): `SUM … GROUP BY` across the report
   * dimensions, computed in the store (the official Prisma adapter uses SQL). A
   * store that omits it falls back to `UsageReportService`'s documented
   * query-and-aggregate-in-memory path, capped at `reporting.maxExportRows`.
   */
  summarize?(filter: LedgerFilter, groupBy: ReportGroupBy[]): Promise<UsageSummary[]>
  /**
   * The last posted record's hash for a tenant (hash-chain continuation, §8.6).
   * The chain is serialized per tenant: the official Prisma adapter takes a
   * Postgres advisory lock so the last-hash read and the chained append/settle run
   * as one atomic operation; an in-memory store simulates this with a per-tenant
   * mutex. Returns `null` before the tenant's first chained record.
   */
  lastHash(tenantId: string): Promise<string | null>
}
