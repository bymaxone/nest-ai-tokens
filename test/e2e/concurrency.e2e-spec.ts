/**
 * @fileoverview E2E scenario 1 (spec §19.2): two parallel `meter()` calls against
 * a budget with headroom for ONE — exactly one proceeds, the other is rejected
 * (429 quota); the ledger, budget window, and wallet all agree afterward. Exercises
 * the Redis live-counter fast path (§10.8).
 * @layer test
 */

import type { AiTokensErrorResponse, NormalizedUsage } from '@bymax-one/nest-ai-tokens/shared'
import type { AiTokensException, HoldEstimate } from '@bymax-one/nest-ai-tokens'
import { E2E_WALLET, bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, startRedis, upsertBudget, type Booted, type PostgresFixture, type RedisFixture } from './harness'

const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

let pg: PostgresFixture
let redis: RedisFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  redis = await startRedis()
  app = await bootMeteringModule({ store: pg.store, counter: redis.counter })
  await seedPrice(app.pricing)
  await grantWallet(app.wallets, 100_000_000n)
  await upsertBudget(app.budgets, { limitCount: 1 })
}, 180_000)

afterAll(async () => {
  await app.close()
  await redis.stop()
  await pg.stop()
})

describe('E2E — hold→capture concurrency (§10.8)', () => {
  /** Two parallel metered calls, headroom for one: one settles, one is quota-blocked. */
  it('admits exactly one of two racing metered calls', async () => {
    const run = (key: string): Promise<unknown> =>
      app.metering.meter(() => Promise.resolve(e2eUsage()), e2eContext({ idempotencyKey: key }), (r: NormalizedUsage) => r, ESTIMATE)
    const [a, b] = await Promise.allSettled([run('race-a'), run('race-b')])
    const outcomes = [a, b]
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult
    // Blocked with a 402/429 (spec §19.2): the exact dimension code depends on whether the
    // Redis counter fast path or the DB conditional consume detected the shortfall first.
    expect(['AI_TOKENS_QUOTA_EXCEEDED', 'AI_TOKENS_BUDGET_EXCEEDED']).toContain(codeOf(rejected.reason))

    const posted = (await app.ledger.query({ tenantId: 'e2e', feature: 'chat.reply' })).filter((r) => r.status === 'posted')
    expect(posted).toHaveLength(1)
    const status = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(status?.spent.count).toBe(1)
    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(93_750_000n)
  })
})
