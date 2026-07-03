/**
 * @fileoverview E2E scenario 5 (spec §19.2, §10.1): a budget with a mid-month
 * `anchorAt` rotates on the anchor day, not the calendar 1st; `rotateWindow()`
 * forces an immediate fresh window. Against real PostgreSQL.
 * @layer test
 */

import { bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, upsertBudget, type Booted, type PostgresFixture } from './harness'

let pg: PostgresFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  app = await bootMeteringModule({ store: pg.store })
  await seedPrice(app.pricing)
  await grantWallet(app.wallets, 100_000_000n)
}, 180_000)

afterAll(async () => {
  await app.close()
  await pg.stop()
})

describe('E2E — renewal-anchored window (§10.1)', () => {
  /** The window starts on the anchor day-of-month, not the calendar 1st; rotateWindow resets it. */
  it('anchors the window and rotates on demand', async () => {
    // Anchor on the 10th; the current window therefore starts on a 10th, never a 1st.
    const budget = await upsertBudget(app.budgets, { limitNanoUsd: 100_000_000n, anchorAt: new Date('2026-01-10T00:00:00.000Z') })
    const before = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(before?.windowStart.getUTCDate()).toBe(10)

    await app.metering.record({ usage: e2eUsage(), context: e2eContext({ idempotencyKey: 'anchor-1', enforce: true }) })
    const consumed = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(consumed?.spent.nanoUsd).toBe(6_250_000n)

    // rotateWindow forces a fresh window: spend resets to zero.
    await app.budgets.rotateWindow(budget.id)
    const rotated = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(rotated?.spent.nanoUsd).toBe(0n)
  })
})
