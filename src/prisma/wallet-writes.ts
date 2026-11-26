/**
 * @fileoverview The statements `PrismaAiTokensStore` runs inside a wallet transaction: the wallet row and its lock, the entry and
 * allocation inserts, the activation and expiry sweeps, the burn-down of a debit across the open grants, and the pieces of a refund
 * to its source (the debit it restores, the room it has left, the grants it burned, the expired parts taken back out). Each takes
 * the transaction it runs in; none holds state. They run against PostgreSQL, so the end-to-end suites judge them.
 * @layer prisma
 */

import { randomUUID } from 'node:crypto'
import type { NewWalletEntry, WalletEntry, WalletRef } from '../shared'
import type { SqlExecutor } from './raw-client'
import { sql, type Sql } from './sql'
import { ACTIVATION_KEY_PREFIX, ACTIVATION_REASON, EXPIRY_KEY_PREFIX, activationKey, expiryKey } from '../server/utils/wallet-keys'
import {
  ACTIVATED_SQL,
  CREDITED_SQL,
  DB_NOW_SQL,
  DUE_AT_APPEND_SQL,
  GRANT_REMAINING_SQL,
  SIGNED_BALANCE_SQL,
  clockSql,
  firstOrThrow,
  mapWalletEntryRow,
  type OpenGrantRow,
  type WalletEntryRow,
  type WalletRow,
} from './adapter-sql'
import { openGrantsSql } from './wallet-statements'
import { reservedKeyHeld, sourceRefusal } from './wallet-refusals'

/** A grant a debit burned, with the amount it burned and the amount refunds already restored to it. */
export interface FundedAllocation {
  grantEntryId: string
  amountNanoUsd: bigint
  restored: bigint
  priority: number
  expiresAt: Date | null
}

/** The grants a debit burned, one row per grant with the total it burned and what refunds already restored to it, in the order the debit was split. */
export async function fundedAllocations(tx: SqlExecutor, debitId: string): Promise<FundedAllocation[]> {
  return tx.query<FundedAllocation[]>(sql`
        SELECT a."grantEntryId", SUM(a."amountNanoUsd")::bigint AS "amountNanoUsd", g."priority", g."expiresAt",
               COALESCE((SELECT -SUM(b."amountNanoUsd") FROM "ai_wallet_debit_allocations" b JOIN "ai_wallet_entries" r ON r."id" = b."debitEntryId"
                         WHERE b."grantEntryId" = a."grantEntryId" AND r."refundsEntryId" = ${debitId}), 0)::bigint AS "restored"
        FROM "ai_wallet_debit_allocations" a JOIN "ai_wallet_entries" g ON g."id" = a."grantEntryId"
        WHERE a."debitEntryId" = ${debitId}
        GROUP BY a."grantEntryId", g."id", g."priority", g."expiresAt", g."seq", g."createdAt"
        ORDER BY g."seq" ASC NULLS FIRST, g."createdAt" ASC, g."id" ASC
      `)
}

/** Takes a refund's part back out of each grant that has expired by the clock or that the sweep wrote off. */
export async function expireRestoredParts(tx: SqlExecutor, walletId: string, refundId: string, parts: readonly (FundedAllocation & { part: bigint })[], balanceAfterRefund: bigint, now: Date): Promise<void> {
  let running = balanceAfterRefund
  for (const grant of parts) {
    const part = grant.part
    // A grant that has expired by the clock, or that the sweep already wrote off, takes its part back out in an entry of its own: the refund
    // raised its remainder, and an expired grant's remainder is not spendable. The key is the refund's, never the sweep's.
    const swept = await tx.query<{ one: number }[]>(sql`SELECT 1 AS "one" FROM "ai_wallet_entries" WHERE "walletId" = ${walletId} AND "idempotencyKey" = ${expiryKey(grant.grantEntryId)} LIMIT 1`)
    if ((grant.expiresAt === null || grant.expiresAt > now) && swept[0] === undefined) continue
    running -= part
    const key = `${EXPIRY_KEY_PREFIX}refund:${refundId}:${grant.grantEntryId}`
    const expiry = await insertSystemEntry(tx, walletId, { type: 'expiry', amountNanoUsd: -part, priority: grant.priority, idempotencyKey: key, reason: 'refund restored an expired grant' }, running, now)
    if (expiry === undefined) throw reservedKeyHeld(walletId, key, grant.grantEntryId)
    await insertAllocations(tx, expiry.id, [{ grantEntryId: grant.grantEntryId, amountNanoUsd: part }])
    await applyBalanceDelta(tx, walletId, -part)
  }
}

