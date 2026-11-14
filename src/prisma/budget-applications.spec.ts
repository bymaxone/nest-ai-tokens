/**
 * @fileoverview Unit tests for the keyed budget movements of the Prisma store: which statements run, in which order,
 * and what each outcome is, over a client that answers each statement from a script. What the statements do against
 * PostgreSQL, and how concurrent attempts are serialized, is covered by the end-to-end suite.
 * @layer prisma
 */

import { BudgetApplications } from './budget-applications'
import { SqlClient, type PrismaRawClient, type RawExecutor } from './raw-client'

const WINDOW = new Date('2026-06-01T00:00:00.000Z')
const OTHER_WINDOW = new Date('2026-07-01T00:00:00.000Z')
const REFERENCE = { key: 'k1', budgetId: 'b1', attempt: 'attempt-1' }
const DELTA = { nanoUsd: 10n, tokens: 4, count: 1 }
/** The state of an active application that moved `DELTA` in `WINDOW`. */
const ACTIVE = { windowStart: WINDOW, spentNanoUsd: 10n, spentTokens: 4n, spentCount: 1, unappliedAt: null }

/** What a scripted client answers to a statement, chosen by a fragment of its text; the first match wins. */
type Script = [fragment: string, rows: unknown[][]][]

/**
 * A client that records the statements it runs and answers them from a script. Each entry lists the rows of its
 * successive answers; the last answer repeats, and no rows answer a statement nothing matches.
 */
