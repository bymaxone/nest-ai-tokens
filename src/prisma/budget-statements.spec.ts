/**
 * @fileoverview Unit tests for the statements that move a budget window and record who moved it: the text each builds
 * and the order of the values bound to it. What a statement does against PostgreSQL is covered by the end-to-end suite.
 * @layer prisma
 */

import {
  adjustWindowSql,
  anyReferenceSql,
  deleteReferenceSql,
  lockApplicationSql,
  referenceHeldSql,
  renameReferenceSql,
  takeReferenceSql,
  consumeWindowSql,
  ensureWindowSql,
  recordApplicationSql,
  unapplySql,
} from './budget-statements'
import { DB_NOW_SQL } from './adapter-sql'

const WINDOW = new Date('2026-06-01T00:00:00.000Z')
const DELTA = { nanoUsd: 10n, tokens: 4, count: 1 }
const APPLICATION = { key: 'k1', budgetId: 'b1' }
const REFERENCE = { ...APPLICATION, attempt: 'attempt-1' }

describe('window statements', () => {
  /** The zeroed row is created once, and a window that exists is left as it is. */
  it('creates a window row on first touch and leaves an existing one alone', () => {
    const statement = ensureWindowSql('b1', WINDOW)
    expect(statement.text).toContain('INSERT INTO "ai_budget_windows"')
    expect(statement.text).toContain('ON CONFLICT ("budgetId", "windowStart") DO NOTHING')
    expect(statement.values.slice(1)).toEqual(['b1', WINDOW])
  })

  /** Every limited dimension is checked in the same statement that moves it; an absent limit binds null. */
  it('consumes a window only within every limit, binding an absent limit as null', () => {
    const statement = consumeWindowSql('b1', WINDOW, DELTA, { nanoUsd: 100n, tokens: 50, count: 3 })
    expect(statement.text).toContain('"spentNanoUsd" + $')
    expect(statement.text).toContain('RETURNING "id"')
    expect(statement.values).toEqual([10n, 4n, 1, 'b1', WINDOW, 100n, 10n, 100n, 50n, 4n, 50n, 3, 1, 3])
    expect(consumeWindowSql('b1', WINDOW, DELTA, {}).values.slice(5)).toEqual([null, 10n, null, null, 4n, null, null, 1, null])
  })

  /** A signed move floors each dimension at zero and stamps the update on the database clock. */
  it('adjusts a window by a signed delta, flooring each dimension at zero', () => {
    const statement = adjustWindowSql('b1', WINDOW, { nanoUsd: -10n, tokens: -4, count: -1 })
    expect(statement.text.match(/GREATEST\(0,/g)).toHaveLength(3)
    expect(statement.text).toContain(`"updatedAt" = ${DB_NOW_SQL.text}`)
    expect(statement.values).toEqual([-10n, -4n, -1, 'b1', WINDOW])
  })
})

describe('application statements', () => {
  /** The primary key serializes concurrent attempts, and only a given-back application is taken over. */
  it('records an application, taking over only one that was given back', () => {
    const statement = recordApplicationSql(APPLICATION, WINDOW, DELTA)
    expect(statement.text).toContain('INSERT INTO "ai_budget_applications"')
    expect(statement.text).toContain('ON CONFLICT ("key", "budgetId") DO UPDATE')
    expect(statement.text).toContain('WHERE "ai_budget_applications"."unappliedAt" IS NOT NULL')
    expect(statement.text).toContain('"unappliedAt" = NULL')
    expect(statement.text).toContain('RETURNING "key"')
    expect(statement.text).toContain(DB_NOW_SQL.text)
    expect(statement.values).toEqual(['k1', 'b1', WINDOW, 10n, 4n, 1])
  })

  /** An application is read with its row locked, so a take, a commit and a drop of it never interleave. */
  it('reads an application with its row locked', () => {
    const statement = lockApplicationSql(APPLICATION)
    expect(statement.text).toContain('SELECT "windowStart", "spentNanoUsd", "spentTokens", "spentCount", "unappliedAt"')
    expect(statement.text).toContain('FROM "ai_budget_applications"')
    expect(statement.text).toContain('FOR UPDATE')
    expect(statement.values).toEqual(['k1', 'b1'])
  })

  /** Taking a reference twice is the same as once. */
  it('takes a reference once per attempt', () => {
    const statement = takeReferenceSql(REFERENCE)
    expect(statement.text).toContain('INSERT INTO "ai_budget_references"')
    expect(statement.text).toContain('ON CONFLICT ("key", "budgetId", "attempt") DO NOTHING')
    expect(statement.text).toContain(DB_NOW_SQL.text)
    expect(statement.values).toEqual(['k1', 'b1', 'attempt-1'])
  })

  /** A reference is looked up by its name, and any reference of an application by the application alone. */
  it('reads whether a reference, or any reference, is held', () => {
    const named = referenceHeldSql(APPLICATION, 'row')
    expect(named.text).toContain('FROM "ai_budget_references"')
    expect(named.text).toContain('"attempt" = $3')
    expect(named.values).toEqual(['k1', 'b1', 'row'])
    const any = anyReferenceSql(APPLICATION)
    expect(any.text).toContain('FROM "ai_budget_references"')
    expect(any.text).toContain('LIMIT 1')
    expect(any.text).not.toContain('"attempt"')
    expect(any.values).toEqual(['k1', 'b1'])
  })

  /** A reference is renamed or deleted by its attempt, and nothing is returned when the attempt holds none. */
  it('renames and deletes the reference of one attempt', () => {
    const rename = renameReferenceSql(REFERENCE, 'row')
    expect(rename.text).toContain('UPDATE "ai_budget_references" SET "attempt" = $1')
    expect(rename.text).toContain('RETURNING "attempt"')
    expect(rename.values).toEqual(['row', 'k1', 'b1', 'attempt-1'])
    const remove = deleteReferenceSql(REFERENCE)
    expect(remove.text).toContain('DELETE FROM "ai_budget_references"')
    expect(remove.text).toContain('RETURNING "attempt"')
    expect(remove.values).toEqual(['k1', 'b1', 'attempt-1'])
  })

  /** Giving back marks only an active application and returns what it moved. */
  it('gives back an active application and returns what it moved', () => {
    const statement = unapplySql(APPLICATION)
    expect(statement.text).toContain('UPDATE "ai_budget_applications" SET "unappliedAt"')
    expect(statement.text).toContain('"unappliedAt" IS NULL')
    expect(statement.text).toContain('RETURNING "windowStart", "spentNanoUsd", "spentTokens", "spentCount"')
    expect(statement.values).toEqual(['k1', 'b1'])
  })
})
