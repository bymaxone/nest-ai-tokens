/**
 * @fileoverview E2E for the predicate and arithmetic boundaries of the refund to its source, against real PostgreSQL: every wallet, type, sign
 * and key-prefix predicate of its statements is told apart by a second wallet, a second debit or a second entry kind, and the order the
 * debit's grants are read in is told apart one key at a time. The statements live in `wallet-writes.ts`, which the unit and Stryker gates do not run.
 * @layer test
 */

import type { NewWalletEntry, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { debitEntry, grantEntry } from '../contracts/wallet-store.contract'
import { PrismaAiTokensStore } from '../../src/prisma'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture

beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)

afterAll(async () => {
  await pg.stop()
})

const FUTURE = new Date('2099-01-01T00:00:00.000Z')
const REFUSED = 'AI_TOKENS_INVALID_CONFIG'
let counter = 0

/** A wallet ref no other row uses. */
function freshRef(): WalletRef {
  counter += 1
  return { tenantId: `boundary-${counter}`, ownerType: 'user', ownerId: 'u1' }
}

/** A refund entry for the wallet the store resolves. */
function refundOf(amount: bigint, key: string, usageRecordId?: string): NewWalletEntry {
  return { ...grantEntry({ idempotencyKey: key }), type: 'refund', amountNanoUsd: amount, ...(usageRecordId === undefined ? {} : { usageRecordId }) }
}

/** The body a rejection carries, as one string, or `resolved` when the call did not reject. */
async function bodyOf(call: Promise<unknown>): Promise<string> {
  const error: unknown = await call.then(() => 'resolved', (failure: unknown) => failure)
  if (error === 'resolved') return 'resolved'
  const body = (error as { getResponse?: () => unknown }).getResponse?.()
  return body === undefined ? String(error) : JSON.stringify(body)
}

/** The grants a debit or refund is allocated to, by grant id, as the table stores them. */
async function allocationsOf(entryId: string): Promise<Record<string, bigint>> {
  const rows = await pg.prisma.$queryRawUnsafe<{ grantEntryId: string; amountNanoUsd: bigint }[]>(
    `SELECT "grantEntryId", "amountNanoUsd" FROM "ai_wallet_debit_allocations" WHERE "debitEntryId" = '${entryId}'`,
  )
  return Object.fromEntries(rows.map((row) => [row.grantEntryId, row.amountNanoUsd]))
}

/** Insert a row the store's own writers would not produce (no sequence, a chosen id or time). */
async function rawEntry(walletId: string, fields: { id: string; type: string; amount: bigint; key: string; createdAt?: string; usage?: string; refundsEntryId?: string; priority?: number }): Promise<void> {
  await pg.prisma.$executeRawUnsafe(
    `INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","usageRecordId","idempotencyKey","createdAt","refundsEntryId")
     VALUES ('${fields.id}','${walletId}','${fields.type}',${fields.amount},${fields.priority ?? 0},'2020-01-01T00:00:00.000Z',${fields.usage === undefined ? 'NULL' : `'${fields.usage}'`},'${fields.key}','${fields.createdAt ?? '2020-01-01T00:00:00.000Z'}',${fields.refundsEntryId === undefined ? 'NULL' : `'${fields.refundsEntryId}'`})`,
  )
}

/** A wallet holding one grant of `amount`, and a debit of `spend` against it carrying `usage`; the wallet id, grant and debit are handed back. */
async function debited(ref: WalletRef, spend: bigint, usage: string, amount = spend) {
  const grant = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: amount, expiresAt: FUTURE }))
  const debit = (await pg.store.conditionalDebit(ref, debitEntry(spend, { idempotencyKey: `d-${usage}`, usageRecordId: usage }), 0n))!
  return { walletId: grant.walletId, grant, debit }
}

