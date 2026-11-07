/**
 * @fileoverview E2E: the set-based grant remainder returns exactly what the per-grant sum it replaced returned.
 * A wallet holding every kind of grant (open, partly spent, spent, expired with a remainder, due later and
 * activated since, not yet due) is read through the store's open-grants query and its reconcile, and the
 * result is compared with the same questions asked in the older, per-grant form; a debit that spans several
 * grants must leave the allocation trail the older query would have produced. A second wallet with its own
 * allocations proves the rewrite reads only the wallet it is asked about.
 * @layer test
 */

import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { CREDITED_SQL, DB_NOW_SQL, GRANT_REMAINING_SQL, SIGNED_BALANCE_SQL } from '../../src/prisma/adapter-sql'
import { sql } from '../../src/prisma/sql'
import type { Sql } from '../../src/prisma/sql'
import { debitEntry, grantEntry } from '../contracts/wallet-store.contract'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture
beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)
afterAll(async () => {
  await pg.stop()
})

const A: WalletRef = { tenantId: 'eq', ownerType: 'user', ownerId: 'a' }
const B: WalletRef = { tenantId: 'eq', ownerType: 'user', ownerId: 'b' }
const FAR = new Date('2040-01-01T00:00:00.000Z')

/** Run a statement built with `sql` through the raw client. */
async function rows<T>(statement: Sql): Promise<T[]> {
  return pg.prisma.$queryRawUnsafe<T[]>(statement.text, ...statement.parameters)
}

/** The open grants the way the store asked before the rewrite: a sum per grant, in a correlated subquery. */
async function referenceOpenGrants(walletId: string, order: 'expiry' | 'priority' | 'fifo'): Promise<{ id: string; remaining: bigint }[]> {
  const orderBy =
    order === 'priority' ? sql`g."priority" ASC, g."createdAt" ASC` : order === 'fifo' ? sql`g."createdAt" ASC` : sql`g."expiresAt" ASC NULLS LAST, g."createdAt" ASC`
  return rows(sql`
    SELECT g."id", ${GRANT_REMAINING_SQL}::bigint AS "remaining" FROM "ai_wallet_entries" g
    WHERE g."walletId" = ${walletId} AND g."type" = 'grant' AND ${CREDITED_SQL}
      AND g."effectiveAt" <= ${DB_NOW_SQL} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${DB_NOW_SQL}) AND ${GRANT_REMAINING_SQL} > 0
    ORDER BY ${orderBy}`)
}

/** The spendable balance the way reconcile computed it before the rewrite. */
async function referenceBalance(walletId: string): Promise<bigint> {
  const result = await rows<{ balance: bigint }>(sql`
    SELECT ${SIGNED_BALANCE_SQL} - (
      SELECT COALESCE(SUM(${GRANT_REMAINING_SQL}), 0) FROM "ai_wallet_entries" g
      WHERE g."walletId" = w."id" AND g."type" = 'grant' AND ${CREDITED_SQL} AND g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${DB_NOW_SQL}
    ) AS "balance" FROM "ai_wallets" w WHERE w."id" = ${walletId}`)
  return BigInt(result[0]!.balance)
}

/** Seed one wallet with every kind of grant, with allocations on several. */
async function seed(ref: WalletRef, tag: string): Promise<string> {
  const { store, prisma } = pg
  await store.appendEntry(ref, grantEntry({ idempotencyKey: `${tag}-open`, amountNanoUsd: 1_000n, expiresAt: FAR }))
  await store.appendEntry(ref, grantEntry({ idempotencyKey: `${tag}-partly`, amountNanoUsd: 900n, expiresAt: new Date('2039-01-01T00:00:00.000Z') }))
  await store.appendEntry(ref, grantEntry({ idempotencyKey: `${tag}-spent`, amountNanoUsd: 300n, expiresAt: new Date('2038-01-01T00:00:00.000Z') }))
  await store.appendEntry(ref, grantEntry({ idempotencyKey: `${tag}-notdue`, amountNanoUsd: 700n, effectiveAt: FAR, expiresAt: new Date('2041-01-01T00:00:00.000Z') }))
  const walletId = (await store.getWallet(ref))!.id
  // Expired with a remainder, and due-later-then-activated: shapes the store itself only produces over time.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","expiresAt","idempotencyKey","reason","createdAt")
     VALUES ('${tag}-expired','${walletId}','grant',500,0,TIMESTAMP '2020-01-01',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 hour','${tag}-expired','seed',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '2 days'),
            ('${tag}-later','${walletId}','grant',400,0,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 hour',NULL,'${tag}-later','seed',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '2 days'),
            ('${tag}-dx','${walletId}','debit',-1,0,TIMESTAMP '2020-01-01',NULL,'${tag}-dx','seed',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 day')`,
  )
  const spend = async (grant: string, amounts: number[]): Promise<void> => {
    for (const [i, amount] of amounts.entries()) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ai_wallet_debit_allocations" ("id","debitEntryId","grantEntryId","amountNanoUsd") VALUES ('${tag}-${grant}-${i}','${tag}-dx','${grant}',${amount})`,
      )
    }
  }
  const idOf = async (key: string): Promise<string> => (await rows<{ id: string }>(sql`SELECT "id" FROM "ai_wallet_entries" WHERE "walletId" = ${walletId} AND "idempotencyKey" = ${key}`))[0]!.id
  await spend(await idOf(`${tag}-partly`), [100, 150, 50])
  await spend(await idOf(`${tag}-spent`), [100, 100, 100])
  await spend(`${tag}-expired`, [120, 80])
  await prisma.$executeRawUnsafe(`UPDATE "ai_wallets" SET "balanceNanoUsd" = 0 WHERE "id" = '${walletId}'`)
  return walletId
}

