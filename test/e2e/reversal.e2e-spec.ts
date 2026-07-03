/**
 * @fileoverview E2E scenario 4 (spec §19.2, §8.5): a reversal restores headroom —
 * the wallet balance, all three budget-window dimensions (cost/tokens/count), and a
 * subsequently-unblocked call all recover after `reverse()`. Against real PostgreSQL.
 * @layer test
 */

import type { AiTokensErrorResponse } from '@bymax-one/nest-ai-tokens/shared'
import type { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { E2E_WALLET, bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, upsertBudget, type Booted, type PostgresFixture } from './harness'

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
  await grantWallet(app.wallets, 100_000_000n)
  await upsertBudget(app.budgets, { limitCount: 1, limitTokens: 100_000, limitNanoUsd: 100_000_000n })
}, 180_000)

afterAll(async () => {
  await app.close()
  await pg.stop()
})

describe('E2E — reversal restores headroom (§8.5)', () => {
  /** A reversed enforced record returns wallet + all three window dimensions and unblocks the next call. */
  it('restores wallet, window, and the count quota', async () => {
    const record = await app.metering.record({ usage: e2eUsage(), context: e2eContext({ idempotencyKey: 'rev-1', enforce: true }) })
    // The count quota (limit 1) is now exhausted: a second call is blocked.
    const blocked = await app.metering.record({ usage: e2eUsage(), context: e2eContext({ idempotencyKey: 'rev-2', enforce: true }) }).catch((e: unknown) => e)
    expect(codeOf(blocked)).toBe('AI_TOKENS_QUOTA_EXCEEDED')

    await app.metering.reverse(record.id, 'e2e refund')
    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(100_000_000n)
    const status = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(status?.spent).toEqual({ nanoUsd: 0n, tokens: 0, count: 0 })

    // Headroom recovered: the next call now succeeds.
    const next = await app.metering.record({ usage: e2eUsage(), context: e2eContext({ idempotencyKey: 'rev-3', enforce: true }) })
    expect(next.status).toBe('posted')
  })
})