describe('refund to source: the tenant boundary of every lookup', () => {
  /** A foreign wallet holding the sweep's key for this wallet's grant must not make the grant look swept: it is not expired, so no expiry is written. */
  it('does not read another wallet’s entry as the sweep of this wallet’s grant (W-er-14)', async () => {
    const a = freshRef()
    const b = freshRef()
    const { grant, debit } = await debited(a, 100n, 'u-1')
    await pg.store.appendEntry(b, grantEntry({ idempotencyKey: 'seed' }))
    const walletB = (await pg.store.getWallet(b))!.id
    await rawEntry(walletB, { id: 'foreign-expiry', type: 'adjustment', amount: 0n, key: `expiry:${grant.id}` })
    const refund = await pg.store.refundToSource!(a, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: debit.id, now: new Date() })
    expect(await allocationsOf(refund.id)).toEqual({ [grant.id]: -100n })
    const kinds = (await pg.store.listEntries(a, { limit: 100 })).entries.map((entry) => entry.type)
    expect(kinds).not.toContain('expiry')
    expect(await pg.store.balanceAt!(a, new Date())).toBe(100n)
  })

  /** A debit named by id is a debit of this wallet only: a grant, or a negative adjustment, of the same wallet is not one. */
  it('refuses an entry that is not a debit, naming why (W-sd-2)', async () => {
    const ref = freshRef()
    const { grant } = await debited(ref, 40n, 'u-1', 100n)
    const adjustment = await pg.store.appendEntry(ref, { ...grantEntry({ idempotencyKey: 'neg' }), type: 'adjustment', amountNanoUsd: -50n })
    for (const id of [grant.id, adjustment.id]) {
      const body = await bodyOf(pg.store.refundToSource!(ref, { entry: refundOf(10n, `r-${id}`, 'u-1'), debitEntryId: id, now: new Date() }))
      expect(body).toContain(REFUSED)
      expect(body).toContain('the debit to restore is not a debit of this wallet')
    }
  })

  /** A debit of another wallet with the same id is not this wallet's debit. */
  it('refuses a debit id of another wallet', async () => {
    const a = freshRef()
    const b = freshRef()
    await debited(a, 100n, 'u-1')
    const other = await debited(b, 100n, 'u-1')
    const body = await bodyOf(pg.store.refundToSource!(a, { entry: refundOf(10n, 'r1', 'u-1'), debitEntryId: other.debit.id, now: new Date() }))
    expect(body).toContain('the debit to restore is not a debit of this wallet')
  })

  /** Another wallet's debit with the same usage id does not make this wallet's debit ambiguous. */
  it('names the one debit of this wallet by usage id when another wallet has one too (W-sd-9)', async () => {
    const a = freshRef()
    const b = freshRef()
    const mine = await debited(a, 100n, 'shared')
    await debited(b, 100n, 'shared')
    const refund = await pg.store.refundToSource!(a, { entry: refundOf(100n, 'r1', 'shared'), now: new Date() })
    expect(refund.refundsEntryId).toBe(mine.debit.id)
  })

  /** Neither an id nor a usage id: refused, and the reason says so rather than that no debit matched. */
  it('refuses a refund that names no debit by either handle (W-sd-5)', async () => {
    const ref = freshRef()
    await debited(ref, 100n, 'u-1')
    const body = await bodyOf(pg.store.refundToSource!(ref, { entry: refundOf(10n, 'r1'), now: new Date() }))
    expect(body).toContain(REFUSED)
    expect(body).toContain('a source refund names a debit by id or by usageRecordId')
  })

  /** An unlinked refund of another wallet that carries the same usage id does not eat into this debit's room. */
  it('does not count another wallet’s unlinked refund against this debit (W-ro-9)', async () => {
    const a = freshRef()
    const b = freshRef()
    const { debit } = await debited(a, 100n, 'shared')
    await pg.store.appendEntry(b, grantEntry({ idempotencyKey: 'seed', amountNanoUsd: 100n }))
    await pg.store.appendEntry(b, refundOf(40n, 'plain', 'shared'))
    const refund = await pg.store.refundToSource!(a, { entry: refundOf(100n, 'r1', 'shared'), debitEntryId: debit.id, now: new Date() })
    expect(refund.amountNanoUsd).toBe(100n)
  })
})

