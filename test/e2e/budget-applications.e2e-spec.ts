/**
 * @fileoverview E2E: a budget movement keyed by its cause happens once, however many attempts and instances run it,
 * against real PostgreSQL over two clients. The uniqueness of the application, never a read followed by a write, decides
 * which attempt moves the window: concurrent attempts leave one application row and one window move.
 * @layer test
 */

import type { HoldEstimate } from '@bymax-one/nest-ai-tokens'
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

/** Count the reference rows of a key. */
async function referenceRows(key: string): Promise<number> {
  const rows = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM "ai_budget_references" WHERE "key" = $1', key)
  return Number(rows[0]?.n ?? 0n)
}

describe('keyed budget movements against PostgreSQL', () => {
  /*
   * Invariant: attempts with one application, split over two clients, leave exactly one 'applied', one application row,
   * one reference per attempt and one move of the window.
   */
  it('lets exactly one of many concurrent attempts on two clients move the window', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000n })
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        (i % 2 === 0 ? pg.store : pg.storeB).consumeWindowOnce({ key: 'race-key', budgetId: budget.id, attempt: `a${i.toString()}` }, WINDOW, { nanoUsd: 10n, tokens: 3, count: 1 }, { nanoUsd: 1_000_000n }),
      ),
    )
    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'replayed')).toHaveLength(15)
    expect(await applicationRows('race-key')).toBe(1)
    expect(await referenceRows('race-key')).toBe(16)
    expect(await pg.store.getWindow(budget.id, WINDOW)).toEqual({ spentNanoUsd: 10n, spentTokens: 3, spentCount: 1 })
  })

  /*
   * Invariant: the references drop concurrently without losing or doubling the give-back: of 16 holders dropping at once the
   * movement goes back exactly once, with the last of them, and the window ends at zero.
   */
  it('gives the movement back exactly once when all holders drop at once', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000n })
    const references = Array.from({ length: 16 }, (_, i) => ({ key: 'drop-key', budgetId: budget.id, attempt: `a${i.toString()}` }))
    await Promise.all(references.map((reference, i) => (i % 2 === 0 ? pg.store : pg.storeB).consumeWindowOnce(reference, WINDOW, { nanoUsd: 40n, tokens: 0, count: 1 }, {})))
    const outcomes = await Promise.all(references.map((reference, i) => (i % 2 === 0 ? pg.store : pg.storeB).dropReference(reference)))
    expect(outcomes.filter((outcome) => outcome === 'unapplied')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'kept')).toHaveLength(15)
    expect(await pg.store.getWindow(budget.id, WINDOW)).toEqual({ spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 })
  })

  /*
   * Invariant: a take and a drop of one application never interleave: while one attempt drops the last reference and another
   * takes a reference, the window ends at one movement with a reference held, or at zero with none, never a reference on
   * a movement that was given back.
   */
  it('never leaves a reference on a movement that was given back when a take races the last drop', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000n })
    for (let round = 0; round < 12; round++) {
      const key = `race-${round.toString()}`
      await pg.store.consumeWindowOnce({ key, budgetId: budget.id, attempt: 'first' }, WINDOW, { nanoUsd: 10n, tokens: 0, count: 0 }, {})
      const [dropped, taken] = await Promise.all([
        pg.store.dropReference({ key, budgetId: budget.id, attempt: 'first' }),
        pg.storeB.consumeWindowOnce({ key, budgetId: budget.id, attempt: 'second' }, WINDOW, { nanoUsd: 10n, tokens: 0, count: 0 }, {}),
      ])
      expect(['kept', 'unapplied']).toContain(dropped)
      expect(['applied', 'replayed']).toContain(taken)
      const held = await referenceRows(key)
      const window = await pg.store.getWindow(budget.id, WINDOW)
      expect(held).toBe(1)
      expect(await pg.store.dropReference({ key, budgetId: budget.id, attempt: 'second' })).toBe('unapplied')
      expect(window).not.toBeNull()
    }
    expect(await pg.store.getWindow(budget.id, WINDOW)).toEqual({ spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 })
  })

  /** Committing from two instances in either order ends with one committed reference. */
  it('ends with exactly one committed reference when two attempts commit at once', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000n })
    const base = { key: 'commit-key', budgetId: budget.id }
    await pg.store.consumeWindowOnce({ ...base, attempt: 'a' }, WINDOW, { nanoUsd: 30n, tokens: 0, count: 0 }, {})
    await pg.store.consumeWindowOnce({ ...base, attempt: 'b' }, WINDOW, { nanoUsd: 30n, tokens: 0, count: 0 }, {})
    const outcomes = await Promise.all([pg.store.commitReference({ ...base, attempt: 'a' }), pg.storeB.commitReference({ ...base, attempt: 'b' })])
    expect([...outcomes].sort()).toEqual(['already', 'committed'])
    expect(await referenceRows('commit-key')).toBe(1)
    expect(await pg.store.dropReference({ ...base, attempt: 'row' })).toBe('unapplied')
  })

  /** A refused consume rolls its application and reference back with it, so the key can be applied once there is room. */
  it('records no application or reference for a consume a limit refused', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 5n })
    const reference = { key: 'refused-key', budgetId: budget.id, attempt: 'a' }
    expect(await pg.store.consumeWindowOnce(reference, WINDOW, { nanoUsd: 10n, tokens: 0, count: 0 }, { nanoUsd: 5n })).toBe('refused')
    expect(await applicationRows('refused-key')).toBe(0)
    expect(await referenceRows('refused-key')).toBe(0)
    expect(await pg.store.dropReference(reference)).toBe('absent')
    expect(await pg.store.consumeWindowOnce(reference, WINDOW, { nanoUsd: 4n, tokens: 0, count: 0 }, { nanoUsd: 5n })).toBe('applied')
  })

  /** A key met in another window or with another amount is a mismatch on the real database, and takes no reference. */
  it('answers a mismatch for another window or amount and takes no reference', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000n })
    const reference = { key: 'mismatch-key', budgetId: budget.id, attempt: 'a' }
    const july = new Date('2026-07-01T00:00:00.000Z')
    expect(await pg.store.consumeWindowOnce(reference, WINDOW, { nanoUsd: 30n, tokens: 1, count: 1 }, {})).toBe('applied')
    expect(await pg.storeB.consumeWindowOnce({ ...reference, attempt: 'b' }, WINDOW, { nanoUsd: 80n, tokens: 1, count: 1 }, {})).toBe('mismatch')
    expect(await pg.storeB.consumeWindowOnce({ ...reference, attempt: 'b' }, july, { nanoUsd: 30n, tokens: 1, count: 1 }, {})).toBe('mismatch')
    expect(await pg.storeB.adjustWindowOnce({ ...reference, attempt: 'b' }, july, { nanoUsd: 30n, tokens: 1, count: 1 })).toBe('mismatch')
    expect(await referenceRows('mismatch-key')).toBe(1)
    expect(await pg.store.getWindow(budget.id, july)).toBeNull()
  })

  /** Removing a budget removes its applications and their references with it, by the foreign keys' cascade. */
  it('removes the applications and references of a removed budget', async () => {
    const budget = await upsertBudget(a.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 100n })
    await pg.store.adjustWindowOnce({ key: 'cascade-key', budgetId: budget.id, attempt: 'row' }, WINDOW, { nanoUsd: 1n, tokens: 0, count: 0 })
    expect(await applicationRows('cascade-key')).toBe(1)
    expect(await referenceRows('cascade-key')).toBe(1)
    await pg.store.remove({ tenantId: 'e2e', id: budget.id })
    expect(await applicationRows('cascade-key')).toBe(0)
    expect(await referenceRows('cascade-key')).toBe(0)
  })
})

