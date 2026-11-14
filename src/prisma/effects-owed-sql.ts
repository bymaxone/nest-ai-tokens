/**
 * @fileoverview The SQL of the effects-owed marker (migration 0003): the table `ai_usage_effects_owed` holds one row per
 * ledger row whose effects have not run, beside the ledger and not in it, so the ledger table keeps no mutable column
 * besides the annotation of a reversal. The marker is written by the same statement as the write it belongs to, through a
 * data-modifying `WITH` that wraps the insert or the update of the usage row, so a crash can never separate the two. The
 * sweep reads the marker joined to its row, and clearing it is a delete.
 * @layer prisma
 */

import type { OwedEffects, OwedEffectsMarker } from '../server'
import { DB_NOW_SQL, mapUsageRow, type UsageRow } from './adapter-sql'
import { sql, type Sql } from './sql'

/**
 * Wrap an `INSERT` or an `UPDATE` of a usage row that ends in `RETURNING *` so that the marker is written by the same
 * statement. Both common table expressions run to completion: the marker row exists exactly when the write took effect,
 * and a write that matched no row, such as a transition from the wrong state, leaves no marker. Without a marker the
 * statement is returned as it is.
 *
 * @param write The usage-row statement, ending in `RETURNING *`.
 * @param owed The marker, or `undefined` when the write owes no effects.
 */
export function withMarkerSql(write: Sql, owed?: OwedEffectsMarker): Sql {
  if (owed === undefined) return write
  return sql`
    WITH written AS (${write}),
    marked AS (
      INSERT INTO "ai_usage_effects_owed" ("recordId", "tenantId", "owedAt", "reservedBilledNanoUsd", "reservedTokens", "reason")
      SELECT "id", "tenantId", ${DB_NOW_SQL}, ${owed.reservedBilledNanoUsd ?? null}, ${owed.reservedTokens ?? null}, ${owed.reason ?? null} FROM written
    )
    SELECT * FROM written
  `
}

/** The rows whose marker is older than a cutoff, oldest first, with what the marker kept (the sweep's query). */
export function effectsOwedSql(olderThan: Date, limit: number): Sql {
  return sql`
    SELECT r.*, o."reservedBilledNanoUsd" AS "owedReservedBilledNanoUsd", o."reservedTokens" AS "owedReservedTokens", o."reason" AS "owedReason"
    FROM "ai_usage_effects_owed" o JOIN "ai_usage_records" r ON r."id" = o."recordId"
    WHERE o."owedAt" < ${olderThan}
    ORDER BY o."owedAt" ASC, o."recordId" ASC LIMIT ${limit}
  `
}

/** The marker of one row with what it kept, joined to its row (a reversal reads it to settle the original first). */
export function effectsOwedForSql(id: string): Sql {
  return sql`
    SELECT r.*, o."reservedBilledNanoUsd" AS "owedReservedBilledNanoUsd", o."reservedTokens" AS "owedReservedTokens", o."reason" AS "owedReason"
    FROM "ai_usage_effects_owed" o JOIN "ai_usage_records" r ON r."id" = o."recordId"
    WHERE o."recordId" = ${id}
  `
}

/** Clear the marker of one row; returns the id when the row had one, nothing otherwise (so a repeat reports `false`). */
export function clearEffectsOwedSql(id: string): Sql {
  return sql`DELETE FROM "ai_usage_effects_owed" WHERE "recordId" = ${id} RETURNING "recordId"`
}

/** A row read by the sweep's query as the owed row with the values its marker kept. */
export function mapOwedRow(row: UsageRow): OwedEffects {
  return {
    record: mapUsageRow(row),
    ...(row.owedReservedBilledNanoUsd === null || row.owedReservedBilledNanoUsd === undefined ? {} : { reservedBilledNanoUsd: row.owedReservedBilledNanoUsd }),
    ...(row.owedReservedTokens === null || row.owedReservedTokens === undefined ? {} : { reservedTokens: row.owedReservedTokens }),
    ...(row.owedReason === null || row.owedReason === undefined ? {} : { reason: row.owedReason }),
  }
}
