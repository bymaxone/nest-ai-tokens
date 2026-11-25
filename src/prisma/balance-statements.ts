/**
 * @fileoverview The statements that answer what a wallet could spend at an instant. Each is ONE statement, so one snapshot: the balance column
 * and the grants it is read against cannot disagree because a debit committed between two reads. The predicates are those of the conditional
 * debit: the materialized balance, less the credited grants not effective yet and the credited grants expired at the instant, plus the
 * grants due at the instant that no activation has credited yet.
 * @layer prisma
 */

import {
  CREDITED_SQL,
  GRANT_REMAINING_JOINED_SQL,
  GRANT_REMAINING_JOIN_SQL,
  clockSql,
} from './adapter-sql'
import { sql, type Sql } from './sql'

/** The balance a debit at `asOf` could spend, over the outer `w` alias. */
function spendableAtSql(asOf: Date): Sql {
  return sql`(
    w."balanceNanoUsd"
    - (
      SELECT COALESCE(SUM(GREATEST(${GRANT_REMAINING_JOINED_SQL}, 0)), 0)
      FROM "ai_wallet_entries" g ${GRANT_REMAINING_JOIN_SQL}
      WHERE g."walletId" = w."id" AND g."type" = 'grant' AND ${CREDITED_SQL}
        AND ((g."effectiveAt" > ${clockSql(asOf)} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${clockSql(asOf)}))
          OR (g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${clockSql(asOf)}))
    )
    + (
      SELECT COALESCE(SUM(g."amountNanoUsd"), 0)
      FROM "ai_wallet_entries" g
      WHERE g."walletId" = w."id" AND g."type" = 'grant' AND NOT ${CREDITED_SQL}
        AND g."effectiveAt" <= ${clockSql(asOf)} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${clockSql(asOf)})
    )
  )::bigint`
}

/** The spendable balance of the wallet `walletId` at `asOf`: one row, one column, `balance`. */
export function balanceAtSql(walletId: string, asOf: Date): Sql {
  return sql`SELECT ${spendableAtSql(asOf)} AS "balance" FROM "ai_wallets" w WHERE w."id" = ${walletId}`
}

/** A row of {@link balanceBreakdownSql}: the `total` row carries the balance, a `bucket` row one grant that still holds value. */
export interface BreakdownRow {
  kind: 'total' | 'bucket'
  id: string | null
  remaining: bigint | null
  priority: number | null
  expiresAt: Date | null
  reason: string | null
  total: bigint | null
}

/**
 * The spendable balance of `walletId` at `asOf` and the grants that hold it, in one statement: the `total` row, then a `bucket` row per grant effective and not
 * expired at `asOf` with a remainder, credited or not, in the burn order of the store. The `rank` column orders the buckets and is not read.
 */
export function balanceBreakdownSql(walletId: string, asOf: Date, order: 'expiry' | 'priority' | 'fifo'): Sql {
  const orderBy =
    order === 'priority'
      ? sql`"priority" ASC, "createdAt" ASC, "id" ASC`
      : order === 'fifo'
        ? sql`"createdAt" ASC, "id" ASC`
        : sql`"expiresAt" ASC NULLS LAST, "createdAt" ASC, "id" ASC`
  return sql`
    SELECT "kind", "id", "remaining", "priority", "expiresAt", "reason", "total" FROM (
      SELECT 0 AS "rank", 'total' AS "kind", NULL::text AS "id", NULL::bigint AS "remaining", NULL::int AS "priority", NULL::timestamp AS "expiresAt",
             NULL::text AS "reason", ${spendableAtSql(asOf)} AS "total", NULL::timestamp AS "createdAt"
      FROM "ai_wallets" w WHERE w."id" = ${walletId}
      UNION ALL
      SELECT 1, 'bucket', g."id", ${GRANT_REMAINING_JOINED_SQL}::bigint, g."priority", g."expiresAt", g."reason", NULL::bigint, g."createdAt"
      FROM "ai_wallet_entries" g ${GRANT_REMAINING_JOIN_SQL}
      WHERE g."walletId" = ${walletId} AND g."type" = 'grant'
        AND g."effectiveAt" <= ${clockSql(asOf)} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${clockSql(asOf)})
        AND ${GRANT_REMAINING_JOINED_SQL} > 0
    ) b
    ORDER BY "rank" ASC, ${orderBy}
  `
}