describe('a keyed record() retried on two instances consumes the budget once', () => {
  /*
   * Invariant (the limit named in the hold note): one keyed call attempted at once on two instances consumes each
   * budget once, whichever append wins, because both attempts record the consumption under the call's key.
   */
  it('consumes the payer budget once for one key attempted ten times on two instances', async () => {
    await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_budget_references", "ai_budget_applications", "ai_budget_windows", "ai_budgets" CASCADE')
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

describe('identical keyed calls that name no instant, raced over two instances', () => {
  /** Each attempt is stamped with its own moment, so the calls differ only by it: they are still one call, counted once. */
  it('counts the budget once for twelve identical keyed record() calls without an instant', async () => {
    await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_budget_references", "ai_budget_applications", "ai_budget_windows", "ai_budgets", "ai_usage_records" CASCADE')
    const c = await bootMeteringModule({ store: pg.store, wallets: false })
    const d = await bootMeteringModule({ store: pg.storeB, wallets: false })
    try {
      await upsertBudget(c.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000_000_000n })
      await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? c : d).metering.record({ usage: e2eUsage(), context: e2eContext({ idempotencyKey: 'no-instant', enforce: true }) })))
      const rows = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM "ai_usage_records" WHERE "idempotencyKey" = \'no-instant\'')
      expect(Number(rows[0]?.n)).toBe(1)
      expect((await c.budgets.status('e2e', PAYER))[0]?.spent.count).toBe(1)
    } finally {
      await c.close()
      await d.close()
    }
  })
})

