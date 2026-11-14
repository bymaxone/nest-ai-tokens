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
/** The state of an active application that moved `DELTA`. */
const STORED = { spentNanoUsd: 10n, spentTokens: 4n, spentCount: 1, unappliedAt: null }

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
  return ran.map((text) => (/(INSERT INTO "\w+"|UPDATE "\w+"|SELECT "spentNanoUsd")/.exec(text) ?? [text])[0])
}

describe('BudgetApplications.consume', () => {
  /** The attempt that records the application creates the window row and consumes it, in that order. */
  it('records the application, ensures the window and consumes it', async () => {
    const { applications, ran } = scripted([['INSERT INTO "ai_budget_applications"', [{ key: 'k1' }]], ['UPDATE "ai_budget_windows"', [{ id: 'w' }]]])
    expect(await applications.consume(APPLICATION, WINDOW, DELTA, { nanoUsd: 100n })).toBe('applied')
    expect(kinds(ran)).toEqual(['INSERT INTO "ai_budget_applications"', 'INSERT INTO "ai_budget_windows"', 'UPDATE "ai_budget_windows"'])
  })

  /** An attempt that finds an active application with its own delta moves nothing: only the insert and the read run. */
  it('replays without touching the window when the application is active with the same delta', async () => {
    const { applications, ran } = scripted([['FROM "ai_budget_applications"', [STORED]]])
    expect(await applications.consume(APPLICATION, WINDOW, DELTA, {})).toBe('replayed')
    expect(kinds(ran)).toEqual(['INSERT INTO "ai_budget_applications"', 'SELECT "spentNanoUsd"'])
  })

  /** An active application recorded with another amount names another call: nothing moves, and each dimension is compared. */
  it.each([
    { name: 'cost', stored: { ...STORED, spentNanoUsd: 11n } },
    { name: 'tokens', stored: { ...STORED, spentTokens: 5n } },
    { name: 'count', stored: { ...STORED, spentCount: 2 } },
  ])('answers a mismatch when the active application differs in $name', async ({ stored }) => {
    const { applications, ran } = scripted([['FROM "ai_budget_applications"', [stored]]])
    expect(await applications.consume(APPLICATION, WINDOW, DELTA, {})).toBe('mismatch')
    expect(kinds(ran)).toEqual(['INSERT INTO "ai_budget_applications"', 'SELECT "spentNanoUsd"'])
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

  /** An active application with the same delta moves nothing; with another it names another call. */
  it('replays when the active application has the same delta and refuses a mismatch', async () => {
    const same = scripted([['FROM "ai_budget_applications"', [STORED]]])
    expect(await same.applications.adjust(APPLICATION, WINDOW, DELTA)).toBe('replayed')
    expect(kinds(same.ran)).toEqual(['INSERT INTO "ai_budget_applications"', 'SELECT "spentNanoUsd"'])
    const other = scripted([['FROM "ai_budget_applications"', [{ ...STORED, spentNanoUsd: 99n }]]])
    expect(await other.applications.adjust(APPLICATION, WINDOW, DELTA)).toBe('mismatch')
  })

  /** A replay whose stored row vanished between the insert and the read is not the same call either. */
  it('answers a mismatch when the active application cannot be read', async () => {
    expect(await scripted([]).applications.adjust(APPLICATION, WINDOW, DELTA)).toBe('mismatch')
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

  /** A row given back before is 'already', an active row of another owner is 'foreign', no row at all is 'absent'. */
  it("answers 'already', 'foreign' and 'absent' for a row that was not given back now", async () => {
    const already = scripted([['FROM "ai_budget_applications"', [{ ...STORED, unappliedAt: new Date() }]]])
    expect(await already.applications.unapply(APPLICATION)).toBe('already')
    expect(kinds(already.ran)).toEqual(['UPDATE "ai_budget_applications"', 'SELECT "spentNanoUsd"'])
    const foreign = scripted([['FROM "ai_budget_applications"', [{ ...STORED, unappliedAt: null }]]])
    expect(await foreign.applications.unapply({ ...APPLICATION, owner: 'another' })).toBe('foreign')
    expect(await scripted([]).applications.unapply(APPLICATION)).toBe('absent')
  })
})
