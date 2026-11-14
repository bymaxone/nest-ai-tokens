/**
 * @fileoverview E2E: `hold()` called with one idempotency key racing itself on two instances over one PostgreSQL. The
 * wallet balance, the ledger rows and the budget window are checked after every run, and the measured numbers are
 * printed as `HOLDKEY {...}` lines.
 * @layer test
 */

import type { AiTokensErrorResponse } from '@bymax-one/nest-ai-tokens/shared'
import type { AiTokensException, HoldEstimate } from '@bymax-one/nest-ai-tokens'
import { E2E_WALLET, bootMeteringModule, e2eContext, seedPrice, startPostgres, startRedis, upsertBudget, grantWallet, type Booted, type PostgresFixture, type RedisFixture } from './harness'

const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }
const UNIT = 6_250_000n // billed estimate of one 1000-in / 500-out gpt-5 hold
const FUNDED = 100n * UNIT

function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

let pg: PostgresFixture
let redis: RedisFixture
let a: Booted
let b: Booted

beforeAll(async () => {
  pg = await startPostgres()
  redis = await startRedis()
  a = await bootMeteringModule({ store: pg.store, counter: redis.counter })
  b = await bootMeteringModule({ store: pg.storeB, counter: redis.counter })
  await seedPrice(a.pricing)
}, 240_000)

afterAll(async () => {
  await a.close()
  await b.close()
  await redis.stop()
  await pg.stop()
})

async function reset(): Promise<void> {
  await pg.prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_wallet_debit_allocations", "ai_wallet_entries", "ai_wallets", "ai_usage_records", "ai_budget_windows", "ai_budgets" CASCADE')
  await redis.client.flushall()
  await grantWallet(a.wallets, FUNDED, { idempotencyKey: 'funded' })
  await upsertBudget(a.budgets, { limitNanoUsd: FUNDED })
}

/** The numbers the run is judged by: rows by status straight from the table, the wallet and the budget window. */
async function books(label: string, extra: Record<string, unknown> = {}): Promise<{ pending: number; released: number; balance: bigint }> {
  const rows = await pg.prisma.$queryRawUnsafe<{ status: string; n: bigint }[]>('SELECT "status", count(*) AS n FROM "ai_usage_records" GROUP BY "status"')
  const count = (s: string): number => Number(rows.find((r) => r.status === s)?.n ?? 0n)
  const balance = (await a.wallets.getBalance(E2E_WALLET)).nanoUsd
  const status = (await a.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
  console.log('HOLDKEY ' + JSON.stringify({ label, pending: count('pending'), released: count('released'), balance: balance.toString(), budgetSpent: status?.spent.nanoUsd?.toString(), budgetCount: status?.spent.count, ...extra }))
  return { pending: count('pending'), released: count('released'), balance }
}

describe('hold() with one key racing itself on two instances', () => {
  it.each([2, 10])('x%i reserves the wallet exactly once and keeps one pending row', async (n) => {
    await reset()
    const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? a : b).metering.hold(e2eContext({ idempotencyKey: `same-${n}` }), ESTIMATE)))
    const codes: Record<string, number> = {}
    for (const r of results) if (r.status === 'rejected') codes[codeOf(r.reason)] = (codes[codeOf(r.reason)] ?? 0) + 1
    const out = await books(`hold x${n}`, { ok: results.filter((r) => r.status === 'fulfilled').length, rejected: codes })
    expect(out.pending).toBe(1)
    expect(out.balance).toBe(FUNDED - UNIT)
  }, 120_000)

  it('does not credit the wallet twice when the winner released before the loser recovered', async () => {
    await reset()
    const hold = await a.metering.hold(e2eContext({ idempotencyKey: 'rel-1' }), ESTIMATE)
    await a.metering.release(hold, 'released before the loser recovers')
    // The loser misses the winner's row at its replay lookup, then loses the append.
    jest.spyOn(b.ledger, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    const loser = await Promise.allSettled([b.metering.hold(e2eContext({ idempotencyKey: 'rel-1' }), ESTIMATE)])
    const out = await books('release before recovery', { loser: loser[0].status === 'rejected' ? codeOf((loser[0] as PromiseRejectedResult).reason) : 'ok' })
    expect(out.released).toBe(1)
    expect(out.balance).toBe(FUNDED)
  }, 120_000)
})