/** The debit a refund to source restores: the one named by id, or the single debit of the wallet that carries the refund's usage id. */
export async function sourceDebit(tx: SqlExecutor, walletId: string, entry: NewWalletEntry, debitEntryId: string | undefined): Promise<WalletEntry> {
  if (debitEntryId !== undefined) {
    const found = await tx.query<WalletEntryRow[]>(sql`SELECT * FROM "ai_wallet_entries" WHERE "walletId" = ${walletId} AND "id" = ${debitEntryId} AND "type" = 'debit' LIMIT 1`)
    if (found[0] === undefined) throw sourceRefusal('the debit to restore is not a debit of this wallet')
    return mapWalletEntryRow(found[0])
  }
  if (entry.usageRecordId === undefined) throw sourceRefusal('a source refund names a debit by id or by usageRecordId')
  const found = await tx.query<WalletEntryRow[]>(sql`SELECT * FROM "ai_wallet_entries" WHERE "walletId" = ${walletId} AND "type" = 'debit' AND "usageRecordId" = ${entry.usageRecordId} LIMIT 2`)
  const [only] = found
  if (found.length !== 1 || only === undefined) throw sourceRefusal('the usageRecordId does not name exactly one debit of this wallet')
  return mapWalletEntryRow(only)
}

/**
 * What the debit still has room to take back, and the refusal when `amount` is above it. The room is what the debit took, less the refunds already
 * linked to it, less the refunds and positive adjustments of the wallet that carry its usage id and no link (a refund or adjustment written without a link).
 * @returns `available`: the room before the cap of unlinked credits, which is what the split weights sum to.
 */
export async function restorableOf(tx: SqlExecutor, walletId: string, debit: WalletEntry, amount: bigint): Promise<{ available: bigint }> {
  const linked = await tx.query<{ sum: bigint }[]>(sql`SELECT COALESCE(SUM("amountNanoUsd"), 0)::bigint AS "sum" FROM "ai_wallet_entries" WHERE "walletId" = ${walletId} AND "type" = 'refund' AND "refundsEntryId" = ${debit.id}`)
  const unlinked = debit.usageRecordId === undefined
    ? 0n
    : firstOrThrow(await tx.query<{ sum: bigint }[]>(sql`
        SELECT COALESCE(SUM("amountNanoUsd"), 0)::bigint AS "sum" FROM "ai_wallet_entries"
        WHERE "walletId" = ${walletId} AND "usageRecordId" = ${debit.usageRecordId} AND "refundsEntryId" IS NULL
          AND ("type" = 'refund' OR ("type" = 'adjustment' AND "amountNanoUsd" > 0 AND "idempotencyKey" NOT LIKE ${`${ACTIVATION_KEY_PREFIX}%`}))
      `)).sum
  const available = -debit.amountNanoUsd - firstOrThrow(linked).sum
  if (amount <= 0n || amount > available - unlinked) throw sourceRefusal('the refund is above what the debit has left to restore')
  return { available }
}

/** Load the wallet within a transaction (existence + id for the conditional debit). */
export async function getWalletWithin(tx: SqlExecutor, ref: WalletRef): Promise<WalletRow | undefined> {
  const rows = await tx.query<WalletRow[]>(sql`
    SELECT * FROM "ai_wallets"
    WHERE "tenantId" = ${ref.tenantId} AND "ownerType" = ${ref.ownerType} AND "ownerId" = ${ref.ownerId} LIMIT 1
  `)
  return rows[0]
}

/** Fetch or (optionally) create the wallet for a ref within a transaction. */
export async function ensureWallet(tx: SqlExecutor, ref: WalletRef, autoCreate: boolean): Promise<WalletRow | null> {
  const existing = await getWalletWithin(tx, ref)
  if (existing !== undefined) return existing
  if (!autoCreate) return null
  const rows = await tx.query<WalletRow[]>(sql`
    INSERT INTO "ai_wallets" ("id", "tenantId", "ownerType", "ownerId", "balanceNanoUsd", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${ref.tenantId}, ${ref.ownerType}, ${ref.ownerId}, 0, ${DB_NOW_SQL}, ${DB_NOW_SQL})
    ON CONFLICT ("tenantId", "ownerType", "ownerId") DO UPDATE SET "updatedAt" = "ai_wallets"."updatedAt" RETURNING *
  `)
  return firstOrThrow(rows)
}

/**
 * Insert a wallet entry, returning the stored row. The wallet row is locked by the caller: the statement takes the next sequence of the
 * wallet from it, so the sequence is the commit order, and the entry carries the balance the caller says it leaves.
 */
