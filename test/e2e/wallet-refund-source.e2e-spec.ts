/**
 * @fileoverview E2E for the wallet's commit order and the refund to its source, against real PostgreSQL with two clients: a parallel
 * chain of appends keeps one gapless order and a running balance; parallel refunds stop at the cap; a mix of every wallet writer
 * does not deadlock; a row written without a sequence sorts first; and the order index serves both directions of a large wallet.
 * @layer test
 */

import type { NewWalletEntry, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { debitEntry, grantEntry } from '../contracts/wallet-store.contract'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture

beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)

afterAll(async () => {
  await pg.stop()
})

/** A refund entry for the wallet the store resolves. */
function refundOf(amount: bigint, key: string, usageRecordId?: string): NewWalletEntry {
  return { ...grantEntry({ idempotencyKey: key }), type: 'refund', amountNanoUsd: amount, ...(usageRecordId === undefined ? {} : { usageRecordId }) }
}

/** What a rejection carries that names a deadlock, wherever the driver put it. */
function isDeadlock(error: unknown): boolean {
  return /40P01|deadlock/i.test(`${String((error as { message?: unknown })?.message)} ${JSON.stringify((error as { cause?: unknown })?.cause ?? '', (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`)
}

describe('wallet commit order and refund to source on PostgreSQL', () => {
  /** Fifty appends from two clients: the sequence is 1..50 with no gap, and every row carries the balance its predecessors leave. */
  it('keeps one gapless order and a running balance across 50 parallel appends', async () => {
    const ref: WalletRef = { tenantId: 'chain', ownerType: 'user', ownerId: 'u1' }
    const stores = [pg.store, pg.storeB]
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, index) => stores[index % 2]!.appendEntry(ref, grantEntry({ idempotencyKey: `g${index}`, amountNanoUsd: BigInt(index + 1) }))),
    )
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0)
    const entries = (await pg.store.listEntries(ref, { limit: 100 })).entries
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 50 }, (_, index) => BigInt(index + 1)))
    let running = 0n
    for (const entry of entries) {
      running += entry.amountNanoUsd
      expect(entry.balanceAfterNanoUsd).toBe(running)
    }
    expect((await pg.store.getWallet(ref))?.balanceNanoUsd).toBe(running)
  })

  /** Ten parallel refunds of 30 against a debit of 100: exactly three fit, the rest are refused, and the balance is exact. */
  it('stops parallel refunds at the cap of the debit', async () => {
    const ref: WalletRef = { tenantId: 'cap', ownerType: 'user', ownerId: 'u1' }
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n }))
    const debit = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'host', usageRecordId: 'u-1' }), 0n))!
    const stores = [pg.store, pg.storeB]
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => stores[index % 2]!.refundToSource!(ref, { entry: refundOf(30n, `r${index}`, 'u-1'), debitEntryId: debit.id, now: new Date() })),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
    expect(results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').every((result) => !isDeadlock(result.reason))).toBe(true)
    expect((await pg.store.getWallet(ref))?.balanceNanoUsd).toBe(90n)
  })

  /** Every writer of a wallet at once, from two clients: no statement is rolled back as a deadlock. */
  it('does not deadlock when appends, debits, refunds and reconciles run together', async () => {
    const ref: WalletRef = { tenantId: 'mix', ownerType: 'user', ownerId: 'u1' }
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'seed', amountNanoUsd: 100_000n, expiresAt: new Date(Date.now() + 3_600_000) }))
    const debit = (await pg.store.conditionalDebit(ref, debitEntry(50_000n, { idempotencyKey: 'host', usageRecordId: 'u-mix' }), 0n))!
    const stores = [pg.store, pg.storeB]
    const jobs: Promise<unknown>[] = []
    for (let index = 0; index < 40; index += 1) {
      const store = stores[index % 2]!
      jobs.push(store.appendEntry(ref, grantEntry({ idempotencyKey: `a${index}`, amountNanoUsd: 5n })))
      jobs.push(store.conditionalDebit(ref, debitEntry(3n, { idempotencyKey: `d${index}` }), 0n))
      jobs.push(store.refundToSource!(ref, { entry: refundOf(7n, `r${index}`, 'u-mix'), debitEntryId: debit.id, now: new Date() }))
      if (index % 5 === 0) jobs.push(store.reconcile(ref, new Date()))
    }
    const results = await Promise.allSettled(jobs)
    const deadlocks = results.filter((result) => result.status === 'rejected' && isDeadlock(result.reason))
    expect(deadlocks).toHaveLength(0)
    const wallet = await pg.store.reconcile(ref)
    expect((await pg.store.getWallet(ref))?.balanceNanoUsd).toBe(wallet.balanceNanoUsd)
    const entries = (await pg.store.listEntries(ref, { limit: 500 })).entries
    const seqs = entries.map((entry) => entry.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  /** A row an older writer left with no sequence sorts before every numbered row, in both directions' mirror. */
  it('sorts a row without a sequence first, and last when descending', async () => {
    const ref: WalletRef = { tenantId: 'legacy', ownerType: 'user', ownerId: 'u1' }
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'new-1', amountNanoUsd: 10n }))
    const wallet = (await pg.store.getWallet(ref))!
    await pg.prisma.$executeRawUnsafe(
      `INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","idempotencyKey","createdAt")
       VALUES ('legacy-row', '${wallet.id}', 'adjustment', 1, 0, now() AT TIME ZONE 'UTC', 'legacy-key', now() AT TIME ZONE 'UTC' + interval '1 hour')`,
    )
    expect((await pg.store.listEntries(ref)).entries.map((entry) => entry.idempotencyKey)).toEqual(['legacy-key', 'new-1'])
    expect((await pg.store.listEntries(ref, { order: 'desc' })).entries.map((entry) => entry.idempotencyKey)).toEqual(['new-1', 'legacy-key'])
  })

  /** The order index serves the ascending and the descending page of a large wallet without a sort. */
  it('reads both directions of a large wallet from the order index', async () => {
    const ref: WalletRef = { tenantId: 'large', ownerType: 'user', ownerId: 'u1' }
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'first', amountNanoUsd: 1n }))
    const wallet = (await pg.store.getWallet(ref))!
    await pg.prisma.$executeRawUnsafe(
      `INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","idempotencyKey","createdAt","seq","balanceAfterNanoUsd")
       SELECT 'bulk-' || g, '${wallet.id}', 'adjustment', 1, 0, now() AT TIME ZONE 'UTC', 'bulk-' || g, now() AT TIME ZONE 'UTC', g + 1, g + 1 FROM generate_series(1, 60000) g`,
    )
    await pg.prisma.$executeRawUnsafe(`ANALYZE "ai_wallet_entries"`)
    const plans: Record<string, string> = {}
    for (const [name, order] of [['asc', `"seq" ASC NULLS FIRST, "createdAt" ASC, "id" ASC`], ['desc', `"seq" DESC NULLS LAST, "createdAt" DESC, "id" DESC`]] as const) {
      const rows = await pg.prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT * FROM "ai_wallet_entries" WHERE "walletId" = '${wallet.id}' ORDER BY ${order} LIMIT 50`,
      )
      plans[name] = rows.map((row) => row['QUERY PLAN']).join('\n')
    }
    console.info(`EXPLAIN asc:\n${plans['asc']}\nEXPLAIN desc:\n${plans['desc']}`)
    for (const plan of Object.values(plans)) {
      expect(plan).toMatch(/Index Scan/)
      expect(plan).not.toMatch(/\bSort\b/)
    }
    expect((await pg.store.listEntries(ref, { order: 'desc', limit: 1 })).entries[0]?.seq).toBe(60001n)
  }, 120_000)

  /** The cost of the lock an append takes: the p95 of same-wallet appends with and without it, measured here and printed. */
  it('reports the p95 of same-wallet appends before and after the lock', async () => {
    const p95 = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)]!
    const run = async (label: string, write: (ref: WalletRef, index: number) => Promise<unknown>): Promise<number> => {
      const ref: WalletRef = { tenantId: `lat-${label}`, ownerType: 'user', ownerId: 'u1' }
      await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'seed', amountNanoUsd: 1n }))
      const samples: number[] = []
      for (let batch = 0; batch < 20; batch += 1) {
        await Promise.all(
          Array.from({ length: 8 }, async (_, slot) => {
            const started = performance.now()
            await write(ref, batch * 8 + slot)
            samples.push(performance.now() - started)
          }),
        )
      }
      return p95(samples)
    }
    const before = await run('before', async (ref, index) => {
      const wallet = (await pg.store.getWallet(ref))!
      await pg.prisma.$transaction([
        pg.prisma.$executeRawUnsafe(
          `INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","idempotencyKey","createdAt")
           VALUES ('b-${ref.tenantId}-${index}', '${wallet.id}', 'adjustment', 1, 0, now() AT TIME ZONE 'UTC', 'b-${index}', now() AT TIME ZONE 'UTC')`,
        ),
        pg.prisma.$executeRawUnsafe(`UPDATE "ai_wallets" SET "balanceNanoUsd" = "balanceNanoUsd" + 1 WHERE "id" = '${wallet.id}'`),
      ])
    })
    const after = await run('after', (ref, index) => pg.store.appendEntry(ref, { ...grantEntry({ idempotencyKey: `n-${index}` }), type: 'adjustment', amountNanoUsd: 1n }))
    console.info(`same-wallet append p95 (8 parallel, 160 appends): before ${before.toFixed(1)} ms, after ${after.toFixed(1)} ms`)
    expect(after).toBeLessThan(Math.max(before * 10, 500))
  }, 120_000)
})
