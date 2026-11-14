/**
 * @fileoverview E2E: wallet crediting and expiry judge instants on one clock and in one time zone,
 * whatever zone the database session uses. The entry timestamps are `TIMESTAMP` columns without a
 * zone, so a value the application writes (a UTC instant) and a value the database defaults
 * (`CURRENT_TIMESTAMP` in the session zone) are only comparable if both are written in UTC. Each
 * case runs on a database whose session zone is set west of UTC, east of UTC, and UTC itself.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { debitEntry, grantEntry } from '../contracts/wallet-store.contract'
import { startPostgres, type PostgresFixture } from './harness'

const MIGRATION = join(__dirname, '../../src/prisma/migrations/0001_init.sql')
const ZONES = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo'] as const

let pg: PostgresFixture
const clients: PrismaClient[] = []
let databases = 0

beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)

afterAll(async () => {
  for (const client of clients) await client.$disconnect()
  await pg.stop()
})

/** Split the shipped migration into individual statements. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/** A store on a fresh database whose sessions use `zone`. */
async function storeInZone(zone: string): Promise<PrismaAiTokensStore> {
  databases += 1
  const name = `tz_${databases}_${zone.replace(/[^a-z]/gi, '_').toLowerCase()}`
  await pg.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  await pg.prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" SET timezone TO '${zone}'`)
  const url = pg.url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`)
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  clients.push(client)
  for (const statement of migrationStatements()) await client.$executeRawUnsafe(statement)
  return new PrismaAiTokensStore(client)
}

/** Wait out `ms` of real time. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe.each(ZONES)('wallet crediting on a database whose session zone is %s', (zone) => {
  const ref: WalletRef = { tenantId: 'tz', ownerType: 'user', ownerId: 'u1' }

  /** An ordinary grant, effective a moment ago, is spendable at once. */
  it('lets an immediate grant be spent at once', async () => {
    const store = await storeInZone(zone)
    await store.appendEntry(
      ref,
      grantEntry({
        idempotencyKey: 'now',
        amountNanoUsd: 100n,
        effectiveAt: new Date(Date.now() - 1_000),
      }),
    )

    expect(
      await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'd1' }), 0n),
    ).not.toBeNull()
    expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(90n)
  })

  /** A grant that falls due in two seconds is refused until then and accepted after. */
  it('credits a grant that falls due in two seconds only once it is due', async () => {
    const store = await storeInZone(zone)
    await store.appendEntry(
      ref,
      grantEntry({
        idempotencyKey: 'soon',
        amountNanoUsd: 100n,
        effectiveAt: new Date(Date.now() + 2_000),
      }),
    )

    expect(
      await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'early' }), 0n),
    ).toBeNull()
    await wait(2_600)
    expect(
      await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'later' }), 0n),
    ).not.toBeNull()
    expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(90n)
  })

  /** A grant expires at its UTC instant: spendable before it, swept with one expiry entry after it. */
  it('expires a grant at its UTC instant', async () => {
    const store = await storeInZone(zone)
    await store.appendEntry(
      ref,
      grantEntry({
        idempotencyKey: 'brief',
        amountNanoUsd: 100n,
        effectiveAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 2_000),
      }),
    )

    expect(
      await store.conditionalDebit(ref, debitEntry(30n, { idempotencyKey: 'before' }), 0n),
    ).not.toBeNull()
    await wait(2_600)
    expect(
      await store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: 'after' }), 0n),
    ).toBeNull()
    const expiries = (await store.listEntries(ref, { type: 'expiry' })).entries
    expect(expiries).toHaveLength(1)
    expect(expiries[0]?.amountNanoUsd).toBe(-70n)
    expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(0n)
  })
})

describe('wallet grants judged on the application clock the store is given', () => {
  const ref: WalletRef = { tenantId: 'clock', ownerType: 'user', ownerId: 'u1' }

  /*
   * Invariant: a grant the database clock still reads as live is lapsed when the application's instant says so,
   * and a grant the database clock reads as not yet effective is spendable when the application's instant says so.
   * The instants are minutes away from the database's, so no timing is involved.
   */
  it('judges expiry and effectiveness on the given instant, not the database clock', async () => {
    const store = await storeInZone('Asia/Tokyo')
    const appNow = new Date(Date.now() + 120_000)
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'lapsing', amountNanoUsd: 100n, effectiveAt: new Date(Date.now() - 1_000), expiresAt: new Date(Date.now() + 60_000) }))
    expect(await store.openGrants(ref, 'expiry', appNow)).toHaveLength(0)
    expect(await store.openGrants(ref, 'expiry')).toHaveLength(1)
    expect(await store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: 'late' }), 0n, appNow)).toBeNull()
    expect((await store.reconcile(ref, appNow)).balanceNanoUsd).toBe(0n)

    const future = new Date(Date.now() + 60_000)
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'pending', amountNanoUsd: 50n, effectiveAt: future }))
    expect(await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'early' }), 0n)).toBeNull()
    expect(await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'ok' }), 0n, appNow)).not.toBeNull()
  })

  /*
   * Invariant: a grant the database clock already reads as expired when it is appended, but the application's
   * instant reads as live, is credited when a debit judges it at that instant. The append-time credit is judged on
   * the database clock, so only activation can credit it.
   */
  it('credits a grant that was expired by the database clock at append but is live at the given instant', async () => {
    const store = await storeInZone('UTC')
    const appNow = new Date(Date.now() - 5_000)
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'skewed', amountNanoUsd: 100n, effectiveAt: new Date(Date.now() - 10_000), expiresAt: new Date(Date.now() - 1_000) }))
    expect(await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'ok' }), 0n, appNow)).not.toBeNull()
    expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(90n)
  })

  /*
   * Invariant: a grant the database clock credited at append, whose effectiveAt the application instant has not reached,
   * funds no debit: the debit is refused, nothing is allocated or written, and once the instant reaches it the grant
   * is burned with an allocation.
   */
  it('does not let a credited grant that is not effective at the given instant fund a debit', async () => {
    const store = await storeInZone('UTC')
    const early = new Date(Date.now() - 10_000)
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'ahead', amountNanoUsd: 100n, effectiveAt: new Date(Date.now() - 1_000) }))
    expect(await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'early' }), 0n, early)).toBeNull()
    expect((await store.listEntries(ref, { type: 'debit' })).total).toBe(0)
    const debit = await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'ok' }), 0n, new Date())
    expect(debit).not.toBeNull()
    expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(90n)
  })
})