describe('refund to source: the room a debit has left', () => {
  /** A credit that is linked to the debit but is not a refund is not a refund's room. */
  it('counts only refunds among the entries linked to the debit (W-ro-1)', async () => {
    const ref = freshRef()
    const { walletId, debit } = await debited(ref, 100n, 'u-1')
    await rawEntry(walletId, { id: 'linked-adjustment', type: 'adjustment', amount: 30n, key: 'linked-adjustment', refundsEntryId: debit.id })
    const refund = await pg.store.refundToSource!(ref, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: debit.id, now: new Date() })
    expect(refund.amountNanoUsd).toBe(100n)
  })

  /** A refund linked to another debit of the wallet does not take this debit's room. */
  it('counts only the refunds linked to this debit, not those of another debit (W-ro-2)', async () => {
    const ref = freshRef()
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 300n, expiresAt: FUTURE }))
    const d1 = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd1', usageRecordId: 'u-1' }), 0n))!
    const d2 = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd2', usageRecordId: 'u-2' }), 0n))!
    await pg.store.refundToSource!(ref, { entry: refundOf(60n, 'r2', 'u-2'), debitEntryId: d2.id, now: new Date() })
    const refund = await pg.store.refundToSource!(ref, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: d1.id, now: new Date() })
    expect(refund.amountNanoUsd).toBe(100n)
  })

  /** A refund of the other debit that burned the same grant is not what was restored to this debit's share of it. */
  it('restores a debit’s share of a grant by the refunds linked to it, not by every refund that touched the grant (W-fa-2)', async () => {
    const ref = freshRef()
    const grant = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 200n, expiresAt: FUTURE }))
    const d1 = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd1', usageRecordId: 'u-1' }), 0n))!
    const d2 = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd2', usageRecordId: 'u-2' }), 0n))!
    const other = await pg.store.refundToSource!(ref, { entry: refundOf(60n, 'r2', 'u-2'), debitEntryId: d2.id, now: new Date() })
    const mine = await pg.store.refundToSource!(ref, { entry: refundOf(40n, 'r1', 'u-1'), debitEntryId: d1.id, now: new Date() })
    expect(await allocationsOf(other.id)).toEqual({ [grant.id]: -60n })
    expect(await allocationsOf(mine.id)).toEqual({ [grant.id]: -40n })
  })

  /**
   * A debit of 100 with an unlinked +20 activation adjustment, a +30 adjustment, a -30 adjustment and a 0 adjustment of its usage id: only the +30 takes
   * room, so 70 is the most a refund can restore.
   */
  it('counts only the positive, non-activation adjustments of the usage id (W-ro-6, W-ro-8)', async () => {
    const ref = freshRef()
    const { walletId, debit } = await debited(ref, 100n, 'u-1')
    await rawEntry(walletId, { id: 'activation', type: 'adjustment', amount: 20n, key: 'activate:some-grant', usage: 'u-1' })
    await rawEntry(walletId, { id: 'positive', type: 'adjustment', amount: 30n, key: 'positive', usage: 'u-1' })
    await rawEntry(walletId, { id: 'negative', type: 'adjustment', amount: -30n, key: 'negative', usage: 'u-1' })
    await rawEntry(walletId, { id: 'zero', type: 'adjustment', amount: 0n, key: 'zero', usage: 'u-1' })
    const over = await bodyOf(pg.store.refundToSource!(ref, { entry: refundOf(71n, 'over', 'u-1'), debitEntryId: debit.id, now: new Date() }))
    expect(over).toContain('the refund is above what the debit has left to restore')
    const exact = await pg.store.refundToSource!(ref, { entry: refundOf(70n, 'exact', 'u-1'), debitEntryId: debit.id, now: new Date() })
    expect(exact.amountNanoUsd).toBe(70n)
  })

  /** Nothing and less than nothing are refused as a refund of the source, not left to the split to throw. */
  it('refuses a refund of zero and of a negative amount as a typed refusal (W-ro-12, W-ro-16)', async () => {
    const ref = freshRef()
    const { debit } = await debited(ref, 100n, 'u-1')
    for (const amount of [0n, -5n]) {
      const body = await bodyOf(pg.store.refundToSource!(ref, { entry: refundOf(amount, `r${amount}`, 'u-1'), debitEntryId: debit.id, now: new Date() }))
      expect(body).toContain(REFUSED)
      expect(body).toContain('the refund is above what the debit has left to restore')
    }
  })
})

