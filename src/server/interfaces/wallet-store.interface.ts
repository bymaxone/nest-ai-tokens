/**
 * @fileoverview The wallet persistence port (spec §15.1). Materialized-balance
 * wallets with atomic conditional debit, grant allocation, and reconciliation.
 * Only validated at init when the wallet feature is enabled.
 * @layer server
 */

import type { NewWalletEntry, Wallet, WalletEntry, WalletEntryType, WalletRef } from '../../shared'

/** An open grant with its remaining spendable value. */
export type OpenGrant = WalletEntry & { remainingNanoUsd: bigint }

/** A page of wallet entries with the total count. */
export interface WalletEntryPage {
  entries: WalletEntry[]
  total: number
}

/** A debit with the wallet it was written to. */
export interface WalletDebit {
  ref: WalletRef
  entry: WalletEntry
}

/** Where a page of {@link IWalletStore.findDebitsBefore} stops: the last debit it returned. */
export interface WalletDebitCursor {
  createdAt: Date
  id: string
}

/** A page of {@link IWalletStore.findDebitsBefore}. */
export interface WalletDebitQuery {
  /** Only debits whose idempotency key starts with one of these. */
  keyPrefixes: string[]
  /** Only debits created strictly before this instant. */
  olderThan: Date
  /** Only debits created at or after this instant, when given. */
  newerThan?: Date
  /** The most debits to return. */
  limit: number
  /** Continue after this debit of the same ordering; the first page when absent. */
  after?: WalletDebitCursor
}

/** Filter for {@link IWalletStore.listEntries}. */
export interface WalletEntryFilter {
  from?: Date
  to?: Date
  type?: WalletEntryType
  limit?: number
  offset?: number
  /** `'asc'` (default) lists oldest first in the wallet's commit order; `'desc'` is its exact reverse. */
  order?: 'asc' | 'desc'
}

/** One grant that still holds value, as the breakdown of a balance lists it. */
export interface WalletBucket {
  grantEntryId: string
  remainingNanoUsd: bigint
  priority: number
  expiresAt?: Date
  reason?: string
}

/** What a debit at `asOf` could spend without overdraft, split by grant; `unallocatedNanoUsd` is the part no grant holds (may be negative). */
export interface WalletBalanceBreakdown {
  asOf: Date
  nanoUsd: bigint
  unallocatedNanoUsd: bigint
  buckets: WalletBucket[]
}

/** Input of {@link IWalletStore.refundToSource}: the refund entry (a positive `refund`) and the debit whose grants it restores. */
export interface RefundToSourceInput {
  entry: NewWalletEntry
  /** The debit to restore; when absent the store finds the single debit of the wallet with the entry's `usageRecordId`. */
  debitEntryId?: string
  /** The caller's clock: a grant whose `expiresAt` is at or before it counts as expired. */
  now: Date
}

/**
 * The prepaid wallet port.
 *
 * Every method that judges a grant's `effectiveAt` or `expiresAt` takes the instant `now` on the caller's clock,
 * the one the service stamps `effectiveAt` from. An entry's `createdAt` stays the store's own clock: it orders the
 * entries, so one clock must stamp them all. A store that compares
 * against a clock of its own, such as a database server's, MUST use the `now` it is given and fall back to its
 * own clock only when none is given: two clocks that disagree make a grant spendable on one and lapsed on the other.
 */
export interface IWalletStore {
  /** The wallet for a ref, or `null` when it does not exist yet. */
  getWallet(ref: WalletRef): Promise<Wallet | null>
  /**
   * Create the wallet when missing (idempotent) and append the entry plus any
   * grant allocations in one transaction.
   */
  appendEntry(
    ref: WalletRef,
    entry: NewWalletEntry,
    allocations?: { grantEntryId: string; amountNanoUsd: bigint }[],
  ): Promise<WalletEntry>
  /**
   * Atomic conditional debit against the materialized balance. `null` = insufficient (§9.4). Judged at `now`, it first credits, once each, the
   * grants that have fallen due and were not credited as they were appended (an `adjustment` entry keyed `activate:<grantId>`), then expires
   * the credited grants that have lapsed, then reserves and allocates.
   */
  conditionalDebit(ref: WalletRef, entry: NewWalletEntry, overdraftNanoUsd: bigint, now?: Date): Promise<WalletEntry | null>
  /** Credited grants that are effective and unexpired at `now`, with remaining value, ordered per `order` — feeds allocation. */
  openGrants(ref: WalletRef, order: 'expiry' | 'priority' | 'fifo', now?: Date): Promise<OpenGrant[]>
  /** A page of entries for a ref. */
  listEntries(ref: WalletRef, filter?: WalletEntryFilter): Promise<WalletEntryPage>
  /**
   * Optional. Debits of any wallet of any tenant whose key starts with one of the prefixes, created inside the bounds, ordered
   * by `(createdAt, id)` ascending and paged by `after`, each with the wallet it belongs to. A store without it leaves the sweep
   * of debits that no ledger row stands behind inactive.
   */
  findDebitsBefore?(query: WalletDebitQuery): Promise<WalletDebit[]>
  /**
   * Optional. Refund a debit into the grants it burned, in one transaction under the wallet lock: one `refund` entry (+r) and negative
   * allocation rows on those grants, so their remaining rises and nothing posted is updated. See `WalletService.refund` (`restore: 'source'`).
   * A store without it makes the service refuse `restore: 'source'`; it never falls back to an unallocated refund.
   */
  refundToSource?(ref: WalletRef, input: RefundToSourceInput): Promise<WalletEntry>
  /** Optional. What a debit at `asOf` could spend, as the single answer {@link IWalletStore.conditionalDebit} would judge. */
  balanceAt?(ref: WalletRef, asOf: Date): Promise<bigint>
  /** Optional. {@link IWalletStore.balanceAt} split by grant, from one snapshot. */
  balanceBreakdown?(ref: WalletRef, asOf: Date): Promise<WalletBalanceBreakdown>
  /** Credit due grants and expire lapsed ones as a debit does, then recompute the materialized balance from Σ entries. */
  reconcile(ref: WalletRef, now?: Date): Promise<Wallet>
}
