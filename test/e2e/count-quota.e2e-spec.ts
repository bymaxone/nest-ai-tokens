/**
 * @fileoverview E2E scenario 6 (spec §19.2, §6.6/§10.3): a `limitCount: 2` budget
 * with a feature filter blocks the THIRD matching generation while a non-matching
 * feature (embeddings) passes unaffected. Against real PostgreSQL.
 * @layer test
 */

import type { AiTokensErrorResponse } from '@bymax-one/nest-ai-tokens/shared'
import type { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, upsertBudget, type Booted, type PostgresFixture } from './harness'

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

let pg: PostgresFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  app = await bootMeteringModule({ store: pg.store })
  await seedPrice(app.pricing)
  await seedPrice(app.pricing, { model: 'text-embedding-3' })
  await grantWallet(app.wallets, 100_000_000n)
  await upsertBudget(app.budgets, { limitCount: 2, features: ['chat.reply'] })
}, 180_000)

afterAll(async () => {
  await app.close()
  await pg.stop()
})

describe('E2E — count quota with a feature filter (§10.3)', () => {
  /** The third matching call is blocked; a non-matching feature passes. */
  it('blocks the third matching generation but allows a different feature', async () => {
    const meter = (key: string): Promise<unknown> =>
      app.metering.record({ usage: e2eUsage(), context: e2eContext({ idempotencyKey: key, enforce: true }) })
    await meter('c1')
    await meter('c2')
    const third = await meter('c3').catch((e: unknown) => e)
    expect(codeOf(third)).toBe('AI_TOKENS_QUOTA_EXCEEDED')

    // The embeddings feature does not match the budget's filter → it passes.
    const embedding = await app.metering.record({
      usage: e2eUsage({ model: 'text-embedding-3', operation: 'embeddings', outputTokens: 0 }),
      context: e2eContext({ idempotencyKey: 'e1', feature: 'search.embed', enforce: true }),
    })
    expect(embedding.status).toBe('posted')
  })
})
