/**
 * @fileoverview Unit tests for the keyed budget movements of the Prisma store: which statements run, in which order,
 * and what each outcome is, over a client that answers each statement from a script. What the statements do against
 * PostgreSQL, and how concurrent attempts are serialized, is covered by the end-to-end suite.
 * @layer prisma
 */

import { BudgetApplications } from './budget-applications'
import { SqlClient, type PrismaRawClient, type RawExecutor } from './raw-client'

const WINDOW = new Date('2026-06-01T00:00:00.000Z')
const APPLICATION = { key: 'k1', budgetId: 'b1' }
const DELTA = { nanoUsd: 10n, tokens: 4, count: 1 }

/** What a scripted client answers to a statement, chosen by a fragment of its text; the first match wins. */
type Script = [fragment: string, rows: unknown[]][]

/** A client that records the statements it runs and answers them from a script (no rows when nothing matches). */
function scripted(script: Script): { applications: BudgetApplications; ran: string[]; rolledBack: () => boolean } {
  const ran: string[] = []
  let rolledBack = false
  const executor: RawExecutor = {
    $queryRawUnsafe: <T>(text: string) => {
      ran.push(text)
      return Promise.resolve((script.find(([fragment]) => text.includes(fragment))?.[1] ?? []) as T)
    },
    $executeRawUnsafe: (text: string) => {
      ran.push(text)
      return Promise.resolve(1)
    },
  }
  const client: PrismaRawClient = {
    ...executor,
    $transaction: async (fn) => {
      try {
        return await fn(executor)
      } catch (error) {
        rolledBack = true
        throw error
      }
    },
  }
  return { applications: new BudgetApplications(new SqlClient(client)), ran, rolledBack: () => rolledBack }
}

/** The leading words of each recorded statement, for comparing the order. */
function kinds(ran: string[]): string[] {
  return ran.map((text) => (/(INSERT INTO "\w+"|UPDATE "\w+"|SELECT 1)/.exec(text) ?? [text])[0])
}

describe('BudgetApplications.consume', () => {
  /** The attempt that records the application creates the window row and consumes it, in that order. */
  it('records the application, ensures the window and consumes it', async () => {
    const { applications, ran } = scripted([['INSERT INTO "ai_budget_applications"', [{ key: 'k1' }]], ['UPDATE "ai_budget_windows"', [{ id: 'w' }]]])
    expect(await applications.consume(APPLICATION, WINDOW, DELTA, { nanoUsd: 100n })).toBe('applied')
    expect(kinds(ran)).toEqual(['INSERT INTO "ai_budget_applications"', 'INSERT INTO "ai_budget_windows"', 'UPDATE "ai_budget_windows"'])
  })

  /** An attempt that finds an active application moves nothing: only the insert runs. */
  it('replays without touching the window when the application is active', async () => {
    const { applications, ran } = scripted([])
    expect(await applications.consume(APPLICATION, WINDOW, DELTA, {})).toBe('replayed')
    expect(kinds(ran)).toEqual(['INSERT INTO "ai_budget_applications"'])
  })

  /** A limit that refuses the consume rolls the whole transaction back, the application with it. */
  it('refuses, and rolls back the transaction, when a limit stops the consume', async () => {
    const { applications, rolledBack } = scripted([['INSERT INTO "ai_budget_applications"', [{ key: 'k1' }]]])
    expect(await applications.consume(APPLICATION, WINDOW, DELTA, { nanoUsd: 1n })).toBe('refused')
    expect(rolledBack()).toBe(true)
  })

  /** A failure that is not a refusal reaches the caller unchanged. */
  it('lets a database failure through', async () => {
    const failure = new Error('connection lost')
    const client: PrismaRawClient = {
      $queryRawUnsafe: () => Promise.reject(failure),
      $executeRawUnsafe: () => Promise.reject(failure),
      $transaction: (fn) => fn({ $queryRawUnsafe: () => Promise.reject(failure), $executeRawUnsafe: () => Promise.reject(failure) }),
    }
    await expect(new BudgetApplications(new SqlClient(client)).consume(APPLICATION, WINDOW, DELTA, {})).rejects.toBe(failure)
  })
})

describe('BudgetApplications.adjust', () => {
  /** The attempt that records the application moves the window without a limit. */
  it('records the application and adjusts the window', async () => {
    const { applications, ran } = scripted([['INSERT INTO "ai_budget_applications"', [{ key: 'k1' }]]])
    expect(await applications.adjust(APPLICATION, WINDOW, DELTA)).toBe('applied')
    expect(kinds(ran)).toEqual(['INSERT INTO "ai_budget_applications"', 'INSERT INTO "ai_budget_windows"', 'UPDATE "ai_budget_windows"'])
  })

  /** An active application moves nothing. */
  it('replays without touching the window when the application is active', async () => {
    const { applications, ran } = scripted([])
    expect(await applications.adjust(APPLICATION, WINDOW, DELTA)).toBe('replayed')
    expect(kinds(ran)).toEqual(['INSERT INTO "ai_budget_applications"'])
  })
})

describe('BudgetApplications.unapply', () => {
  /** An active application is given back: its stored delta is subtracted from the window it moved. */
  it('subtracts the stored delta from the stored window', async () => {
    const stored = { windowStart: new Date('2026-05-01T00:00:00.000Z'), spentNanoUsd: 30n, spentTokens: 7n, spentCount: 2 }
    const ran: { text: string; values: unknown[] }[] = []
    const executor: RawExecutor = {
      $queryRawUnsafe: <T>(text: string, ...values: unknown[]) => {
        ran.push({ text, values })
        return Promise.resolve((text.includes('UPDATE "ai_budget_applications"') ? [stored] : []) as T)
      },
      $executeRawUnsafe: (text: string, ...values: unknown[]) => {
        ran.push({ text, values })
        return Promise.resolve(1)
      },
    }
    const client: PrismaRawClient = { ...executor, $transaction: (fn) => fn(executor) }
    expect(await new BudgetApplications(new SqlClient(client)).unapply(APPLICATION)).toBe('unapplied')
    const adjust = ran.find((call) => call.text.includes('GREATEST'))!
    expect(adjust.values).toEqual([-30n, -7n, -2, 'b1', stored.windowStart.toISOString()])
    expect(ran.find((call) => call.text.includes('INSERT INTO "ai_budget_windows"'))!.values).toContain(stored.windowStart.toISOString())
  })

  /** A row that exists but is no longer active was given back before; no row at all was never recorded. */
  it("answers 'already' for a row given back before and 'absent' for none", async () => {
    const already = scripted([['SELECT 1', [{ found: 1 }]]])
    expect(await already.applications.unapply(APPLICATION)).toBe('already')
    expect(kinds(already.ran)).toEqual(['UPDATE "ai_budget_applications"', 'SELECT 1'])
    expect(await scripted([]).applications.unapply(APPLICATION)).toBe('absent')
  })
})
