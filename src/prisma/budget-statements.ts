/**
 * @fileoverview The statements that move a budget window, and the ones that record who moved it: the conditional
 * consume of spec §10.8, the signed adjust, and the keyed application rows that make a movement happen once. Pure
 * builders of parameterized SQL, split out of `adapter-sql.ts` to keep that file within its length limit.
 * @layer prisma
 */

import { randomUUID } from 'node:crypto'
import type { BudgetApplication, BudgetDelta, BudgetLimits } from '../server'
import { DB_NOW_SQL } from './adapter-sql'
import { sql, type Sql } from './sql'

/** The statement that creates a window's zeroed row on first touch. */
export function ensureWindowSql(budgetId: string, windowStart: Date): Sql {
  return sql`
    INSERT INTO "ai_budget_windows" ("id", "budgetId", "windowStart", "spentNanoUsd", "spentTokens", "spentCount", "updatedAt")
    VALUES (${randomUUID()}, ${budgetId}, ${windowStart}, 0, 0, 0, ${DB_NOW_SQL})
    ON CONFLICT ("budgetId", "windowStart") DO NOTHING
  `
}

/**
 * The conditional consume of a window (spec §10.8): every limited dimension must stay within its limit or the row
 * does not move, and `RETURNING` is empty. An absent limit is unlimited.
 */
export function consumeWindowSql(budgetId: string, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Sql {
  const limitTokens = limits.tokens === undefined ? null : BigInt(limits.tokens)
  return sql`
    UPDATE "ai_budget_windows"
    SET "spentNanoUsd" = "spentNanoUsd" + ${delta.nanoUsd},
        "spentTokens" = "spentTokens" + ${BigInt(delta.tokens)},
        "spentCount" = "spentCount" + ${delta.count},
        "updatedAt" = ${DB_NOW_SQL}
    WHERE "budgetId" = ${budgetId} AND "windowStart" = ${windowStart}
      AND (${limits.nanoUsd ?? null}::bigint IS NULL OR "spentNanoUsd" + ${delta.nanoUsd} <= ${limits.nanoUsd ?? null})
      AND (${limitTokens}::bigint IS NULL OR "spentTokens" + ${BigInt(delta.tokens)} <= ${limitTokens})
      AND (${limits.count ?? null}::int IS NULL OR "spentCount" + ${delta.count} <= ${limits.count ?? null})
    RETURNING "id"
  `
}

/** The signed move of a window, each dimension floored at zero. */
export function adjustWindowSql(budgetId: string, windowStart: Date, delta: BudgetDelta): Sql {
  return sql`
    UPDATE "ai_budget_windows"
    SET "spentNanoUsd" = GREATEST(0, "spentNanoUsd" + ${delta.nanoUsd}),
        "spentTokens" = GREATEST(0, "spentTokens" + ${BigInt(delta.tokens)}),
        "spentCount" = GREATEST(0, "spentCount" + ${delta.count}),
        "updatedAt" = ${DB_NOW_SQL}
    WHERE "budgetId" = ${budgetId} AND "windowStart" = ${windowStart}
  `
}

/**
 * Record an application, or take over one that was given back. The primary key is the single point where concurrent
 * attempts with one application are serialized: a second insert waits for the first, then finds an active row and
 * returns nothing. `RETURNING` is empty exactly when an active application already exists.
 */
export function recordApplicationSql(application: BudgetApplication, windowStart: Date, delta: BudgetDelta): Sql {
  return sql`
    INSERT INTO "ai_budget_applications" ("key", "budgetId", "windowStart", "spentNanoUsd", "spentTokens", "spentCount", "unappliedAt", "createdAt")
    VALUES (${application.key}, ${application.budgetId}, ${windowStart}, ${delta.nanoUsd}, ${BigInt(delta.tokens)}, ${delta.count}, NULL, ${DB_NOW_SQL})
    ON CONFLICT ("key", "budgetId") DO UPDATE
      SET "windowStart" = EXCLUDED."windowStart", "spentNanoUsd" = EXCLUDED."spentNanoUsd", "spentTokens" = EXCLUDED."spentTokens",
          "spentCount" = EXCLUDED."spentCount", "unappliedAt" = NULL, "createdAt" = EXCLUDED."createdAt"
      WHERE "ai_budget_applications"."unappliedAt" IS NOT NULL
    RETURNING "key"
  `
}

/** Mark an active application given back and return what it moved; empty when it is absent or already given back. */
export function unapplySql(application: BudgetApplication): Sql {
  return sql`
    UPDATE "ai_budget_applications" SET "unappliedAt" = ${DB_NOW_SQL}
    WHERE "key" = ${application.key} AND "budgetId" = ${application.budgetId} AND "unappliedAt" IS NULL
    RETURNING "windowStart", "spentNanoUsd", "spentTokens", "spentCount"
  `
}

/** Whether an application, given back or not, was ever recorded. */
export function applicationExistsSql(application: BudgetApplication): Sql {
  return sql`SELECT 1 AS "found" FROM "ai_budget_applications" WHERE "key" = ${application.key} AND "budgetId" = ${application.budgetId}`
}
