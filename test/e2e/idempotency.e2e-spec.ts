/**
 * @fileoverview E2E scenario 2 (spec §19.2, §8.4): an idempotent retry with the
 * same key + payload writes ONE ledger row and returns the identical response; the
 * same key with a changed payload is a 409 conflict. Proves exactly-once append on
 * `unique(tenantId, idempotencyKey)` against real PostgreSQL.
 * @layer test
 */

import type { AiTokensErrorResponse } from '@bymax-one/nest-ai-tokens/shared'
import type { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { bootMeteringModule, e2eContext, e2eUsage, seedPrice, startPostgres, type Booted, type PostgresFixture } from './harness'

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

let pg: PostgresFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  app = await bootMeteringModule({ store: pg.store, markup: 2 })
  await seedPrice(app.pricing)
}, 180_000)

afterAll(async () => {
  await app.close()
  await pg.stop()
})

describe('E2E — idempotent retry (§8.4)', () => {
  /** Same key + payload replays a single row with the identical response. */
  it('replays a single ledger row on a matching retry', async () => {
    const context = e2eContext({ idempotencyKey: 'retry-1' })
    const occurredAt = new Date('2026-06-15T12:00:00.000Z')
    const first = await app.metering.record({ usage: e2eUsage(), context, occurredAt })
    const second = await app.metering.record({ usage: e2eUsage(), context, occurredAt })
    expect(second.id).toBe(first.id)
    expect(second.billedCostNanoUsd).toBe(first.billedCostNanoUsd)
    const rows = await app.ledger.query({ tenantId: 'e2e', feature: 'chat.reply' })
    expect(rows.filter((r) => r.idempotencyKey === 'retry-1')).toHaveLength(1)
  })

  /** Same key with a changed payload is a 409 conflict. */
  it('rejects a changed payload under the same key', async () => {
    const context = e2eContext({ idempotencyKey: "retry-2" })
    await app.metering.record({ usage: e2eUsage(), context })
    const error = await app.metering.record({ usage: e2eUsage({ inputTokens: 2000 }), context }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
    expect((error as AiTokensException).getStatus()).toBe(409)
  })
})