describe('refund to source: an expired grant takes its part back out', () => {
  /** The refund is judged at the clock it is handed: a grant that expires exactly then is expired. */
  it('writes the expiry of a grant that expires exactly at the refund’s clock (W-er-2)', async () => {
    const ref = freshRef()
    const expiresAt = new Date(Date.now() + 3_600_000)
    const grant = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n, expiresAt }))
    const debit = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd', usageRecordId: 'u-1' }), 0n))!
    await pg.store.refundToSource!(ref, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: debit.id, now: expiresAt })
    const expiries = (await pg.store.listEntries(ref, { limit: 100 })).entries.filter((entry) => entry.type === 'expiry')
    expect(expiries.map((entry) => entry.amountNanoUsd)).toEqual([-100n])
    expect(expiries[0]!.effectiveAt).toEqual(expiresAt)
    expect(await allocationsOf(expiries[0]!.id)).toEqual({ [grant.id]: 100n })
  })

  /** The entry that takes the part back out carries the grant's priority, so a priority-ordered read of the wallet puts it with the grant. */
  it('gives the compensating expiry the priority of its grant (W-er-15)', async () => {
    const ref = freshRef()
    const grant = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n, priority: 7, expiresAt: new Date(Date.now() + 3_600_000) }))
    const debit = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd', usageRecordId: 'u-1' }), 0n))!
    await pg.store.refundToSource!(ref, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: debit.id, now: new Date(Date.now() + 7_200_000) })
    const expiry = (await pg.store.listEntries(ref, { limit: 100 })).entries.find((entry) => entry.type === 'expiry' && entry.reason === 'refund restored an expired grant')
    expect(expiry?.priority).toBe(7)
    expect(await allocationsOf(expiry!.id)).toEqual({ [grant.id]: 100n })
  })

  /**
   * The key of the compensating entry is a reserved one: when another entry holds it, the refund is refused whole. In production the key carries
   * the id the refund is given inside its own transaction, so no row can hold it beforehand: the collision is FORCED here by an AFTER INSERT
   * trigger that writes the key as the refund lands.
   */
  it('refuses the refund whole when a trigger forces another entry onto the compensating key (W-er-11)', async () => {
    const ref = freshRef()
    const grant = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n, expiresAt: new Date(Date.now() + 3_600_000) }))
    const debit = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd', usageRecordId: 'u-1' }), 0n))!
    await pg.prisma.$executeRawUnsafe(`
      CREATE FUNCTION hold_compensating_key() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","idempotencyKey","createdAt")
        VALUES ('squatter', NEW."walletId", 'adjustment', 0, 0, NEW."effectiveAt", 'expiry:refund:' || NEW."id" || ':${grant.id}', NEW."createdAt");
        RETURN NULL;
      END $$ LANGUAGE plpgsql`)
    await pg.prisma.$executeRawUnsafe(`CREATE TRIGGER hold_compensating_key AFTER INSERT ON "ai_wallet_entries" FOR EACH ROW WHEN (NEW."type" = 'refund') EXECUTE FUNCTION hold_compensating_key()`)
    try {
      const body = await bodyOf(pg.store.refundToSource!(ref, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: debit.id, now: new Date(Date.now() + 7_200_000) }))
      expect(body).toContain(REFUSED)
      const kinds = (await pg.store.listEntries(ref, { limit: 100 })).entries.map((entry) => entry.type)
      expect(kinds).not.toContain('refund')
    } finally {
      await pg.prisma.$executeRawUnsafe(`DROP TRIGGER hold_compensating_key ON "ai_wallet_entries"`)
    }
  })
})

