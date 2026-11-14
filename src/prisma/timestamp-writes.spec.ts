/**
 * @fileoverview Structural pin: the store writes every timestamp column itself, on the UTC clock.
 *
 * The timestamp columns are `TIMESTAMP` without a zone, and a column left to `DEFAULT CURRENT_TIMESTAMP`
 * takes the zone of the database session, so on a database east or west of UTC it no longer agrees with
 * the instants the application writes and compares against. The rule is pinned over the SQL text itself:
 * a new insert, or a new column, that leaves a timestamp to the default fails here.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUDGET_COLUMNS, PRICE_COLUMNS, USAGE_COLUMNS } from './adapter-sql'

const SRC = join(__dirname)
const sources = ['index.ts', 'adapter-sql.ts', 'budget-statements.ts'].map((file) => ({
  file,
  text: readFileSync(join(SRC, file), 'utf8'),
}))
const adapterText = readFileSync(join(SRC, 'adapter-sql.ts'), 'utf8')
const migration = readFileSync(join(SRC, 'migrations/0001_init.sql'), 'utf8')

/** The columns of each table declared `DEFAULT CURRENT_TIMESTAMP` in the shipped migration. */
function defaultedTimestampColumns(): Map<string, string[]> {
  const byTable = new Map<string, string[]>()
  for (const block of migration.split('CREATE TABLE ').slice(1)) {
    const table = (/^"([a-z_]+)"/.exec(block)!)[1]!
    const columns = [...block.matchAll(/^\s+"(\w+)"\s+TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/gm)].map((m) => m[1]!)
    byTable.set(table, columns)
  }
  return byTable
}

/** The column list an `INSERT INTO "table" (...)` names, resolving the shared column constants. */
function insertedColumns(list: string): string[] {
  const constants: Record<string, readonly string[]> = {
    USAGE_COLUMNS_SQL: USAGE_COLUMNS,
    BUDGET_COLUMNS_SQL: BUDGET_COLUMNS,
    PRICE_COLUMNS_SQL: PRICE_COLUMNS,
  }
  const reference = /^\$\{(\w+)\}$/.exec(list.trim())?.[1]
  if (reference !== undefined) return [...(constants[reference]!)]
  return [...list.matchAll(/"(\w+)"/g)].map((m) => m[1]!)
}

describe('timestamp writes', () => {
  it('leaves CURRENT_TIMESTAMP to one place, the UTC expression', () => {
    // Why: a bare CURRENT_TIMESTAMP in a write lands in the session zone.
    for (const { text } of sources) {
      const uses = text.split('\n').filter((line) => line.includes('CURRENT_TIMESTAMP') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      expect(uses).toEqual(text.includes("export const DB_NOW_SQL") ? [expect.stringContaining('export const DB_NOW_SQL')] : [])
    }
  })

  it('names every defaulted timestamp column in every insert', () => {
    // Why: a column left out of an insert takes DEFAULT CURRENT_TIMESTAMP, which is the session zone.
    const defaulted = defaultedTimestampColumns()
    const seen: string[] = []
    for (const { text } of sources) {
      for (const match of text.matchAll(/INSERT INTO "(ai_\w+)" \(([^)]*)\)/g)) {
        const table = match[1]!
        const columns = insertedColumns(match[2]!)
        seen.push(table)
        for (const column of defaulted.get(table) ?? []) {
          expect({ table, column, written: columns.includes(column) }).toEqual({ table, column, written: true })
        }
      }
    }
    // The pin must have looked at the tables that matter, not at nothing.
    expect(new Set(seen)).toEqual(
      new Set(['ai_usage_records', 'ai_model_prices', 'ai_wallets', 'ai_wallet_entries', 'ai_wallet_debit_allocations', 'ai_budgets', 'ai_budget_windows', 'ai_budget_applications']),
    )
  })

  it('leaves every timestamp of the budget applications to be written, never defaulted', () => {
    // Why: the application row is written through the UTC expression only, so a column that took a default would be written in the session zone.
    const applications = readFileSync(join(SRC, 'migrations/0002_budget_applications.sql'), 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
    expect(applications).not.toContain('CURRENT_TIMESTAMP')
  })

  it('stamps updatedAt on every update of a table that has it', () => {
    // Why: an UPDATE that leaves updatedAt alone is harmless; one that sets it must use the UTC expression.
    const defaulted = defaultedTimestampColumns()
    let checked = 0
    for (const { text } of sources) {
      for (const match of text.matchAll(/UPDATE "(ai_\w+)"(?:\s+\w+)?\s+SET([\s\S]*?)(?:WHERE|RETURNING|`)/g)) {
        if (!(defaulted.get(match[1]!) ?? []).includes('updatedAt')) continue
        checked += 1
        // The usage-record transition takes its SET clause from `statusAssignments`, pinned below.
        const assignments = (match[2]!).includes('${assignments}')
        expect({ table: match[1], stamped: assignments || (match[2]!).includes('"updatedAt" = ${DB_NOW_SQL}') }).toEqual({
          table: match[1],
          stamped: true,
        })
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7)
    expect(adapterText).toContain('sql`"policy" = ${input.policy}`, sql`"updatedAt" = ${DB_NOW_SQL}`')
    expect(adapterText).toContain('sql`"status" = ${to}`, sql`"updatedAt" = ${DB_NOW_SQL}`')
  })

  it('writes createdAt and updatedAt of a budget, and never rewrites createdAt on conflict', () => {
    // Why: the budget window anchors on createdAt, so it is the column that mattered.
    expect(BUDGET_COLUMNS.slice(-2)).toEqual(['createdAt', 'updatedAt'])
    const adapter = adapterText
    expect(adapter).not.toMatch(/"createdAt" = \$\{/)
  })
})
