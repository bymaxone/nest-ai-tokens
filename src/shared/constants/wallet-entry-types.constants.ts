/**
 * @fileoverview Catalog of wallet entry kinds. Balances are the signed sum of
 * these append-only entries (see spec §9.1).
 * @layer shared
 */

/** Every kind of entry that can appear in a wallet's append-only ledger. */
export const WALLET_ENTRY_TYPES = ['grant', 'debit', 'refund', 'adjustment', 'expiry'] as const

/** A wallet entry kind. */
export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number]