describe('refund to source: the order a debit’s grants are read in, one key at a time', () => {
  /**
   * The order is `seq`, then `createdAt`, then `id`. The last two decide only among grants without a sequence: `seq` is nullable, and the unique
   * index on (walletId, seq) is partial (`WHERE seq IS NOT NULL`, migration 0005), so any number of legacy grants of a wallet may hold a NULL
   * `seq`, and for those `createdAt` and then `id` are the only keys left.
   *
   * A debit of 100 burned 50 from each of two grants. A refund of 1 splits into two equal remainders, and the unit goes to the first grant read, so the
   * grant that holds the refund's allocation is the one the order puts first.
   */
  const firstReadOf = async (ref: WalletRef, walletId: string, first: string, second: string): Promise<string[]> => {
    const debit = await pg.store.appendEntry(ref, debitEntry(100n, { idempotencyKey: 'd', usageRecordId: 'u-1' }), [
      { grantEntryId: second, amountNanoUsd: 50n },
      { grantEntryId: first, amountNanoUsd: 50n },
    ])
    const refund = await pg.store.refundToSource!(ref, { entry: refundOf(1n, 'r1', 'u-1'), debitEntryId: debit.id, now: new Date() })
    expect(refund.walletId).toBe(walletId)
    return Object.keys(await allocationsOf(refund.id))
  }

  /** The sequence is the first key: the grant committed first is read first. */
  it('reads the grant committed first before the one committed after it (W-fa-5)', async () => {
    const ref = freshRef()
    const g1 = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 50n, expiresAt: FUTURE }))
    const g2 = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g2', amountNanoUsd: 50n, expiresAt: FUTURE }))
    expect(await firstReadOf(ref, g1.walletId, g1.id, g2.id)).toEqual([g1.id])
  })

  /** A grant written before the sequence existed has none, and is read before one that has it. */
  it('reads a grant without a sequence before one that has it (W-fa-6)', async () => {
    const ref = freshRef()
    const sequenced = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 50n, expiresAt: FUTURE }))
    await rawEntry(sequenced.walletId, { id: 'zz-legacy', type: 'grant', amount: 50n, key: 'legacy', createdAt: '2099-02-01T00:00:00.000Z' })
    expect(await firstReadOf(ref, sequenced.walletId, 'zz-legacy', sequenced.id)).toEqual(['zz-legacy'])
  })

  /** Two grants without a sequence are read oldest first, whatever their ids. */
  it('reads the older of two grants without a sequence first (W-fa-7)', async () => {
    const ref = freshRef()
    const seed = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'seed', amountNanoUsd: 1n, expiresAt: FUTURE }))
    await rawEntry(seed.walletId, { id: 'b-older', type: 'grant', amount: 50n, key: 'older', createdAt: '2020-01-01T00:00:00.000Z' })
    await rawEntry(seed.walletId, { id: 'a-newer', type: 'grant', amount: 50n, key: 'newer', createdAt: '2020-06-01T00:00:00.000Z' })
    expect(await firstReadOf(ref, seed.walletId, 'b-older', 'a-newer')).toEqual(['b-older'])
  })

  /** Two grants without a sequence and written at the same instant are read by id. */
  it('reads the lower id first when two grants without a sequence share a time (W-fa-8)', async () => {
    const ref = freshRef()
    const seed = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'seed', amountNanoUsd: 1n, expiresAt: FUTURE }))
    await rawEntry(seed.walletId, { id: 'a-low', type: 'grant', amount: 50n, key: 'low', createdAt: '2020-01-01T00:00:00.000Z' })
    await rawEntry(seed.walletId, { id: 'b-high', type: 'grant', amount: 50n, key: 'high', createdAt: '2020-01-01T00:00:00.000Z' })
    expect(await firstReadOf(ref, seed.walletId, 'a-low', 'b-high')).toEqual(['a-low'])
  })
})

