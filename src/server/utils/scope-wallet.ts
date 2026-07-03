/**
 * @fileoverview Map a payer {@link MeteringScope} to the {@link WalletRef} that
 * owns its balance (spec §9.1). A `'key'` scope cannot own money — API keys spend
 * their owner's wallet, so the host is expected to resolve a key to its owning
 * subject BEFORE the metering call (via `scopeResolver`). This helper therefore
 * carries the scope type straight through; a `'key'` scope reaching the wallet
 * layer is a host configuration error that `WalletService` rejects at runtime.
 * @layer server
 */

import type { MeteringScope, WalletRef } from '../../shared'

/** True when a scope can own a wallet (`'key'` scopes cannot — §9.1). */
export function scopeOwnsWallet(scope: MeteringScope): boolean {
  return scope.type !== 'key'
}

/**
 * Build the {@link WalletRef} for a payer scope. The scope type maps directly to
 * the wallet owner type; a `'key'` scope produces a ref `WalletService` rejects.
 *
 * @param tenantId The owning tenant.
 * @param scope The payer scope.
 * @returns The wallet owner reference.
 */
export function scopeToWalletRef(tenantId: string, scope: MeteringScope): WalletRef {
  return { tenantId, ownerType: scope.type as WalletRef['ownerType'], ownerId: scope.id }
}