export async function insertWalletEntry(tx: SqlExecutor, walletId: string, entry: NewWalletEntry, balanceAfter: Sql, refundsEntryId?: string, effectiveAt: Sql = sql`${entry.effectiveAt}`): Promise<WalletEntry> {
  const rows = await tx.query<WalletEntryRow[]>(sql`
    WITH "n" AS (UPDATE "ai_wallets" SET "entrySeq" = "entrySeq" + 1, "updatedAt" = ${DB_NOW_SQL} WHERE "id" = ${walletId} RETURNING "entrySeq")
    INSERT INTO "ai_wallet_entries" ("id", "walletId", "type", "amountNanoUsd", "priority", "effectiveAt", "expiresAt", "usageRecordId", "idempotencyKey", "reason", "createdAt", "seq", "balanceAfterNanoUsd", "refundsEntryId")
    VALUES (${randomUUID()}, ${walletId}, ${entry.type}, ${entry.amountNanoUsd}, ${entry.priority}, ${effectiveAt}, ${entry.expiresAt ?? null}, ${entry.usageRecordId ?? null}, ${entry.idempotencyKey}, ${entry.reason ?? null}, ${DB_NOW_SQL}, (SELECT "entrySeq" FROM "n"), ${balanceAfter}, ${refundsEntryId ?? null})
    RETURNING *
  `)
  return mapWalletEntryRow(firstOrThrow(rows))
}

/** Insert the debit→grant allocation trail. */
export async function insertAllocations(
  tx: SqlExecutor,
  debitEntryId: string,
  allocations: { grantEntryId: string; amountNanoUsd: bigint }[],
): Promise<void> {
  for (const allocation of allocations) {
    await tx.execute(sql`
      INSERT INTO "ai_wallet_debit_allocations" ("id", "debitEntryId", "grantEntryId", "amountNanoUsd")
      VALUES (${randomUUID()}, ${debitEntryId}, ${allocation.grantEntryId}, ${allocation.amountNanoUsd})
    `)
  }
}

/** Apply a signed delta to the materialized balance. */
export async function applyBalanceDelta(tx: SqlExecutor, walletId: string, delta: bigint): Promise<void> {
  if (delta === 0n) return
  await tx.execute(sql`
    UPDATE "ai_wallets" SET "balanceNanoUsd" = "balanceNanoUsd" + ${delta}, "updatedAt" = ${DB_NOW_SQL} WHERE "id" = ${walletId}
  `)
}

/**
 * Serialize the debits, activations and sweeps of one wallet on its row.
 */
export async function lockWallet(tx: SqlExecutor, walletId: string): Promise<void> {
  await tx.query(sql`SELECT "id" FROM "ai_wallets" WHERE "id" = ${walletId} FOR UPDATE`)
}

/** Lock the wallet row, as {@link lockWallet} does, and read the balance it holds once the lock is taken. */
export async function lockedBalance(tx: SqlExecutor, walletId: string): Promise<bigint> {
  const rows = await tx.query<{ balanceNanoUsd: bigint }[]>(sql`SELECT "balanceNanoUsd" FROM "ai_wallets" WHERE "id" = ${walletId} FOR UPDATE`)
  return firstOrThrow(rows).balanceNanoUsd
}

/**
 * Insert a system entry (an activation or an expiry) effective at `now` and created on the database clock, once per
 * key. Returns the stored row, or `undefined` when the key already exists.
 */
export async function insertSystemEntry(
  tx: SqlExecutor,
  walletId: string,
  entry: { type: 'adjustment' | 'expiry'; amountNanoUsd: bigint; priority: number; idempotencyKey: string; reason: string },
  balanceAfter: bigint,
  now?: Date,
): Promise<WalletEntry | undefined> {
  const rows = await tx.query<WalletEntryRow[]>(sql`
    WITH "n" AS (UPDATE "ai_wallets" SET "entrySeq" = "entrySeq" + 1, "updatedAt" = ${DB_NOW_SQL} WHERE "id" = ${walletId} RETURNING "entrySeq")
    INSERT INTO "ai_wallet_entries" ("id", "walletId", "type", "amountNanoUsd", "priority", "effectiveAt", "expiresAt", "usageRecordId", "idempotencyKey", "reason", "createdAt", "seq", "balanceAfterNanoUsd", "refundsEntryId")
    VALUES (${randomUUID()}, ${walletId}, ${entry.type}, ${entry.amountNanoUsd}, ${entry.priority}, ${clockSql(now)}, NULL, NULL, ${entry.idempotencyKey}, ${entry.reason}, ${DB_NOW_SQL}, (SELECT "entrySeq" FROM "n"), ${balanceAfter}, NULL)
    ON CONFLICT ("walletId", "idempotencyKey") DO NOTHING
    RETURNING *
  `)
  return rows[0] === undefined ? undefined : mapWalletEntryRow(rows[0])
}

