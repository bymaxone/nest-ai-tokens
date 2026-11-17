/**
 * @fileoverview The statements that move a budget window and record who holds the movement: the conditional consume of
 * spec §10.8, the signed adjust, the keyed application rows that make a movement happen once, and the references that
 * attempts hold on them. Pure builders of parameterized SQL; what runs them, and in which order, is `budget-applications.ts`.
 * @layer prisma
 */

import { randomUUID } from 'node:crypto'
import type { BudgetApplication, BudgetDelta, BudgetLimits, BudgetReference, StaleReferenceQuery } from '../server'
import type { MeteringScope } from '../shared'
import { COMMITTED_REFERENCE, RESERVE_KEY_PREFIX } from '../server/utils/budget-references'
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

/**
 * A page of the references that are older than a bound, each with the window and delta of its application, in the order
 * `(createdAt, key, budgetId, attempt)`. The text columns are compared in the byte order of the `C` collation, in the
 * keyset and in the sort alike, so that a page boundary falls where the store's own ordering says whatever the database's
 * collation is.
 */
export function staleReferencesSql(query: StaleReferenceQuery): Sql {
  const wanted =
    query.selection === 'attempt'
      ? sql`r."attempt" <> ${COMMITTED_REFERENCE}`
      : query.selection === 'retained'
        ? sql`r."attempt" = ${COMMITTED_REFERENCE}`
        : sql`r."attempt" = ${COMMITTED_REFERENCE} AND left(r."key", ${RESERVE_KEY_PREFIX.length}::int) = ${RESERVE_KEY_PREFIX}`
  const after =
    query.after === undefined
      ? sql`TRUE`
      : sql`(r."createdAt", r."key" COLLATE "C", r."budgetId" COLLATE "C", r."attempt" COLLATE "C") > (${query.after.createdAt}, ${query.after.key}::text COLLATE "C", ${query.after.budgetId}::text COLLATE "C", ${query.after.attempt}::text COLLATE "C")`
  return sql`
    SELECT r."key", r."budgetId", r."attempt", r."createdAt", b."tenantId", a."windowStart", a."spentNanoUsd", a."spentTokens", a."spentCount"
    FROM "ai_budget_references" r JOIN "ai_budget_applications" a ON a."key" = r."key" AND a."budgetId" = r."budgetId"
    JOIN "ai_budgets" b ON b."id" = r."budgetId"
    WHERE r."createdAt" < ${query.olderThan} AND ${wanted} AND ${after}
    ORDER BY r."createdAt" ASC, r."key" COLLATE "C" ASC, r."budgetId" COLLATE "C" ASC, r."attempt" COLLATE "C" ASC
    LIMIT ${query.limit}
  `
}

/**
 * Delete an application, and its references with it, when every reference left on it is the committed one and it is older
 * than `before`. The caller holds the application's row lock, so no attempt takes a reference between the check and the
 * delete. `RETURNING` is empty when nothing was deleted.
 */
export function pruneApplicationSql(application: BudgetApplication, before: Date): Sql {
  return sql`
    DELETE FROM "ai_budget_applications" a
    WHERE a."key" = ${application.key} AND a."budgetId" = ${application.budgetId} AND a."createdAt" < ${before}
      AND NOT EXISTS (SELECT 1 FROM "ai_budget_references" r WHERE r."key" = a."key" AND r."budgetId" = a."budgetId" AND r."attempt" <> ${COMMITTED_REFERENCE})
    RETURNING a."key"
  `
}

/**
 * Delete up to `limit` applications that were given back before `before`, oldest first. The outer condition repeats the
 * test, so an application that a retry re-activated between the listing and the delete is not deleted.
 */
export function pruneGivenBackSql(before: Date, limit: number): Sql {
  return sql`
    DELETE FROM "ai_budget_applications"
    WHERE ("key", "budgetId") IN (SELECT "key", "budgetId" FROM "ai_budget_applications" WHERE "unappliedAt" < ${before} ORDER BY "unappliedAt" ASC LIMIT ${limit})
      AND "unappliedAt" < ${before}
    RETURNING "key"
  `
}

/**
 * `pruneGivenBackSql` for the applications of every tenant except the named ones. The tenant is the budget's, a NOT NULL
 * column, so no application has an unknown tenant for the comparison to leave out. The array is cast to `text[]` because the
 * client binds an empty one without a type, and an empty one spares nobody.
 */
export function pruneGivenBackExceptSql(before: Date, limit: number, exceptTenants: string[]): Sql {
  const spared = sql`b."tenantId" <> ALL(${exceptTenants}::text[])`
  return sql`
    DELETE FROM "ai_budget_applications"
    WHERE ("key", "budgetId") IN (
      SELECT a."key", a."budgetId" FROM "ai_budget_applications" a JOIN "ai_budgets" b ON b."id" = a."budgetId"
      WHERE a."unappliedAt" < ${before} AND ${spared} ORDER BY a."unappliedAt" ASC LIMIT ${limit})
      AND "unappliedAt" < ${before}
    RETURNING "key"
  `
}

/** Delete the windows of a budget the tenant owns. */
export function removeBudgetWindowsSql(budgetId: string, tenantId: string): Sql {
  return sql`DELETE FROM "ai_budget_windows" WHERE "budgetId" IN (SELECT "id" FROM "ai_budgets" WHERE "id" = ${budgetId} AND "tenantId" = ${tenantId})`
}

/** Delete a budget the tenant owns. */
export function removeBudgetSql(budgetId: string, tenantId: string): Sql {
  return sql`DELETE FROM "ai_budgets" WHERE "id" = ${budgetId} AND "tenantId" = ${tenantId}`
}

/** One budget of a tenant by id. */
export function findBudgetSql(budgetId: string, tenantId: string): Sql {
  return sql`SELECT * FROM "ai_budgets" WHERE "id" = ${budgetId} AND "tenantId" = ${tenantId} LIMIT 1`
}

/** The budgets of a tenant scoped to the exact scope or tenant-wide, and not expired at `now`. */
export function matchingBudgetsSql(tenantId: string, scope: MeteringScope, now: Date): Sql {
  return sql`
    SELECT * FROM "ai_budgets"
    WHERE "tenantId" = ${tenantId}
      AND ("scopeType" = 'tenant' OR ("scopeType" = ${scope.type} AND "scopeId" = ${scope.id}))
      AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
  `
}

/** One window row of a budget. */
export function windowSql(budgetId: string, windowStart: Date): Sql {
  return sql`SELECT * FROM "ai_budget_windows" WHERE "budgetId" = ${budgetId} AND "windowStart" = ${windowStart} LIMIT 1`
}

/** Start a window of a budget the tenant owns at zero, or reset it to zero. */
export function resetWindowSql(budgetId: string, tenantId: string, windowStart: Date): Sql {
  return sql`
    INSERT INTO "ai_budget_windows" ("id", "budgetId", "windowStart", "spentNanoUsd", "spentTokens", "spentCount", "updatedAt")
    SELECT ${randomUUID()}, "id", ${windowStart}, 0, 0, 0, ${DB_NOW_SQL} FROM "ai_budgets" WHERE "id" = ${budgetId} AND "tenantId" = ${tenantId}
    ON CONFLICT ("budgetId", "windowStart") DO UPDATE SET "spentNanoUsd" = 0, "spentTokens" = 0, "spentCount" = 0, "updatedAt" = ${DB_NOW_SQL}
  `
}