describe('a keyed hold raced on two instances with budgets bound and no wallet', () => {
  const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }

  /*
   * Invariant: the reservation recorded under a hold's key belongs to the stored row, with or without a wallet. A loser
   * of the append meets the winner's row, so its compensation leaves the winner's reservation alone: the window
   * counts the hold once and one pending row stands.
   */
  it('counts the hold once in the window and keeps one pending row', async () => {
    await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_budget_references", "ai_budget_applications", "ai_budget_windows", "ai_budgets", "ai_usage_records" CASCADE')
    const c = await bootMeteringModule({ store: pg.store, wallets: false })
    const d = await bootMeteringModule({ store: pg.storeB, wallets: false })
    try {
      await upsertBudget(c.budgets, { scope: PAYER, window: 'total', limitNanoUsd: 1_000_000_000_000n })
      const context = e2eContext({ idempotencyKey: 'budgets-only-race' })
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? c : d).metering.hold(context, ESTIMATE)))
      expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
      const rows = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM "ai_usage_records" WHERE "status" = \'pending\'')
      expect(Number(rows[0]?.n)).toBe(1)
      const [status] = await c.budgets.status('e2e', PAYER)
      expect(status?.spent.count).toBe(1)
    } finally {
      await c.close()
      await d.close()
    }
  })
})

