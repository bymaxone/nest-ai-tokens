/**
 * @fileoverview A reconcile after a grant's expiry writes the expiry entry itself, so a later debit finds nothing
 * left to expire and the balance is never reduced twice for the same remainder.
 * @layer test
 */

import type { WalletRef } from '../../shared'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { debitEntry, grantEntry } from '../../../test/contracts/wallet-store.contract'

const REF: WalletRef = { tenantId: 't1', ownerType: 'user', ownerId: 'u1' }
const START = new Date('2030-01-01T00:00:00.000Z')
const LAPSED = new Date(START.getTime() + 5_000)

describe('reconcile after a grant expired', () => {
  /*
   * Invariant: grant, expiry, reconcile, then a debit attempt leaves the balance at 0 with exactly one expiry
   * entry; two reconciles in a row write no second expiry.
   */
  it('writes one expiry entry and leaves the balance at zero through a later debit', async () => {
    const store = new InMemoryWalletStore({ now: () => START })
    await store.appendEntry(REF, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n, effectiveAt: START, expiresAt: new Date(START.getTime() + 1_000) }))
    expect((await store.reconcile(REF, LAPSED)).balanceNanoUsd).toBe(0n)
    expect((await store.reconcile(REF, LAPSED)).balanceNanoUsd).toBe(0n)
    expect(await store.conditionalDebit(REF, debitEntry(1n, { idempotencyKey: 'd' }), 0n, LAPSED)).toBeNull()
    expect((await store.getWallet(REF))?.balanceNanoUsd).toBe(0n)
    expect(store.entriesOf(REF).filter((entry) => entry.type === 'expiry')).toHaveLength(1)
  })
})
