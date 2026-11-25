/**
 * @fileoverview A 1.1.23 writer (no sequence, no running balance) after the new code has written to the same wallet, as in a rolling deploy:
 * only the listing order of its rows differs; the stored balance, the running balance of later entries and the refund cap stay right.
 * @layer test
 */

import type { NewWalletEntry, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { debitEntry, grantEntry } from '../contracts/wallet-store.contract'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture
beforeAll(async () => { pg = await startPostgres() }, 180_000)
afterAll(async () => { await pg.stop() })

describe('rolling deploy: a 1.1.23 writer after a new writer', () => {
  /** The old rows list first, the balance and the cap count them, and the next new entry's running balance includes them. */
  it('keeps the balance and the cap right and only moves the old rows in the listing', async () => {
    const ref: WalletRef = { tenantId: 'roll', ownerType: 'user', ownerId: 'u1' }
    const adj = (key: string, n: bigint): NewWalletEntry => ({ ...grantEntry({ idempotencyKey: key }), type: 'adjustment', amountNanoUsd: n })
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 1000n }))
    await pg.store.appendEntry(ref, adj('new-1', 10n))
    const wallet = (await pg.store.getWallet(ref))!
    const old = async (key: string, type: string, amount: number, usage?: string): Promise<void> => {
      await pg.prisma.$transaction([
        pg.prisma.$executeRawUnsafe(`INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","usageRecordId","idempotencyKey","createdAt") VALUES ('old-${key}','${wallet.id}','${type}',${amount},0,now() AT TIME ZONE 'UTC',${usage ? `'${usage}'` : 'NULL'},'${key}',now() AT TIME ZONE 'UTC')`),
        pg.prisma.$executeRawUnsafe(`UPDATE "ai_wallets" SET "balanceNanoUsd" = "balanceNanoUsd" + ${amount} WHERE "id"='${wallet.id}'`),
      ])
    }
    await old('old-1', 'adjustment', 5)
    await pg.store.appendEntry(ref, adj('new-2', 1n))
    const show = async (order: 'asc' | 'desc'): Promise<string[]> => {
      const { entries } = await pg.store.listEntries(ref, { order })
      return entries.map((e) => `${e.idempotencyKey}:${e.seq ?? 'null'}:${e.balanceAfterNanoUsd ?? 'null'}`)
    }
    expect(await show('asc')).toEqual(['old-1:null:null', 'g:1:1000', 'new-1:2:1010', 'new-2:3:1016'])
    expect((await show('desc')).at(-1)).toBe('old-1:null:null')
    expect((await pg.store.getWallet(ref))?.balanceNanoUsd).toBe(1016n)
    // cap
    const debit = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'dbt', usageRecordId: 'U' }), 0n))!
    await old('old-refund', 'refund', 30, 'U')
    const refund = (n: bigint, k: string): NewWalletEntry => ({ ...grantEntry({ idempotencyKey: k }), type: 'refund', amountNanoUsd: n, usageRecordId: 'U' })
    await expect(pg.store.refundToSource!(ref, { entry: refund(80n, 'r80'), debitEntryId: debit.id, now: new Date() })).rejects.toBeDefined()
    await expect(pg.store.refundToSource!(ref, { entry: refund(70n, 'r70'), debitEntryId: debit.id, now: new Date() })).resolves.toBeDefined()
    expect((await pg.store.getWallet(ref))?.balanceNanoUsd).toBe(1016n)
  })
})