/**
 * Credit, once each, every grant that is now due, not credited yet and not expired: an `adjustment`
 * entry keyed `activate:<grantId>` records the credit, and the stored balance is then set to the signed
 * sum of the entries rather than incremented, so a balance that already counts a grant (as an earlier
 * `reconcile` left it) is not credited a second time. A grant that was due as it was appended,
 * judged on the stored `createdAt`, is credited by its own row and is not touched here.
 */
export async function activateDueGrants(tx: SqlExecutor, walletId: string, now?: Date): Promise<void> {
  const due = await tx.query<{ id: string; priority: number; amountNanoUsd: bigint }[]>(sql`
    SELECT g."id", g."priority", g."amountNanoUsd"
    FROM "ai_wallet_entries" g
    WHERE g."walletId" = ${walletId} AND g."type" = 'grant'
      AND NOT ${DUE_AT_APPEND_SQL}
      AND g."effectiveAt" <= ${clockSql(now)} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${clockSql(now)})
      AND NOT ${ACTIVATED_SQL}
  `)
  // The balance the activations are added to is the signed sum of the entries before them, which is what the balance is set to below:
  // a wallet whose column had drifted from the entries shows its correction as one jump, at the first entry written after.
  let running = due.length === 0 ? 0n : firstOrThrow(await tx.query<{ balance: bigint }[]>(sql`SELECT ${SIGNED_BALANCE_SQL}::bigint AS "balance" FROM "ai_wallets" w WHERE w."id" = ${walletId}`)).balance
  for (const grant of due) {
    running += grant.amountNanoUsd
    const activation = await insertSystemEntry(tx, walletId, {
      type: 'adjustment',
      amountNanoUsd: grant.amountNanoUsd,
      priority: grant.priority,
      idempotencyKey: activationKey(grant.id),
      reason: ACTIVATION_REASON,
    }, running, now)
    // The wallet row is locked and the grants listed are not activated by shape, so a taken key is an entry the
    // store did not write: crediting without the marker would credit the grant again at the next reconcile.
    if (activation === undefined) throw reservedKeyHeld(walletId, activationKey(grant.id), grant.id)
  }
  if (due.length === 0) return
  await tx.execute(sql`
    UPDATE "ai_wallets" w SET "balanceNanoUsd" = ${SIGNED_BALANCE_SQL}, "updatedAt" = ${DB_NOW_SQL} WHERE w."id" = ${walletId}
  `)
}

/** Write an `expiry` entry (with its allocation) for each credited, expired grant with a remainder. */
export async function sweepExpiredGrants(tx: SqlExecutor, walletId: string, now?: Date): Promise<void> {
  const grants = await tx.query<{ id: string; priority: number; remaining: bigint }[]>(sql`
    SELECT g."id", g."priority", ${GRANT_REMAINING_SQL}::bigint AS "remaining"
    FROM "ai_wallet_entries" g
    WHERE g."walletId" = ${walletId} AND g."type" = 'grant' AND ${CREDITED_SQL}
      AND g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${clockSql(now)}
  `)
  let running: bigint | undefined
  for (const grant of grants) {
    if (grant.remaining <= 0n) continue
    running ??= await lockedBalance(tx, walletId)
    running -= grant.remaining
    const expiry = await insertSystemEntry(tx, walletId, {
      type: 'expiry',
      amountNanoUsd: -grant.remaining,
      priority: grant.priority,
      idempotencyKey: expiryKey(grant.id),
      reason: 'grant expired',
    }, running, now)
    // The wallet row is locked and a swept grant has no remainder, so a taken key here is an entry
    // written outside the store under the reserved namespace. Skipping would keep the expired
    // credit spendable, so the debit is refused instead.
    if (expiry === undefined) throw reservedKeyHeld(walletId, expiryKey(grant.id), grant.id)
    await insertAllocations(tx, expiry.id, [{ grantEntryId: grant.id, amountNanoUsd: grant.remaining }])
    await applyBalanceDelta(tx, walletId, -grant.remaining)
  }
}

/** Greedily allocate a debit of `cost` across the open grants in burn order. */
export async function burnDown(tx: SqlExecutor, walletId: string, cost: bigint, order: 'expiry' | 'priority' | 'fifo', now?: Date): Promise<{ grantEntryId: string; amountNanoUsd: bigint }[]> {
  const grants = await tx.query<OpenGrantRow[]>(openGrantsSql(walletId, order, now))
  const trail: { grantEntryId: string; amountNanoUsd: bigint }[] = []
  let remaining = cost
  for (const grant of grants) {
    if (remaining <= 0n) break
    const take = grant.remaining < remaining ? grant.remaining : remaining
    trail.push({ grantEntryId: grant.id, amountNanoUsd: take })
    remaining -= take
  }
  return trail
}