/** The wallet column as the table holds it, bypassing the store. */
async function balanceColumn(walletId: string): Promise<bigint> {
  const rows = await pg.prisma.$queryRawUnsafe<{ balanceNanoUsd: bigint }[]>(`SELECT "balanceNanoUsd" FROM "ai_wallets" WHERE "id" = '${walletId}'`)
  return rows[0]!.balanceNanoUsd
}

describe('refund to source: replay and wallet resolution', () => {
  /** A key another wallet holds is not a replay in this wallet. */
  it('does not read another wallet’s entry with the same key as a replay (I-rs-3)', async () => {
    const a = freshRef()
    const b = freshRef()
    await debited(a, 100n, 'u-1')
    const other = await debited(b, 100n, 'u-1')
    await pg.store.refundToSource!(b, { entry: refundOf(50n, 'same-key', 'u-1'), debitEntryId: other.debit.id, now: new Date() })
    const refund = await pg.store.refundToSource!(a, { entry: refundOf(50n, 'same-key', 'u-1'), now: new Date() })
    expect(refund.walletId).not.toBe(other.walletId)
  })

  /** A replay names the debit it restored: the same key with the same fields against another debit is a conflict, against the same one it is the stored refund. */
  it('replays a refund only against the debit it restored (I-rs-6, I-rs-8)', async () => {
    const ref = freshRef()
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 300n, expiresAt: FUTURE }))
    const d1 = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd1', usageRecordId: 'u-1' }), 0n))!
    const d2 = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd2', usageRecordId: 'u-1' }), 0n))!
    const first = await pg.store.refundToSource!(ref, { entry: refundOf(10n, 'r1', 'u-1'), debitEntryId: d1.id, now: new Date() })
    const again = await pg.store.refundToSource!(ref, { entry: refundOf(10n, 'r1', 'u-1'), debitEntryId: d1.id, now: new Date() })
    expect(again.id).toBe(first.id)
    const other = await pg.store
      .refundToSource!(ref, { entry: refundOf(10n, 'r1', 'u-1'), debitEntryId: d2.id, now: new Date() })
      .then(() => 'resolved', (error: unknown) => (error as { isAiTokensLedgerConflict?: boolean }).isAiTokensLedgerConflict)
    expect(other).toBe(true)
  })

  /** Two wallets of one tenant and owner id, of different owner types, are two wallets. */
  it('resolves the wallet by its owner type as well (W-gw-2)', async () => {
    const team: WalletRef = { tenantId: 'shared-tenant', ownerType: 'team', ownerId: 'x' }
    const user: WalletRef = { tenantId: 'shared-tenant', ownerType: 'user', ownerId: 'x' }
    await pg.store.appendEntry(team, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 10n }))
    const { debit } = await debited(user, 100n, 'u-1')
    const refund = await pg.store.refundToSource!(user, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: debit.id, now: new Date() })
    expect(refund.walletId).toBe(debit.walletId)
  })

  /** Only a grant or a positive adjustment brings a wallet into being; a debit or a negative adjustment on a ref with no wallet is refused and leaves none behind. */
  it('creates no wallet for an entry that can only spend (W-ew-2)', async () => {
    for (const entry of [debitEntry(5n, { idempotencyKey: 'd' }), grantEntry({ idempotencyKey: 'a', type: 'adjustment', amountNanoUsd: -5n })]) {
      const ref = freshRef()
      await expect(pg.store.appendEntry(ref, entry)).rejects.toThrow()
      expect(await pg.store.getWallet(ref)).toBeNull()
    }
  })

  /** A ref with no wallet has no debit to restore: the refund is refused as a missing wallet, not as a crash, and balances read zero. */
  it('refuses a refund on a ref with no wallet as a missing wallet, and reads zero balances there (I-rs-1, I-ba-1, I-bb-1)', async () => {
    const ref = freshRef()
    await expect(pg.store.refundToSource!(ref, { entry: refundOf(1n, 'r1', 'u-1'), debitEntryId: 'nope', now: new Date() })).rejects.toMatchObject({ isWalletMissing: true })
    const asOf = new Date('2030-01-01T00:00:00.000Z')
    expect(await pg.store.balanceAt(ref, asOf)).toBe(0n)
    expect(await pg.store.balanceBreakdown(ref, asOf)).toEqual({ asOf, nanoUsd: 0n, unallocatedNanoUsd: 0n, buckets: [] })
  })

  /** A refund of another wallet that names this wallet's debit is not a refund of this wallet. */
  it('counts only this wallet’s refunds among those linked to the debit (W-ro-18)', async () => {
    const a = freshRef()
    const b = freshRef()
    const { debit } = await debited(a, 100n, 'u-1')
    await pg.store.appendEntry(b, grantEntry({ idempotencyKey: 'seed' }))
    await rawEntry((await pg.store.getWallet(b))!.id, { id: 'foreign-refund', type: 'refund', amount: 30n, key: 'foreign-refund', refundsEntryId: debit.id })
    const refund = await pg.store.refundToSource!(a, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: debit.id, now: new Date() })
    expect(refund.amountNanoUsd).toBe(100n)
  })
})

