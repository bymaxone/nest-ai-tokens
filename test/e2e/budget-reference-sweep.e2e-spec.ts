/**
 * @fileoverview E2E: the budget-reference sweep against real PostgreSQL over two clients. A reference an attempt left
 * behind is given back once however many sweepers run at once, a reference of a committed call is renamed or left alone,
 * the window ends as a run in which nothing failed, and the record of an old movement is deleted without moving the window.
 * @layer test
 */

import type { MeteringScope } from '@bymax-one/nest-ai-tokens/shared'
import { BudgetReferenceSweeper } from '../../src/server/enforcement/budget-reference-sweeper'
import { bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, upsertBudget, type Booted, type PostgresFixture } from './harness'

const PAYER: MeteringScope = { type: 'user', id: 'u1' }
const HOUR = 3_600_000

let pg: PostgresFixture
let a: Booted
let b: Booted

beforeAll(async () => {
  pg = await startPostgres()
  a = await bootMeteringModule({ store: pg.store })
  b = await bootMeteringModule({ store: pg.storeB })
  await seedPrice(a.pricing)
  await grantWallet(a.wallets, 1_000_000_000_000n)
}, 240_000)

afterAll(async () => {
  await a.close()
  await b.close()
  await pg.stop()
})

/** A sweeper over one client whose clock is `ahead` milliseconds past the wall clock, so what was just written counts as old. */
function sweeper(which: 'a' | 'b', ahead: number): BudgetReferenceSweeper {
  const booted = which === 'a' ? a : b
  return new BudgetReferenceSweeper(which === 'a' ? pg.store : pg.storeB, booted.ledger, { graceSeconds: 300, holdTtlSeconds: 3_600, retentionSeconds: 604_800 }, () => new Date(Date.now() + ahead))
}

/** The references left on a key, as `attempt` names, sorted. */
async function references(key: string): Promise<string[]> {
  const rows = await pg.prisma.$queryRawUnsafe<{ attempt: string }[]>('SELECT "attempt" FROM "ai_budget_references" WHERE "key" = $1 ORDER BY "attempt"', key)
  return rows.map((row) => row.attempt)
}

async function applications(key: string): Promise<number> {
  const rows = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM "ai_budget_applications" WHERE "key" = $1', key)
  return Number(rows[0]?.n ?? 0n)
}

describe('the budget-reference sweep against PostgreSQL', () => {
  /*
   * Invariant: whatever the sweepers do and however many run at once, the window ends where a run in which the dead attempt
   * never happened would leave it: the orphan's movement goes back once, the committed call's stays, and a late reference on
   * the committed call's application drops itself.
   */
  it('gives an orphan back once, keeps a committed call, and drops a late reference, with two sweepers at once', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000_000_000n })
    const windowStart = budget.createdAt
    const call = await a.metering.record({ usage: e2eUsage(), context: e2eContext({ enforce: true, idempotencyKey: 'sweep-live' }) })
    const control = await pg.store.getWindow(budget.id, windowStart)
    expect(control?.spentNanoUsd).toBe(call.billedCostNanoUsd)
    // An attempt that died after taking its movement and before writing a row, and a late replayer of the live call.
    await pg.store.consumeWindowOnce({ key: 'record:sweep-orphan', budgetId: budget.id, attempt: 'dead' }, windowStart, { nanoUsd: 777n, tokens: 5, count: 1 }, {})
    const live = { nanoUsd: call.billedCostNanoUsd, tokens: call.totalTokens, count: 1 }
    expect(await pg.store.consumeWindowOnce({ key: 'record:sweep-live', budgetId: budget.id, attempt: 'late' }, windowStart, live, {})).toBe('replayed')
    expect((await pg.store.getWindow(budget.id, windowStart))?.spentNanoUsd).toBe(call.billedCostNanoUsd + 777n)

    await Promise.all([sweeper('a', HOUR).sweep(), sweeper('b', HOUR).sweep()])

    expect(await references('record:sweep-orphan')).toEqual([])
    expect(await references('record:sweep-live')).toEqual(['row'])
    expect(await pg.store.getWindow(budget.id, windowStart)).toEqual(control)
    // A second pass changes nothing.
    await sweeper('a', HOUR).sweep()
    expect(await pg.store.getWindow(budget.id, windowStart)).toEqual(control)
    expect(await references('record:sweep-live')).toEqual(['row'])
  })

  /** The record of a movement older than the retention is deleted with its references and moves no window. */
  it('deletes the application of an old committed call without moving the window', async () => {
    const budget = await upsertBudget(a.budgets, { scope: { type: 'user', id: 'u2' }, window: 'total', limitNanoUsd: 1_000_000_000_000n })
    await grantWallet(a.wallets, 1_000_000_000_000n, { ownerId: 'u2', idempotencyKey: 'grant-u2' })
    const call = await a.metering.record({ usage: e2eUsage(), context: e2eContext({ scope: { type: 'user', id: 'u2' }, enforce: true, idempotencyKey: 'sweep-old' }) })
    expect(await applications('record:sweep-old')).toBe(1)
    await sweeper('a', 8 * 24 * HOUR).sweep()
    expect(await applications('record:sweep-old')).toBe(0)
    expect(await references('record:sweep-old')).toEqual([])
    expect((await pg.store.getWindow(budget.id, budget.createdAt))?.spentNanoUsd).toBe(call.billedCostNanoUsd)
  })
})