describe('set-based grant remainder', () => {
  /** The open grants, in each burn order, are the same rows with the same remainders as the older query returned. */
  it('returns the same open grants and remainders as the per-grant sum, in every burn order', async () => {
    await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_wallet_debit_allocations", "ai_wallet_entries", "ai_wallets" CASCADE')
    const walletId = await seed(A, 'a')
    await seed(B, 'b')
    await pg.store.reconcile(A)

    for (const order of ['expiry', 'priority', 'fifo'] as const) {
      const expected = await referenceOpenGrants(walletId, order)
      const actual = await pg.store.openGrants(A, order)
      expect(actual.map((grant) => grant.id)).toEqual(expected.map((grant) => grant.id))
      expect(actual.map((grant) => grant.remainingNanoUsd)).toEqual(expected.map((grant) => BigInt(grant.remaining)))
    }
    // The wallet holds an open, a partly spent and an activated grant; spent, expired and not-yet-due ones are absent.
    const keys = (await pg.store.openGrants(A, 'expiry')).map((grant) => grant.idempotencyKey).sort()
    expect(keys).toEqual(['a-later', 'a-open', 'a-partly'])
  })

  /** Reconcile subtracts the same expired remainder, and does not read the other wallet's allocations. */
  it('reconciles to the balance the per-grant sum gives, ignoring other wallets', async () => {
    const walletId = (await pg.store.getWallet(A))!.id
    const reconciled = await pg.store.reconcile(A)
    expect(reconciled.balanceNanoUsd).toBe(await referenceBalance(walletId))
    const other = await pg.store.reconcile(B)
    expect(other.balanceNanoUsd).toBe(await referenceBalance((await pg.store.getWallet(B))!.id))
  })

  /** A debit across three grants writes the trail the older query's rows would have produced. */
  it('leaves the allocation trail the per-grant query would have produced', async () => {
    const wallet = (await pg.store.getWallet(A))!
    const expected = await referenceOpenGrants(wallet.id, 'expiry')
    const cost = 1_000n
    const trail: { grantEntryId: string; amountNanoUsd: bigint }[] = []
    let remaining = cost
    for (const grant of expected) {
      if (remaining <= 0n) break
      const take = BigInt(grant.remaining) < remaining ? BigInt(grant.remaining) : remaining
      trail.push({ grantEntryId: grant.id, amountNanoUsd: take })
      remaining -= take
    }
    expect(trail.length).toBeGreaterThanOrEqual(2)

    const debit = await pg.store.conditionalDebit(A, debitEntry(cost, { idempotencyKey: 'span' }), 0n)
    const written = await rows<{ grantEntryId: string; amountNanoUsd: bigint }>(
      sql`SELECT "grantEntryId", "amountNanoUsd" FROM "ai_wallet_debit_allocations" WHERE "debitEntryId" = ${debit!.id} ORDER BY "id"`,
    )
    const byGrant = (list: { grantEntryId: string; amountNanoUsd: bigint | number }[]): [string, bigint][] =>
      list.map((row): [string, bigint] => [row.grantEntryId, BigInt(row.amountNanoUsd)]).sort((x, y) => x[0].localeCompare(y[0]))
    expect(byGrant(written)).toEqual(byGrant(trail))
  })
})
