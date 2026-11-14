/**
 * @fileoverview E2E: a failure that retrying does not fix stays `AI_TOKENS_STORE_ERROR` and answers 500, on a live
 * PostgreSQL: a statement against a table that does not exist. A unique violation is still replayed or refused as a
 * conflict (409), never reported as a store failure.
 * @layer test
 */

import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { bootMeteringModule, startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture
beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)
afterAll(async () => {
  await pg.stop()
})

const ref: WalletRef = { tenantId: 'broken', ownerType: 'user', ownerId: 'u' }

describe('a failure that is not an outage', () => {
  /** A missing table is a defect of the installation, not something to retry: the typed store error, status 500, with the Prisma code in the body. */
  it('answers the store error with 500 for a missing table', async () => {
    const { wallets, close } = await bootMeteringModule({ store: pg.store })
    await pg.prisma.$executeRawUnsafe('ALTER TABLE ai_wallets RENAME TO ai_wallets_moved')
    try {
      const error = await wallets.grant(ref, { amountNanoUsd: 10n, idempotencyKey: 'g', reason: 'e2e' }).then(() => undefined, (e: unknown) => e)
      expect(error).toBeInstanceOf(AiTokensException)
      expect((error as AiTokensException).getStatus()).toBe(500)
      expect((error as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR' } })
    } finally {
      await pg.prisma.$executeRawUnsafe('ALTER TABLE ai_wallets_moved RENAME TO ai_wallets')
      await close()
    }
  })

  /** Reusing a grant key with another amount is the conflict, 409, and is never reported as a store failure. */
  it('keeps the idempotency conflict at 409', async () => {
    const { wallets, close } = await bootMeteringModule({ store: pg.store })
    try {
      await wallets.grant(ref, { amountNanoUsd: 10n, idempotencyKey: 'same', reason: 'e2e' })
      const error = await wallets.grant(ref, { amountNanoUsd: 99n, idempotencyKey: 'same', reason: 'e2e' }).then(() => undefined, (e: unknown) => e)
      expect((error as AiTokensException).getStatus()).toBe(409)
      expect((error as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_IDEMPOTENCY_CONFLICT' } })
    } finally {
      await close()
    }
  })
})
