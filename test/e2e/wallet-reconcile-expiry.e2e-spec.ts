/**
 * @fileoverview E2E: a reconcile after a grant's expiry writes the expiry entry itself, so a later debit finds
 * nothing left to expire and the balance is not reduced twice. Against real PostgreSQL, with instants the
 * database does not share, so no waiting is involved.
 * @layer test
 */

import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { debitEntry, grantEntry } from '../contracts/wallet-store.contract'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture

beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)

afterAll(async () => {
  await pg.stop()
})

describe('wallet reconcile after a grant expired', () => {
  const ref: WalletRef = { tenantId: 'reconcile-expiry', ownerType: 'user', ownerId: 'u1' }

  /** Grant, expiry, reconcile, debit attempt: the balance stays 0 with exactly one expiry entry, and a second reconcile adds none. */
  it('leaves the balance at zero through a later debit, with one expiry entry', async () => {
    const lapsed = new Date(Date.now() + 120_000)
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n, effectiveAt: new Date(Date.now() - 1_000), expiresAt: new Date(Date.now() + 60_000) }))
    expect((await pg.store.reconcile(ref, lapsed)).balanceNanoUsd).toBe(0n)
    expect((await pg.store.reconcile(ref, lapsed)).balanceNanoUsd).toBe(0n)
    expect(await pg.store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: 'd' }), 0n, lapsed)).toBeNull()
    expect((await pg.store.getWallet(ref))?.balanceNanoUsd).toBe(0n)
    expect((await pg.store.listEntries(ref, { type: 'expiry' })).total).toBe(1)
  })
})
