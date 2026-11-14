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

/** Filter for {@link IWalletStore.listEntries}. */
export interface WalletEntryFilter {
  from?: Date
  to?: Date
  type?: WalletEntryType
  limit?: number
  offset?: number
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
  /** Credit due grants as a debit does, then recompute the materialized balance from Σ entries. */
  reconcile(ref: WalletRef, now?: Date): Promise<Wallet>
}