describe('wallet statements: the clock, the sequence and the lock', () => {
  /** Two first writes to one new wallet race on its creation; a trigger holds the first insert so both have looked and found nothing. */
  it('lets two first writes to a new wallet both land on the one wallet (W-ew-4)', async () => {
    const ref = freshRef()
    await pg.prisma.$executeRawUnsafe(`CREATE FUNCTION slow_wallet_insert() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$ LANGUAGE plpgsql`)
    await pg.prisma.$executeRawUnsafe(`CREATE TRIGGER slow_wallet_insert BEFORE INSERT ON "ai_wallets" FOR EACH ROW EXECUTE FUNCTION slow_wallet_insert()`)
    try {
      const [x, y] = await Promise.all([
        pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'a' })),
        pg.storeB.appendEntry(ref, grantEntry({ idempotencyKey: 'b' })),
      ])
      expect(x.walletId).toBe(y.walletId)
    } finally {
      await pg.prisma.$executeRawUnsafe(`DROP TRIGGER slow_wallet_insert ON "ai_wallets"`)
    }
  })

  /** The system entries a refund writes take the sequence one step at a time, so the order stays gapless. */
  it('keeps the order gapless across the expiry a refund writes (W-is-1)', async () => {
    const ref = freshRef()
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n, expiresAt: new Date(Date.now() + 3_600_000) }))
    const debit = (await pg.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'd', usageRecordId: 'u-1' }), 0n))!
    await pg.store.refundToSource!(ref, { entry: refundOf(100n, 'r1', 'u-1'), debitEntryId: debit.id, now: new Date(Date.now() + 7_200_000) })
    const seqs = (await pg.store.listEntries(ref, { limit: 100 })).entries.map((entry) => entry.seq)
    expect(seqs).toEqual([1n, 2n, 3n, 4n])
  })

  /** A grant that expires exactly at the clock is swept at it, and is not credited at it. */
  it('sweeps a credited grant at the instant it expires (W-sw-2)', async () => {
    const ref = freshRef()
    const expiresAt = new Date(Date.now() + 3_600_000)
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n, expiresAt }))
    await pg.store.reconcile(ref, expiresAt)
    const kinds = (await pg.store.listEntries(ref, { limit: 100 })).entries.map((entry) => entry.type)
    expect(kinds).toEqual(['grant', 'expiry'])
  })

  it('does not credit a grant at the instant it expires (W-ad-3)', async () => {
    const ref = freshRef()
    const expiresAt = new Date(Date.now() + 7_200_000)
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n, effectiveAt: new Date(Date.now() + 3_600_000), expiresAt }))
    await pg.store.reconcile(ref, expiresAt)
    const kinds = (await pg.store.listEntries(ref, { limit: 100 })).entries.map((entry) => entry.type)
    expect(kinds).toEqual(['grant'])
  })

  /** With nothing due, an activation pass leaves the stored balance alone, whatever it holds. */
  it('leaves the stored balance as it is when no grant is due (W-ad-9)', async () => {
    const ref = freshRef()
    const grant = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n }))
    await pg.prisma.$executeRawUnsafe(`UPDATE "ai_wallets" SET "balanceNanoUsd" = 130 WHERE "id" = '${grant.walletId}'`)
    expect(await pg.store.conditionalDebit(ref, debitEntry(200n, { idempotencyKey: 'd' }), 0n)).toBeNull()
    expect(await balanceColumn(grant.walletId)).toBe(130n)
  })
})

