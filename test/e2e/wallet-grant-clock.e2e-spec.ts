/**
 * @fileoverview E2E: a grant given no `effectiveAt` is spendable as it is appended whichever side of the database clock
 * the application clock is on. The service stamps the omitted instant from its own clock and the entry's `createdAt`
 * comes from the database, so the store keeps the earlier of the two. The skew is applied to the service's clock.
 * @layer test
 */

import { WalletService } from '@bymax-one/nest-ai-tokens'
import type { WalletEntry, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture
beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)
afterAll(async () => {
  await pg.stop()
})

let owners = 0

/** A wallet of its own for each row. */
function freshRef(): WalletRef {
  owners += 1
  return { tenantId: 'tenant-clock', ownerType: 'user', ownerId: `owner-${owners}` }
}

/** The service on an application clock `skewMs` away from this machine's, which the database container shares. */
function walletsAt(skewMs: number, burnOrder: 'expiry' | 'priority' | 'fifo' = 'expiry'): WalletService {
  const options = { enabled: true as const, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder }
  return new WalletService(pg.store, options, undefined, () => new Date(Date.now() + skewMs))
}

/** The wallet's entries in the order the store lists them. */
async function entriesOf(ref: WalletRef): Promise<WalletEntry[]> {
  return (await pg.store.listEntries(ref)).entries
}

describe.each([
  ['2 s ahead of', 2_000],
  ['2 s behind', -2_000],
  ['60 s ahead of', 60_000],
  ['60 s behind', -60_000],
])('an application clock %s the database', (_label, skew) => {
  /** The balance the entry carries and the stored one hold the grant, with no activation entry, and a debit spends it. */
  it('credits a grant with no effectiveAt as it is appended', async () => {
    const wallets = walletsAt(skew)
    const ref = freshRef()
    const entry = await wallets.grant(ref, { amountNanoUsd: 100n, idempotencyKey: 'g', reason: 'allowance' })
    expect(entry.balanceAfterNanoUsd).toBe(100n)
    expect(entry.effectiveAt.getTime()).toBeLessThanOrEqual(entry.createdAt.getTime())
    expect((await wallets.getBalance(ref)).nanoUsd).toBe(100n)
    await wallets.debit(ref, { amountNanoUsd: 40n, idempotencyKey: 'd', reason: 'use' })
    expect((await wallets.getBalance(ref)).nanoUsd).toBe(60n)
    expect((await wallets.reconcile(ref)).nanoUsd).toBe(60n)
    expect((await entriesOf(ref)).map((row) => row.type)).toEqual(['grant', 'debit'])
  })

  /** Grants appended at once keep their commit order, and each carries the running balance it left. */
  it('keeps the commit order and the running balance of concurrent grants', async () => {
    const wallets = walletsAt(skew, 'fifo')
    const ref = freshRef()
    await wallets.grant(ref, { amountNanoUsd: 1n, idempotencyKey: 'first', reason: 'allowance' })
    await Promise.all([1, 2, 3, 4, 5].map((n) => wallets.grant(ref, { amountNanoUsd: 10n, idempotencyKey: `g${n}`, reason: 'allowance' })))
    const rows = await entriesOf(ref)
    expect(rows.map((row) => row.seq)).toEqual([1n, 2n, 3n, 4n, 5n, 6n])
    expect(rows.map((row) => row.balanceAfterNanoUsd)).toEqual([1n, 11n, 21n, 31n, 41n, 51n])
    const open = await pg.store.openGrants(ref, 'fifo', new Date(Date.now() + skew))
    // Burn order follows `createdAt`, which is not the commit order of appends made at once; only membership is compared.
    expect(open.map((grant) => grant.id).sort()).toEqual(rows.map((row) => row.id).sort())
  })

  /** A replay of the key returns the entry it wrote. */
  it('replays the same grant for the same key', async () => {
    const wallets = walletsAt(skew)
    const ref = freshRef()
    const first = await wallets.grant(ref, { amountNanoUsd: 100n, idempotencyKey: 'g', reason: 'allowance' })
    const again = await wallets.grant(ref, { amountNanoUsd: 100n, idempotencyKey: 'g', reason: 'allowance' })
    expect(again.id).toBe(first.id)
    expect((await wallets.getBalance(ref)).nanoUsd).toBe(100n)
  })
})

describe('an effectiveAt the host gives', () => {
  /** A given instant is stored as given: one the database has not reached is credited at the next debit. */
  it('is stored unchanged', async () => {
    const wallets = walletsAt(2_000)
    const ref = freshRef()
    const effectiveAt = new Date(Date.now() + 2_000)
    const entry = await wallets.grant(ref, { amountNanoUsd: 100n, idempotencyKey: 'g', reason: 'allowance', effectiveAt })
    expect(entry.effectiveAt).toEqual(effectiveAt)
    expect(entry.balanceAfterNanoUsd).toBe(0n)
    await wallets.debit(ref, { amountNanoUsd: 40n, idempotencyKey: 'd', reason: 'use' })
    expect((await wallets.getBalance(ref)).nanoUsd).toBe(60n)
  })
})

describe('a store that takes no append options', () => {
  /** The extra argument changes nothing for a store that does not declare it: it keeps the instant the service sent. */
  it('stores the instant of the service clock', async () => {
    const append = pg.store.appendEntry.bind(pg.store)
    const store = Object.assign(Object.create(pg.store) as typeof pg.store, {
      appendEntry: (...[ref, entry, allocations]: Parameters<typeof append>) => append(ref, entry, allocations),
    })
    const options = { enabled: true as const, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' as const }
    const ahead = new Date(Date.now() + 60_000)
    const entry = await new WalletService(store, options, undefined, () => ahead).grant(freshRef(), { amountNanoUsd: 100n, idempotencyKey: 'g', reason: 'allowance' })
    expect(entry.effectiveAt).toEqual(ahead)
    expect(entry.balanceAfterNanoUsd).toBe(0n)
  })
})
