/**
 * @fileoverview E2E on PostgreSQL 16: the give-back of a wallet debit no ledger row stands behind. A keyed hold whose
 * append failed keeps its debit; two instances sweeping at once claim the key once and refund once; the claim row is the
 * wallet's tenant's, never shows in another tenant's ledger or in a usage summary, and refuses a late retry of the key.
 * The cross-wallet listing runs against the real wallet tables, so the prefix match, the bounds and the keyset are those
 * of the database.
 * @layer test
 */

import type { HoldEstimate } from '@bymax-one/nest-ai-tokens'
import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { OrphanDebitSweeper } from '../../src/server/enforcement/orphan-debit-sweeper'
import { isIdempotencyConflict } from '../../src/server/services/record-replay'
import {
  E2E_WALLET,
  bootMeteringModule,
  e2eContext,
  e2eUsage,
  grantWallet,
  seedPrice,
  startPostgres,
  type Booted,
  type PostgresFixture,
} from './harness'

const ESTIMATE: HoldEstimate = {
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
  inputTokens: 1000,
  maxOutputTokens: 500,
}
const GRANT = 100_000_000n
const GRACE = 300
const RETENTION = 604_800
/** A window that holds every row the suite writes. */
const WINDOW = { from: new Date(0), to: new Date('2100-01-01T00:00:00.000Z') }
const OTHER: WalletRef = { tenantId: 'e2e-2', ownerType: 'user', ownerId: 'u1' }

let pg: PostgresFixture
let a: Booted
let b: Booted

beforeAll(async () => {
  pg = await startPostgres()
  a = await bootMeteringModule({ store: pg.store })
  b = await bootMeteringModule({ store: pg.storeB })
  await seedPrice(a.pricing)
  await grantWallet(a.wallets, GRANT)
  await a.wallets.grant(OTHER, {
    amountNanoUsd: GRANT,
    effectiveAt: new Date(0),
    idempotencyKey: 'grant-other',
    reason: 'e2e seed',
  })
}, 180_000)

afterAll(async () => {
  await a.close()
  await b.close()
  await pg.stop()
})

/** A sweeper on the clock `later` seconds from now, so the debits made now are older than the grace. */
function sweeper(app: Booted, store: PostgresFixture['store'], later: number): OrphanDebitSweeper {
  return new OrphanDebitSweeper(
    store,
    app.ledger,
    { graceSeconds: GRACE, retentionSeconds: RETENTION },
    () => new Date(Date.now() + later * 1_000),
    (owed) => app.metering.settleOwedEffects(owed),
  )
}

/** A keyed hold whose ledger append failed with no row: its debit stays. */
async function orphan(app: Booted, key: string, tenantId = 'e2e'): Promise<void> {
  const spy = jest.spyOn(pg.store, 'append').mockRejectedValueOnce(new Error('connection reset'))
  await expect(
    app.metering.hold(e2eContext({ idempotencyKey: key, tenantId }), ESTIMATE),
  ).rejects.toThrow('connection reset')
  spy.mockRestore()
}

async function refundsOf(ref: WalletRef): Promise<number> {
  return (await pg.store.listEntries(ref, { type: 'refund' })).entries.length
}

describe('the give-back of an orphan debit in PostgreSQL', () => {
  /** Two instances sweeping at once refund the orphan once; the wallet is whole and the key is claimed by a released row. */
  it('refunds once when two instances sweep at the same time, and refuses a retry of the key', async () => {
    await orphan(a, 'orphan-1')
    expect((await a.wallets.getBalance(E2E_WALLET)).nanoUsd < GRANT).toBe(true)
    await Promise.all([
      sweeper(a, pg.store, GRACE + 5).sweep(),
      sweeper(b, pg.storeB, GRACE + 5).sweep(),
    ])
    expect((await a.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(GRANT)
    expect(await refundsOf(E2E_WALLET)).toBe(1)
    const claim = await pg.store.findByIdempotencyKey('e2e', 'orphan-1')
    expect(claim?.status).toBe('released')
    expect(await pg.store.findEffectsOwedFor?.(claim?.id ?? '')).toBeNull()
    let refused = false
    try {
      await b.metering.hold(e2eContext({ idempotencyKey: 'orphan-1' }), ESTIMATE)
    } catch (error) {
      refused = isIdempotencyConflict(error)
    }
    expect(refused).toBe(true)
    expect((await a.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(GRANT)
  })

  /** The claim belongs to the wallet's tenant: the other tenant's ledger and usage summary never show it. */
  it('claims in the tenant of the wallet and leaves another tenant and the summaries alone', async () => {
    await a.metering.record({
      usage: e2eUsage(),
      context: e2eContext({ idempotencyKey: 'settled-1' }),
    })
    const before = await a.report.summarize({ ...WINDOW, tenantId: 'e2e', groupBy: [] })
    await orphan(a, 'orphan-2', 'e2e-2')
    await sweeper(a, pg.store, GRACE + 5).sweep()
    expect((await a.wallets.getBalance(OTHER)).nanoUsd).toBe(GRANT)
    expect((await pg.store.findByIdempotencyKey('e2e-2', 'orphan-2'))?.tenantId).toBe('e2e-2')
    expect(await pg.store.findByIdempotencyKey('e2e', 'orphan-2')).toBeNull()
    expect(before).toHaveLength(1)
    expect(await a.report.summarize({ ...WINDOW, tenantId: 'e2e', groupBy: [] })).toEqual(before)
    expect(await a.report.summarize({ ...WINDOW, tenantId: 'e2e-2', groupBy: [] })).toEqual([])
  })

  /** A debit younger than the grace and a debit whose row stands are left alone. */
  it('leaves a young debit and a debit with a row alone', async () => {
    await a.metering.hold(e2eContext({ idempotencyKey: 'live-1' }), ESTIMATE)
    const held = GRANT - (await a.wallets.getBalance(E2E_WALLET)).nanoUsd
    await sweeper(a, pg.store, GRACE + 5).sweep()
    expect(GRANT - (await a.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(held)
    await orphan(a, 'young-1')
    const afterYoung = (await a.wallets.getBalance(E2E_WALLET)).nanoUsd
    await sweeper(a, pg.store, 5).sweep()
    expect((await a.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(afterYoung)
  })
})