function scripted(script: Script): { applications: BudgetApplications; ran: string[]; rolledBack: () => boolean } {
  const ran: string[] = []
  const counts = new Map<string, number>()
  let rolledBack = false
  const executor: RawExecutor = {
    $queryRawUnsafe: <T>(text: string) => {
      ran.push(text)
      const entry = script.find(([fragment]) => text.includes(fragment))
      if (entry === undefined) return Promise.resolve([] as T)
      const seen = counts.get(entry[0]) ?? 0
      counts.set(entry[0], seen + 1)
      return Promise.resolve((entry[1][Math.min(seen, entry[1].length - 1)] ?? []) as T)
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
  return ran.map((text) => (/(INSERT INTO "\w+"|UPDATE "\w+"|DELETE FROM "\w+"|SELECT "windowStart"|SELECT 1)/.exec(text) ?? [text])[0])
}

const RECORD = 'INSERT INTO "ai_budget_applications"'
const LOCK = 'FOR UPDATE'
const TAKE = 'INSERT INTO "ai_budget_references"'
const WINDOW_ROW = 'INSERT INTO "ai_budget_windows"'
const CONSUME = 'UPDATE "ai_budget_windows"'

describe('BudgetApplications.consume', () => {
  /** The attempt that records the application takes its reference, creates the window row and consumes it, in that order. */
  it('records the application, takes the reference, ensures the window and consumes it', async () => {
    const { applications, ran } = scripted([[RECORD, [[{ key: 'k1' }]]], [CONSUME, [[{ id: 'w' }]]]])
    expect(await applications.consume(REFERENCE, WINDOW, DELTA, { nanoUsd: 100n })).toBe('applied')
    expect(kinds(ran)).toEqual([RECORD, TAKE, WINDOW_ROW, CONSUME])
  })

  /** An attempt that finds an active application with its own window and delta takes a reference and moves nothing. */
  it('replays without touching the window when the application is active with the same window and delta', async () => {
    const { applications, ran } = scripted([[LOCK, [[ACTIVE]]]])
    expect(await applications.consume(REFERENCE, WINDOW, DELTA, {})).toBe('replayed')
    expect(kinds(ran)).toEqual([RECORD, 'SELECT "windowStart"', TAKE])
  })

  /** An active application recorded with another amount or in another window names another call: nothing moves and no reference is taken. */
  it.each([
    { name: 'cost', stored: { ...ACTIVE, spentNanoUsd: 11n }, window: WINDOW },
    { name: 'tokens', stored: { ...ACTIVE, spentTokens: 5n }, window: WINDOW },
    { name: 'count', stored: { ...ACTIVE, spentCount: 2 }, window: WINDOW },
    { name: 'window', stored: ACTIVE, window: OTHER_WINDOW },
  ])('answers a mismatch when the active application differs in $name', async ({ stored, window }) => {
    const { applications, ran } = scripted([[LOCK, [[stored]]]])
    expect(await applications.consume(REFERENCE, window, DELTA, {})).toBe('mismatch')
    expect(kinds(ran)).toEqual([RECORD, 'SELECT "windowStart"'])
  })

  /** An application given back between the insert and the lock is taken over again by re-running the insert. */
  it('re-runs the insert when the application was given back meanwhile', async () => {
    const { applications, ran } = scripted([
      [RECORD, [[], [{ key: 'k1' }]]],
      [LOCK, [[{ ...ACTIVE, unappliedAt: new Date() }]]],
      [CONSUME, [[{ id: 'w' }]]],
    ])
    expect(await applications.consume(REFERENCE, WINDOW, DELTA, {})).toBe('applied')
    expect(kinds(ran)).toEqual([RECORD, 'SELECT "windowStart"', RECORD, TAKE, WINDOW_ROW, CONSUME])
  })

  /** An application that is not found after the insert is retried, and fails loudly after the attempts are spent. */
  it('fails after the attempts to take an application that keeps changing', async () => {
    const { applications, ran } = scripted([[LOCK, [[]]]])
    await expect(applications.consume(REFERENCE, WINDOW, DELTA, {})).rejects.toThrow('kept changing while it was taken')
    expect(ran.filter((text) => text.includes(RECORD))).toHaveLength(3)
  })

  /** A limit that refuses the consume rolls the whole transaction back, the application and the reference with it. */
  it('refuses, and rolls back the transaction, when a limit stops the consume', async () => {
    const { applications, rolledBack } = scripted([[RECORD, [[{ key: 'k1' }]]]])
    expect(await applications.consume(REFERENCE, WINDOW, DELTA, { nanoUsd: 1n })).toBe('refused')
    expect(rolledBack()).toBe(true)
  })

  /** A failure that is not a refusal reaches the caller unchanged. */
  it('lets a database failure through', async () => {
    const failure = new Error('connection lost')
    const failing: RawExecutor = { $queryRawUnsafe: () => Promise.reject(failure), $executeRawUnsafe: () => Promise.reject(failure) }
    const client: PrismaRawClient = { ...failing, $transaction: (fn) => fn(failing) }
    await expect(new BudgetApplications(new SqlClient(client)).consume(REFERENCE, WINDOW, DELTA, {})).rejects.toBe(failure)
  })
})

describe('BudgetApplications.adjust', () => {
  /** The attempt that records the application takes its reference and moves the window without a limit. */
  it('records the application, takes the reference and adjusts the window', async () => {
    const { applications, ran } = scripted([[RECORD, [[{ key: 'k1' }]]]])
    expect(await applications.adjust(REFERENCE, WINDOW, DELTA)).toBe('applied')
    expect(kinds(ran)).toEqual([RECORD, TAKE, WINDOW_ROW, CONSUME])
  })

  /** An active application with the same window and delta moves nothing; with another it names another call. */
  it('replays when the active application matches and refuses a mismatch', async () => {
    const same = scripted([[LOCK, [[ACTIVE]]]])
    expect(await same.applications.adjust(REFERENCE, WINDOW, DELTA)).toBe('replayed')
    const other = scripted([[LOCK, [[{ ...ACTIVE, spentNanoUsd: 99n }]]]])
    expect(await other.applications.adjust(REFERENCE, WINDOW, DELTA)).toBe('mismatch')
  })
})

describe('BudgetApplications.commit', () => {
  /** The attempt's reference becomes the committed one when no attempt of the call holds that name yet. */
  it("renames the attempt's reference to the committed name", async () => {
    const { applications, ran } = scripted([[LOCK, [[ACTIVE]]], ['UPDATE "ai_budget_references"', [[{ attempt: 'row' }]]]])
    expect(await applications.commit(REFERENCE)).toBe('committed')
    expect(kinds(ran)).toEqual(['SELECT "windowStart"', 'SELECT 1', 'UPDATE "ai_budget_references"'])
  })

  /** When another attempt of the call already holds the committed name, the attempt's own reference is dropped. */
  it("drops the attempt's reference when the committed name is already held", async () => {
    const { applications, ran } = scripted([[LOCK, [[ACTIVE]]], ['SELECT 1', [[{ held: 1 }]]]])
    expect(await applications.commit(REFERENCE)).toBe('already')
    expect(kinds(ran)).toEqual(['SELECT "windowStart"', 'SELECT 1', 'DELETE FROM "ai_budget_references"'])
  })

  /** An attempt that is itself the committed reference deletes nothing. */
  it('leaves the committed reference alone when it is the one committing', async () => {
    const { applications, ran } = scripted([[LOCK, [[ACTIVE]]], ['SELECT 1', [[{ held: 1 }]]]])
    expect(await applications.commit({ ...REFERENCE, attempt: 'row' })).toBe('already')
    expect(kinds(ran)).toEqual(['SELECT "windowStart"', 'SELECT 1'])
  })

  /** An attempt whose reference was reclaimed finds nothing to rename; an application never recorded is absent. */
  it("answers 'gone' for a reclaimed reference and 'absent' for no application", async () => {
    expect(await scripted([[LOCK, [[ACTIVE]]]]).applications.commit(REFERENCE)).toBe('gone')
    expect(await scripted([]).applications.commit(REFERENCE)).toBe('absent')
  })
})

describe('BudgetApplications.drop', () => {
  /** The last reference going gives the movement back: its stored delta is subtracted from the window it moved. */
  it('subtracts the stored delta from the stored window when the last reference is dropped', async () => {
    const stored = { windowStart: OTHER_WINDOW, spentNanoUsd: 30n, spentTokens: 7n, spentCount: 2, unappliedAt: null }
    const ran: { text: string; values: unknown[] }[] = []
    const executor: RawExecutor = {
      $queryRawUnsafe: <T>(text: string, ...values: unknown[]) => {
        ran.push({ text, values })
        if (text.includes('FOR UPDATE')) return Promise.resolve([stored] as T)
        if (text.includes('DELETE FROM "ai_budget_references"')) return Promise.resolve([{ attempt: 'attempt-1' }] as T)
        if (text.includes('UPDATE "ai_budget_applications"')) return Promise.resolve([stored] as T)
        return Promise.resolve([] as T)
      },
      $executeRawUnsafe: (text: string, ...values: unknown[]) => {
        ran.push({ text, values })
        return Promise.resolve(1)
      },
    }
    const client: PrismaRawClient = { ...executor, $transaction: (fn) => fn(executor) }
    expect(await new BudgetApplications(new SqlClient(client)).drop(REFERENCE)).toBe('unapplied')
    const adjust = ran.find((call) => call.text.includes('GREATEST'))!
    expect(adjust.values).toEqual([-30n, -7n, -2, 'b1', OTHER_WINDOW.toISOString()])
    expect(ran.find((call) => call.text.includes(WINDOW_ROW))!.values).toContain(OTHER_WINDOW.toISOString())
  })

  /** Another reference on the application keeps the movement in place. */
  it('keeps the movement when another reference remains', async () => {
    const { applications, ran } = scripted([[LOCK, [[ACTIVE]]], ['DELETE FROM "ai_budget_references"', [[{ attempt: 'attempt-1' }]]], ['SELECT 1', [[{ held: 1 }]]]])
    expect(await applications.drop(REFERENCE)).toBe('kept')
    expect(kinds(ran)).toEqual(['SELECT "windowStart"', 'DELETE FROM "ai_budget_references"', 'SELECT 1'])
  })

  /** An application that was already given back keeps nothing to give back again. */
  it('keeps an application that was given back before', async () => {
    const { applications, ran } = scripted([[LOCK, [[{ ...ACTIVE, unappliedAt: new Date() }]]], ['DELETE FROM "ai_budget_references"', [[{ attempt: 'attempt-1' }]]]])
    expect(await applications.drop(REFERENCE)).toBe('kept')
    expect(kinds(ran)).toEqual(['SELECT "windowStart"', 'DELETE FROM "ai_budget_references"'])
  })

  /** An application that lost its last reference to a concurrent give-back moves nothing here. */
  it('keeps the movement when it was given back concurrently', async () => {
    const { applications } = scripted([[LOCK, [[ACTIVE]]], ['DELETE FROM "ai_budget_references"', [[{ attempt: 'attempt-1' }]]]])
    expect(await applications.drop(REFERENCE)).toBe('kept')
  })

  /** No reference of the attempt is 'missing', and no application at all is 'absent'. */
  it("answers 'missing' for an attempt that holds no reference and 'absent' for no application", async () => {
    expect(await scripted([[LOCK, [[ACTIVE]]]]).applications.drop(REFERENCE)).toBe('missing')
    expect(await scripted([]).applications.drop(REFERENCE)).toBe('absent')
  })
})
