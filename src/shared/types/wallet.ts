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
}

/** Caller-supplied fields for `IWalletStore.appendEntry`. The store assigns `id`/`createdAt`. */
export type NewWalletEntry = Omit<WalletEntry, 'id' | 'createdAt'>
