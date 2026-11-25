/**
 * @fileoverview The budget half of the adapter's row handling: the stored form of a budget window, the mappers from a budget row and a
 * window row to the canonical shapes, and the column list, values and conflict assignments of a budget upsert. The row shapes and the
 * helpers the budget half shares with the ledger and wallet halves live in `./adapter-sql`.
 * @layer prisma
 */

import type { Budget, BudgetWindowKind, MeteringScope } from '../shared'
import type { BudgetWindowSpend } from '../server'
import { identifiers, join, sql, type Sql } from './sql'
import { jsonText } from '../server/utils/json-text'
import { DB_NOW_SQL, bare, type BudgetRow, type BudgetWindowRow } from './adapter-sql'

/** Serialize a budget window kind to its stored text form. */
export function serializeWindow(window: BudgetWindowKind): string {
  return typeof window === 'object' ? `custom:${window.customSeconds.toString()}` : window
}

/** Parse a stored window text back to a {@link BudgetWindowKind}. */
export function parseWindow(value: string): BudgetWindowKind {
  if (value.startsWith('custom:')) return { customSeconds: Number(value.slice('custom:'.length)) }
  return value as 'day' | 'week' | 'month' | 'total'
}

/** Convert a `BudgetRow` to the canonical {@link Budget} (nulls → absent). */
export function mapBudgetRow(row: BudgetRow): Budget {
  return bare({
    id: row.id,
    tenantId: row.tenantId,
    scope: { type: row.scopeType as MeteringScope['type'], id: row.scopeId },
    ...(row.features.length > 0 ? { features: row.features } : {}),
    ...(row.limitNanoUsd !== null ? { limitNanoUsd: row.limitNanoUsd } : {}),
    ...(row.limitTokens !== null ? { limitTokens: Number(row.limitTokens) } : {}),
    ...(row.limitCount !== null ? { limitCount: row.limitCount } : {}),
    window: parseWindow(row.window),
    ...(row.anchorAt !== null ? { anchorAt: row.anchorAt } : {}),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
    softThresholds: row.softThresholds,
    policy: row.policy as Budget['policy'],
    createdAt: row.createdAt,
  })
}

/** Convert a `BudgetWindowRow` to a {@link BudgetWindowSpend}. */
export function mapBudgetWindowRow(row: BudgetWindowRow): BudgetWindowSpend {
  return { spentNanoUsd: row.spentNanoUsd, spentTokens: Number(row.spentTokens), spentCount: row.spentCount }
}

/** The ordered column list for a budget insert (identifiers are trusted constants). */
export const BUDGET_COLUMNS = [
  'id', 'tenantId', 'scopeType', 'scopeId', 'features', 'limitNanoUsd', 'limitTokens', 'limitCount',
  'window', 'anchorAt', 'expiresAt', 'softThresholds', 'policy', 'createdAt', 'updatedAt',
] as const

/** The identifier list for a budget insert. */
export const BUDGET_COLUMNS_SQL = identifiers(BUDGET_COLUMNS)

/** The nullable BigInt for a token limit (a `number` at the boundary). */
export function tokenLimitSql(limit: number | undefined): bigint | null {
  return limit === undefined ? null : BigInt(limit)
}

/** Build the ordered value fragments for a budget insert (aligned with {@link BUDGET_COLUMNS}). */
export function budgetValues(id: string, input: Omit<Budget, 'id' | 'createdAt'> & { createdAt?: Date }): Sql[] {
  return [
    sql`${id}`, sql`${input.tenantId}`, sql`${input.scope.type}`, sql`${input.scope.id}`,
    sql`${input.features ?? []}::text[]`, sql`${input.limitNanoUsd ?? null}`,
    sql`${tokenLimitSql(input.limitTokens)}`, sql`${input.limitCount ?? null}`,
    sql`${serializeWindow(input.window)}`, sql`${input.anchorAt ?? null}`, sql`${input.expiresAt ?? null}`,
    sql`${jsonText(input.softThresholds)}::jsonb`, sql`${input.policy}`,
    input.createdAt === undefined ? DB_NOW_SQL : sql`${input.createdAt}`, DB_NOW_SQL,
  ]
}

/** Build the `SET` clause for an upsert conflict (every mutable column + updatedAt). */
export function budgetUpdateAssignments(input: Omit<Budget, 'id' | 'createdAt'>): Sql {
  return join(
    [
      sql`"scopeType" = ${input.scope.type}`, sql`"scopeId" = ${input.scope.id}`,
      sql`"features" = ${input.features ?? []}::text[]`, sql`"limitNanoUsd" = ${input.limitNanoUsd ?? null}`,
      sql`"limitTokens" = ${tokenLimitSql(input.limitTokens)}`, sql`"limitCount" = ${input.limitCount ?? null}`,
      sql`"window" = ${serializeWindow(input.window)}`, sql`"anchorAt" = ${input.anchorAt ?? null}`,
      sql`"expiresAt" = ${input.expiresAt ?? null}`, sql`"softThresholds" = ${jsonText(input.softThresholds)}::jsonb`,
      sql`"policy" = ${input.policy}`, sql`"updatedAt" = ${DB_NOW_SQL}`,
    ],
    ', ',
  )
}
