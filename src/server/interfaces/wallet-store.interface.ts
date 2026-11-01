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

/** The prepaid wallet port. */
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
   * Atomic conditional debit against the materialized balance. `null` = insufficient (§9.4). On the
   * store's own clock it first credits, once each, the grants that have fallen due and were not
   * credited as they were appended (an `adjustment` entry keyed `activate:<grantId>`), then expires
   * the credited grants that have lapsed, then reserves and allocates.
   */
  conditionalDebit(ref: WalletRef, entry: NewWalletEntry, overdraftNanoUsd: bigint): Promise<WalletEntry | null>
  /** Credited, effective, unexpired grants with remaining value, ordered per `order` — feeds allocation. */
  openGrants(ref: WalletRef, order: 'expiry' | 'priority' | 'fifo'): Promise<OpenGrant[]>
  /** A page of entries for a ref. */
  listEntries(ref: WalletRef, filter?: WalletEntryFilter): Promise<WalletEntryPage>
  /** Credit due grants as a debit does, then recompute the materialized balance from Σ entries. */
  reconcile(ref: WalletRef): Promise<Wallet>
}