describe('two payers reusing one key under a tenant-wide budget, raced over two instances', () => {
  const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }
  const TENANT_WIDE: MeteringScope = { type: 'tenant', id: 'e2e' }
  const PAYERS: MeteringScope[] = [{ type: 'user', id: 'u1' }, { type: 'user', id: 'u2' }]

  /*
   * Invariant: the application of the tenant-wide budget is shared by the two payers' attempts, and the winner of the
   * ledger append owns it. Whatever the interleaving, the budget counts the winner's call once: a loser that only replayed
   * the application never gives it back, and nothing is counted twice.
   */
  it('keeps the tenant-wide consumption of the call that won the key', async () => {
    await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_budget_references", "ai_budget_applications", "ai_budget_windows", "ai_budgets", "ai_usage_records" CASCADE')
    const c = await bootMeteringModule({ store: pg.store, wallets: false })
    const d = await bootMeteringModule({ store: pg.storeB, wallets: false })
    try {
      await upsertBudget(c.budgets, { scope: TENANT_WIDE, window: 'total', limitNanoUsd: 1_000_000_000_000n })
      await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 === 0 ? c : d).metering.record({
            usage: e2eUsage(),
            context: e2eContext({ scope: PAYERS[i % 3 === 0 ? 0 : 1]!, idempotencyKey: 'two-payers', enforce: true }),
            occurredAt: new Date('2026-06-15T12:00:00.000Z'),
          }),
        ),
      )
      const rows = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM "ai_usage_records" WHERE "idempotencyKey" = \'two-payers\'')
      expect(Number(rows[0]?.n)).toBe(1)
      const [status] = await c.budgets.status('e2e', PAYERS[0]!)
      expect(status?.spent.count).toBe(1)
    } finally {
      await c.close()
      await d.close()
    }
  })

  /** The same race for a hold: one pending row, and the tenant-wide budget counts the reservation once. */
  it('keeps the tenant-wide reservation of the hold that won the key', async () => {
    await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_budget_references", "ai_budget_applications", "ai_budget_windows", "ai_budgets", "ai_usage_records" CASCADE')
    const c = await bootMeteringModule({ store: pg.store, wallets: false })
    const d = await bootMeteringModule({ store: pg.storeB, wallets: false })
    try {
      await upsertBudget(c.budgets, { scope: TENANT_WIDE, window: 'total', limitNanoUsd: 1_000_000_000_000n })
      await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 === 0 ? c : d).metering.hold(e2eContext({ scope: PAYERS[i % 3 === 0 ? 0 : 1]!, idempotencyKey: 'two-payers-hold' }), ESTIMATE),
        ),
      )
      const rows = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM "ai_usage_records" WHERE "idempotencyKey" = \'two-payers-hold\' AND "status" = \'pending\'')
      expect(Number(rows[0]?.n)).toBe(1)
      const [status] = await c.budgets.status('e2e', PAYERS[0]!)
      expect(status?.spent.count).toBe(1)
    } finally {
      await c.close()
      await d.close()
    }
  })
})

describe('one payer reusing a key with different features, raced over two instances', () => {
  /*
   * Invariant: a budget restricted to one feature is held only by the attempts of that feature. Whichever call wins the key,
   * the restricted budget counts that call once if it is the foo call, and not at all if it is the bar call; the tenant-wide
   * budget counts the winner once.
   */
  it('counts a feature-restricted budget only for the call that won the key', async () => {
    await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_budget_references", "ai_budget_applications", "ai_budget_windows", "ai_budgets", "ai_usage_records" CASCADE')
    const c = await bootMeteringModule({ store: pg.store, wallets: false })
    const d = await bootMeteringModule({ store: pg.storeB, wallets: false })
    try {
      const tenantWide = await upsertBudget(c.budgets, { scope: { type: 'tenant', id: 'e2e' }, window: 'total', limitNanoUsd: 1_000_000_000_000n })
      const restricted = await upsertBudget(c.budgets, { scope: PAYER, features: ['foo'], window: 'total', limitNanoUsd: 1_000_000_000_000n })
      await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 === 0 ? c : d).metering.record({
            usage: e2eUsage(),
            context: e2eContext({ feature: i % 3 === 0 ? 'foo' : 'bar', idempotencyKey: 'features', enforce: true }),
            occurredAt: new Date('2026-06-15T12:00:00.000Z'),
          }),
        ),
      )
      const rows = await pg.prisma.$queryRawUnsafe<{ feature: string }[]>('SELECT "feature" FROM "ai_usage_records" WHERE "idempotencyKey" = \'features\'')
      expect(rows).toHaveLength(1)
      const statuses = await c.budgets.status('e2e', PAYER)
      const spentCount = (id: string): number => statuses.find((status) => status.budgetId === id)?.spent.count ?? 0
      expect(spentCount(tenantWide.id)).toBe(1)
      expect(spentCount(restricted.id)).toBe(rows[0]?.feature === 'foo' ? 1 : 0)
    } finally {
      await c.close()
      await d.close()
    }
  })
})
