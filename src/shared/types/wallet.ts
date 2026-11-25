/**
 * @fileoverview Wallet types: the owner reference, the materialized wallet, and
 * the append-only entry ledger whose signed sum is the balance (see spec §9.1).
 * @layer shared
 */

import type { WalletEntryType } from '../constants/wallet-entry-types.constants'

/**
 * Identifies the owner of a wallet. `'key'` scopes deliberately cannot own money
 * — API keys spend their owner's wallet.
 */
export interface WalletRef {
  tenantId: string
  ownerType: 'tenant' | 'team' | 'user'
  ownerId: string
}

/** A prepaid credit wallet with a materialized nano-USD balance. */
export interface Wallet {
  id: string
  tenantId: string
  ownerType: WalletRef['ownerType']
  ownerId: string
  /** Materialized, kept transactionally consistent with Σ entries. */
  balanceNanoUsd: bigint
  createdAt: Date
  updatedAt: Date
}

/** One append-only entry in a wallet's ledger. */
export interface WalletEntry {
  id: string
  walletId: string
  type: WalletEntryType
  /** `+` = credit, `−` = debit. */
  amountNanoUsd: bigint
  /** Grant burn priority (lower first). */
  priority: number
  effectiveAt: Date
  /** Grants only. */
  expiresAt?: Date
  /** Present on usage-driven debits/refunds. */
  usageRecordId?: string
  /** Unique per wallet. */
  idempotencyKey: string
  reason?: string
  createdAt: Date
  /** Position in the wallet's own commit order, assigned under the wallet lock; absent on an entry written before the sequence existed. */
  seq?: bigint
  /** The wallet balance right after this entry, written with it; absent when the writer recorded no running balance. */
  balanceAfterNanoUsd?: bigint
  /** On a refund that restored a debit's grants: the debit it refunds. */
  refundsEntryId?: string
}

/** Caller-supplied fields for `IWalletStore.appendEntry`. The store assigns `id`/`createdAt`. */
export type NewWalletEntry = Omit<WalletEntry, 'id' | 'createdAt' | 'seq' | 'balanceAfterNanoUsd'>
