/**
 * @fileoverview E2E: a store that cannot serve a call answers `AI_TOKENS_STORE_UNAVAILABLE` (503) in each of the three ways
 * a database goes away, measured on a real PostgreSQL through the Prisma 7 driver adapter: the server paused (the socket
 * stays open and nothing answers), the server stopped, and a client created after the server stopped. A statement that
 * fails for a reason of its own stays `AI_TOKENS_STORE_ERROR` (500), and a unique violation stays a conflict.
 * @layer test
 */

import { execSync } from 'node:child_process'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { bootMeteringModule, startPostgres, type Booted, type PostgresFixture } from './harness'

let pg: PostgresFixture
beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)
afterAll(async () => {
  await pg.stop().catch(() => undefined)
})

const ref: WalletRef = { tenantId: 'down', ownerType: 'user', ownerId: 'u' }

/** The wallet service of a module over a fresh client whose pool gives up on a connection after three seconds. */
async function walletsOver(url: string): Promise<{ booted: Booted; client: PrismaClient }> {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, connectionTimeoutMillis: 3_000 }) })
  return { booted: await bootMeteringModule({ store: new PrismaAiTokensStore(client as never) }), client }
}

/** A grant under a fresh key, the call every mode below makes. */
const grant = (booted: Booted, key: string): Promise<unknown> => booted.wallets.grant(ref, { amountNanoUsd: 10n, idempotencyKey: key, reason: 'e2e' })

/** The status and code of the exception a store call rejects with, and the driver error it carries. */
async function outcome(call: Promise<unknown>): Promise<{ status: number; code: string; cause: unknown }> {
  const error = await call.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(AiTokensException)
  const typed = error as AiTokensException
  return { status: typed.getStatus(), code: (typed.getResponse() as { error: { code: string } }).error.code, cause: typed.cause }
}

describe('a database that goes away', () => {
  /**
   * The paused server keeps its socket open and answers nothing. Measured through the wallet service, whose grant runs in
   * an interactive transaction: P2028, "Transaction API error: Unable to start a transaction in the given time." with an
   * empty meta. Outside a transaction the driver adapter throws a plain Error, "Connection terminated due to connection
   * timeout" (unit-tested with that shape).
   */
  it('answers unavailable while the server is paused', async () => {
    const { booted, client } = await walletsOver(pg.url)
    execSync(`docker pause ${pg.container.getId()}`)
    try {
      const result = await outcome(grant(booted, 'paused'))
      expect(result).toMatchObject({ status: 503, code: 'AI_TOKENS_STORE_UNAVAILABLE' })
      expect(result.cause).toMatchObject({ code: 'P2028', message: expect.stringContaining('Unable to start a transaction in the given time') })
    } finally {
      execSync(`docker unpause ${pg.container.getId()}`)
      await booted.close()
      await client.$disconnect().catch(() => undefined)
    }
  }, 60_000)

  /** A paused server that comes back serves the same client again: the failure was the outage, not the store. */
  it('serves again when the server comes back', async () => {
    await expect(grant(await bootMeteringModule({ store: pg.store }), 'back')).resolves.toBeDefined()
  })

  /**
   * Measured: a known-request error whose code is the socket's, `ECONNREFUSED`, on a client that had a warm connection
   * and on a client created after the server stopped.
   */
  it('answers unavailable when the server is stopped, for a warm client and for a fresh one', async () => {
    const warmModule = await bootMeteringModule({ store: pg.store })
    await grant(warmModule, 'warm-up')
    await pg.container.stop({ timeout: 2 })
    const warm = await outcome(grant(warmModule, 'stopped'))
    expect(warm).toMatchObject({ status: 503, code: 'AI_TOKENS_STORE_UNAVAILABLE' })
    expect((warm.cause as { code?: string }).code).toBe('ECONNREFUSED')
    const { booted, client } = await walletsOver(pg.url)
    try {
      expect(await outcome(grant(booted, 'fresh'))).toMatchObject({ status: 503, code: 'AI_TOKENS_STORE_UNAVAILABLE' })
    } finally {
      await booted.close()
      await client.$disconnect().catch(() => undefined)
    }
  }, 60_000)
})
