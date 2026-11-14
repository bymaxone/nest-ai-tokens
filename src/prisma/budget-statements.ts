/**
 * @fileoverview The statements that move a budget window and record who holds the movement: the conditional consume of
 * spec §10.8, the signed adjust, the keyed application rows that make a movement happen once, and the references that
 * attempts hold on them. Pure builders of parameterized SQL; what runs them, and in which order, is `budget-applications.ts`.
 * @layer prisma
 */

import { randomUUID } from 'node:crypto'
import type { BudgetApplication, BudgetDelta, BudgetLimits, BudgetReference } from '../server'
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

/**
 * What an application holds, with its row locked until the transaction ends: the window and delta it moved and whether it
 * was given back. A take, a commit and a drop of one application all lock it first, so they never interleave.
 */
export function lockApplicationSql(application: BudgetApplication): Sql {
  return sql`
    SELECT "windowStart", "spentNanoUsd", "spentTokens", "spentCount", "unappliedAt"
    FROM "ai_budget_applications" WHERE "key" = ${application.key} AND "budgetId" = ${application.budgetId} FOR UPDATE
  `
}

/** Take a reference for an attempt; taking it twice is the same as once. */
export function takeReferenceSql(reference: BudgetReference): Sql {
  return sql`
    INSERT INTO "ai_budget_references" ("key", "budgetId", "attempt", "createdAt")
    VALUES (${reference.key}, ${reference.budgetId}, ${reference.attempt}, ${DB_NOW_SQL})
    ON CONFLICT ("key", "budgetId", "attempt") DO NOTHING
  `
}

/** Whether an application is held under a reference name. */
export function referenceHeldSql(application: BudgetApplication, attempt: string): Sql {
  return sql`SELECT 1 AS "held" FROM "ai_budget_references" WHERE "key" = ${application.key} AND "budgetId" = ${application.budgetId} AND "attempt" = ${attempt}`
}

/** Rename an attempt's reference to the committed name; `RETURNING` is empty when the attempt holds none. */
export function renameReferenceSql(reference: BudgetReference, committed: string): Sql {
  return sql`
    UPDATE "ai_budget_references" SET "attempt" = ${committed}
    WHERE "key" = ${reference.key} AND "budgetId" = ${reference.budgetId} AND "attempt" = ${reference.attempt}
    RETURNING "attempt"
  `
}

/** Delete an attempt's reference; `RETURNING` is empty when the attempt holds none. */
export function deleteReferenceSql(reference: BudgetReference): Sql {
  return sql`
    DELETE FROM "ai_budget_references"
    WHERE "key" = ${reference.key} AND "budgetId" = ${reference.budgetId} AND "attempt" = ${reference.attempt}
    RETURNING "attempt"
  `
}

/** Whether any reference is left on an application. */
export function anyReferenceSql(application: BudgetApplication): Sql {
  return sql`SELECT 1 AS "held" FROM "ai_budget_references" WHERE "key" = ${application.key} AND "budgetId" = ${application.budgetId} LIMIT 1`
}

/** Mark an application given back and return what it moved. */
export function unapplySql(application: BudgetApplication): Sql {
  return sql`
    UPDATE "ai_budget_applications" SET "unappliedAt" = ${DB_NOW_SQL}
    WHERE "key" = ${application.key} AND "budgetId" = ${application.budgetId} AND "unappliedAt" IS NULL
    RETURNING "windowStart", "spentNanoUsd", "spentTokens", "spentCount"
  `
}
