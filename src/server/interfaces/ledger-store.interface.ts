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

/**
 * What a transition or an append owes the settlement sweep: the effects of the write have not run yet. A store that
 * supports it records the time of the write and, for a capture, the reserved amount and token count, which the
 * transition overwrites and the outstanding deltas need. The marker is cleared once the effects have run.
 */
export interface OwedEffectsMarker {
  /** The billed amount the hold reserved, kept by a capture because the settled row carries the actuals. */
  reservedBilledNanoUsd?: bigint
  /** The tokens the hold reserved, kept by a capture for the same reason. */
  reservedTokens?: number
  /** The caller's reason for a reversal, kept so that the sweep refunds with the payload the inline refund sent. */
  reason?: string
}

/** A row whose effects are still owed, with the values its marker kept. */
export interface OwedEffects {
  /** The row the effects belong to: a settled hold, a released hold or the compensating record of a reversal. */
  record: UsageRecord
  /** The reserved billed amount, present for a capture. */
  reservedBilledNanoUsd?: bigint
  /** The reserved token count, present for a capture. */
  reservedTokens?: number
  /** The caller's reason, present for a reversal. */
  reason?: string
}

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
  append(record: NewUsageRecord, payloadHash: string, hashChain?: boolean, owed?: OwedEffectsMarker): Promise<UsageRecord>
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
    owed?: OwedEffectsMarker,
  ): Promise<UsageRecord | null>
  /** Look up a record by its per-tenant idempotency key. */
  findByIdempotencyKey(tenantId: string, key: string): Promise<UsageRecord | null>
  /**
   * Load one record by its global id — the reversal path loads the original to
   * negate it into a compensating record (§8.5). Returns `null` when absent.
   */
  findById(id: string): Promise<UsageRecord | null>
  /**
   * OPTIONAL: rows whose marker was written before `olderThan` and not yet cleared, oldest first. A store that omits
   * it, or {@link ILedgerStore.clearEffectsOwed}, leaves the owed-effects sweep inactive.
   */
  findEffectsOwed?(olderThan: Date, limit: number): Promise<OwedEffects[]>
  /**
   * OPTIONAL: the marker of one row with what it kept, or `null` when the row owes nothing. A reversal reads it to
   * settle the original's capture legs before it reverses.
   */
  findEffectsOwedFor?(id: string): Promise<OwedEffects | null>
  /**
   * OPTIONAL: clear the marker of a row once its effects have run. Idempotent; `false` when the row has none.
   */
  clearEffectsOwed?(id: string): Promise<boolean>
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
