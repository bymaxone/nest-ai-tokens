/**
 * @fileoverview The wallet statements that build a query of their own: the open grants of a wallet in burn order, and the
 * debits of every wallet whose key has one of a set of prefixes (the sweep of orphan debits). Text columns of the debit
 * listing are compared in the byte order of the `C` collation in the keyset and the sort alike, so a page boundary falls
 * where the in-memory store's own ordering says whatever the database's collation is.
 * @layer prisma
 */

import type { WalletDebit, WalletDebitQuery } from '../server'
import { CREDITED_SQL, GRANT_REMAINING_JOINED_SQL, GRANT_REMAINING_JOIN_SQL, clockSql, mapWalletEntryRow, type WalletEntryRow } from './adapter-sql'
import { sql, type Sql } from './sql'

/** The open-grants query (credited, remaining > 0, effective and not expired at `now`) ordered per burn order. */
export function openGrantsSql(walletId: string, order: 'expiry' | 'priority' | 'fifo', now?: Date): Sql {
  const orderBy =
    order === 'priority'
      ? sql`g."priority" ASC, g."createdAt" ASC, g."id" ASC`
      : order === 'fifo'
        ? sql`g."createdAt" ASC, g."id" ASC`
        : sql`g."expiresAt" ASC NULLS LAST, g."createdAt" ASC, g."id" ASC`
  return sql`
    SELECT g.*, ${GRANT_REMAINING_JOINED_SQL}::bigint AS "remaining"
    FROM "ai_wallet_entries" g ${GRANT_REMAINING_JOIN_SQL}
    WHERE g."walletId" = ${walletId} AND g."type" = 'grant' AND ${CREDITED_SQL}
      AND g."effectiveAt" <= ${clockSql(now)} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${clockSql(now)})
      AND ${GRANT_REMAINING_JOINED_SQL} > 0
    ORDER BY ${orderBy}
  `
}

/** A debit row with the wallet it belongs to. */
export interface WalletDebitRow extends WalletEntryRow {
  walletTenantId: string
  walletOwnerType: string
  walletOwnerId: string
}

/** The debits created inside the bounds whose key starts with one of the prefixes, oldest first, after the cursor. */
export function walletDebitsSql(query: WalletDebitQuery): Sql {
  // The length is cast: Prisma 6 binds a JavaScript number as bigint, and `left(text, bigint)` does not exist.
  const keyed = query.keyPrefixes.map((prefix) => sql`left(e."idempotencyKey", ${prefix.length}::int) = ${prefix}`).reduce((all, one) => sql`${all} OR ${one}`, sql`FALSE`)
  const newer = query.newerThan === undefined ? sql`TRUE` : sql`e."createdAt" >= ${query.newerThan}`
  const after = query.after === undefined ? sql`TRUE` : sql`(e."createdAt", e."id" COLLATE "C") > (${query.after.createdAt}, ${query.after.id}::text COLLATE "C")`
  return sql`
    SELECT e.*, w."tenantId" AS "walletTenantId", w."ownerType" AS "walletOwnerType", w."ownerId" AS "walletOwnerId"
    FROM "ai_wallet_entries" e JOIN "ai_wallets" w ON w."id" = e."walletId"
    WHERE e."type" = 'debit' AND (${keyed}) AND e."createdAt" < ${query.olderThan} AND ${newer} AND ${after}
    ORDER BY e."createdAt" ASC, e."id" COLLATE "C" ASC
    LIMIT ${query.limit}
  `
}

/** A row of the debit listing as the debit with its wallet. */
export function mapWalletDebitRow(row: WalletDebitRow): WalletDebit {
  return { ref: { tenantId: row.walletTenantId, ownerType: row.walletOwnerType as WalletDebit['ref']['ownerType'], ownerId: row.walletOwnerId }, entry: mapWalletEntryRow(row) }
}
