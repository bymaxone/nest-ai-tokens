/**
 * @fileoverview E2E scenario 9 (spec §19.2, §9.3): two grants with different
 * expiries — a debit allocates against the soonest-expiring grant first, and the
 * open-grant remainders reflect the burn-down. Against real PostgreSQL.
 * @layer test
 */

import { E2E_WALLET, bootMeteringModule, grantWallet, startPostgres, type Booted, type PostgresFixture } from './harness'

let pg: PostgresFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  app = await bootMeteringModule({ store: pg.store })
}, 180_000)

afterAll(async () => {
  await app.close()
  await pg.stop()
})

describe('E2E — wallet grant burn-down (§9.3)', () => {
  /** A debit spanning two grants burns the soonest-expiring first. */
  it('allocates a debit to the soonest-expiring grant first', async () => {
    await grantWallet(app.wallets, 30_000_000n, { idempotencyKey: 'soon', expiresAt: new Date('2027-01-01T00:00:00.000Z') })
    await grantWallet(app.wallets, 30_000_000n, { idempotencyKey: 'late', expiresAt: new Date('2030-01-01T00:00:00.000Z') })
    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(60_000_000n)

    await app.wallets.debit(E2E_WALLET, { amountNanoUsd: 40_000_000n, idempotencyKey: 'span', reason: 'e2e span debit' })
    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(20_000_000n)

    // The soonest-expiring grant is fully consumed; only the later grant retains a remainder.
    const open = await pg.store.openGrants(E2E_WALLET, 'expiry')
    const remainingByKey = new Map(open.map((grant) => [grant.idempotencyKey, grant.remainingNanoUsd]))
    expect(remainingByKey.get('soon') ?? 0n).toBe(0n)
    expect(remainingByKey.get('late')).toBe(20_000_000n)
  })
})
