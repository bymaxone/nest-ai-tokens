/**
 * @fileoverview E2E: a budget movement keyed by its cause happens once, however many attempts and instances run it,
 * against real PostgreSQL over two clients. The uniqueness of the application, never a read followed by a write, decides
 * which attempt moves the window: concurrent attempts leave one application row and one window move.
 * @layer test
 */

import type { MeteringScope } from '@bymax-one/nest-ai-tokens/shared'
import { bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, upsertBudget, type Booted, type PostgresFixture } from './harness'

const PAYER: MeteringScope = { type: 'user', id: 'u1' }
const WINDOW = new Date('2026-06-01T00:00:00.000Z')

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

/** Count the application rows of a key. */
async function applicationRows(key: string): Promise<number> {
  const rows = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM "ai_budget_applications" WHERE "key" = $1', key)
  return Number(rows[0]?.n ?? 0n)
}

describe('keyed budget movements against PostgreSQL', () => {
  /*
   * Invariant: attempts with one application, split over two clients, leave exactly one 'applied', one application row
   * and one move of the window.
   */
  it('lets exactly one of many concurrent attempts on two clients move the window', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000n })
    const application = { key: 'race-key', budgetId: budget.id }
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? pg.store : pg.storeB).consumeWindowOnce(application, WINDOW, { nanoUsd: 10n, tokens: 3, count: 1 }, { nanoUsd: 1_000_000n })),
    )
    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'replayed')).toHaveLength(15)
    expect(await applicationRows('race-key')).toBe(1)
    expect(await pg.store.getWindow(budget.id, WINDOW)).toEqual({ spentNanoUsd: 10n, spentTokens: 3, spentCount: 1 })
  })

  /** Giving back races the same way: exactly one of many concurrent give-backs subtracts, and the window ends at zero. */
  it('lets exactly one of many concurrent give-backs subtract', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000n })
    const application = { key: 'back-key', budgetId: budget.id }
    await pg.store.adjustWindowOnce(application, WINDOW, { nanoUsd: 40n, tokens: 0, count: 1 })
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? pg.store : pg.storeB).unapplyWindow(application)))
    expect(outcomes.filter((outcome) => outcome === 'unapplied')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'already')).toHaveLength(7)
    expect(await pg.store.getWindow(budget.id, WINDOW)).toEqual({ spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 })
  })

  /** A refused consume rolls its application back with it, so the key can be applied once there is room. */
  it('records no application for a consume a limit refused', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 5n })
    const application = { key: 'refused-key', budgetId: budget.id }
    expect(await pg.store.consumeWindowOnce(application, WINDOW, { nanoUsd: 10n, tokens: 0, count: 0 }, { nanoUsd: 5n })).toBe('refused')
    expect(await applicationRows('refused-key')).toBe(0)
    expect(await pg.store.unapplyWindow(application)).toBe('absent')
    expect(await pg.store.consumeWindowOnce(application, WINDOW, { nanoUsd: 4n, tokens: 0, count: 0 }, { nanoUsd: 5n })).toBe('applied')
  })

  /** Removing a budget removes its applications with it, by the foreign key's cascade. */
  it('removes the applications of a removed budget', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 100n })
    await pg.store.adjustWindowOnce({ key: 'cascade-key', budgetId: budget.id }, WINDOW, { nanoUsd: 1n, tokens: 0, count: 0 })
    expect(await applicationRows('cascade-key')).toBe(1)
    await pg.store.remove({ tenantId: 'e2e', id: budget.id })
    expect(await applicationRows('cascade-key')).toBe(0)
  })
})

describe('a keyed record() retried on two instances consumes the budget once', () => {
  /*
   * Invariant (the limit named in the hold note): one keyed call attempted at once on two instances consumes each
   * budget once, whichever append wins, because both attempts record the consumption under the call's key.
   */
  it('consumes the payer budget once for one key attempted ten times on two instances', async () => {
    await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_budget_applications", "ai_budget_windows", "ai_budgets" CASCADE')
    await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000_000_000n })
    const context = e2eContext({ idempotencyKey: 'record-race', enforce: true })
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b).metering.record({ usage: e2eUsage(), context, occurredAt: new Date('2026-06-15T12:00:00.000Z') })),
    )
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    const [status] = await a.budgets.status('e2e', PAYER)
    expect(status?.spent.count).toBe(1)
  })
})