describe('wallet debit: the burn order and the clock the store is handed', () => {
  /** A store opened with the priority order burns the lower priority first, though the other grant expires sooner. */
  it('burns in the order the store was opened with (I-cd-2)', async () => {
    const ref = freshRef()
    const store = new PrismaAiTokensStore(pg.prisma, { burnOrder: 'priority' })
    const lowPriority = await store.appendEntry(ref, grantEntry({ idempotencyKey: 'p0', amountNanoUsd: 100n, priority: 0, expiresAt: new Date('2099-06-01T00:00:00.000Z') }))
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'p9', amountNanoUsd: 100n, priority: 9, expiresAt: new Date('2099-01-01T00:00:00.000Z') }))
    const debit = (await store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'd' }), 0n))!
    expect(await allocationsOf(debit.id)).toEqual({ [lowPriority.id]: 10n })
  })

  /** The buckets of a balance breakdown come in the order the store burns, and the breakdown says the instant it was read at. */
  it('lists the buckets in the store’s burn order and carries the instant asked about (I-bb-16, I-bb-17)', async () => {
    const ref = freshRef()
    const store = new PrismaAiTokensStore(pg.prisma, { burnOrder: 'priority' })
    const lowPriority = await store.appendEntry(ref, grantEntry({ idempotencyKey: 'p0', amountNanoUsd: 100n, priority: 0, expiresAt: new Date('2099-06-01T00:00:00.000Z') }))
    const highPriority = await store.appendEntry(ref, grantEntry({ idempotencyKey: 'p9', amountNanoUsd: 100n, priority: 9, expiresAt: new Date('2099-01-01T00:00:00.000Z') }))
    const asOf = new Date('2030-01-01T00:00:00.000Z')
    const breakdown = await store.balanceBreakdown(ref, asOf)
    expect(breakdown.buckets.map((bucket) => bucket.grantEntryId)).toEqual([lowPriority.id, highPriority.id])
    expect(breakdown.asOf).toEqual(asOf)
  })

  /** A refund keyed in the namespace the library writes its own activation and expiry entries under is refused, not stored. */
  it('refuses a refund keyed in the library’s reserved namespace (I-rs-37)', async () => {
    const ref = freshRef()
    const { debit } = await debited(ref, 10n, 'u-1')
    const body = await bodyOf(pg.store.refundToSource!(ref, { entry: refundOf(5n, 'expiry:forged', 'u-1'), debitEntryId: debit.id, now: new Date() }))
    expect(body).toContain(REFUSED)
    expect((await pg.store.listEntries(ref, { limit: 100 })).entries.filter((entry) => entry.type === 'refund')).toEqual([])
  })

  /** A debit judged at a clock before the sooner-expiring grant is effective burns the other grant, the one open at that clock. */
  it('burns the grants open at the clock it is handed (I-cd-5)', async () => {
    const ref = freshRef()
    const hour = 3_600_000
    const open = await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'open', amountNanoUsd: 100n, effectiveAt: new Date(Date.now() - 3 * hour), expiresAt: new Date('2099-06-01T00:00:00.000Z') }))
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'later', amountNanoUsd: 100n, effectiveAt: new Date(Date.now() - hour), expiresAt: new Date('2099-01-01T00:00:00.000Z') }))
    const debit = (await pg.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'd' }), 0n, new Date(Date.now() - 2 * hour)))!
    expect(await allocationsOf(debit.id)).toEqual({ [open.id]: 10n })
  })
})
