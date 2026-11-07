/**
 * @fileoverview E2E: a read whose `limit` or `offset` the database cannot read as a number rejects with the typed
 * store error, carrying the Prisma code in the body and the driver error as `cause`, on the client in use (Prisma 6's
 * engine or Prisma 7's driver adapter). The bound is caller input, so the failure must not leak as a raw Prisma error.
 * @layer test
 */

import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { grantEntry } from '../contracts/wallet-store.contract'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture
beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)
afterAll(async () => {
  await pg.stop()
})

const ref: WalletRef = { tenantId: 'bounds', ownerType: 'user', ownerId: 'u' }

/** The error a promise rejects with, or `undefined` when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error)
}

/** Assert the typed store error, with a Prisma code in the body and the driver error as the cause. */
function expectStoreError(error: unknown): void {
  expect(error).toBeInstanceOf(AiTokensException)
  const typed = error as AiTokensException
  expect(typed.getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR', details: { code: expect.stringMatching(/^P\d{4}$/) } } })
  expect(typed.cause).toBeDefined()
}

describe('a non-numeric bound on a read', () => {
  /** A usage query with a limit that is not a number is a typed store error, not a raw Prisma error. */
  it('types a non-numeric limit on the usage query', async () => {
    expectStoreError(await rejection(pg.store.query({ tenantId: 'bounds', limit: 'abc' as unknown as number })))
  })

  /** The same for the offset. */
  it('types a non-numeric offset on the usage query', async () => {
    expectStoreError(await rejection(pg.store.query({ tenantId: 'bounds', offset: 'abc' as unknown as number })))
  })

  /** The wallet-entry listing takes the same bounds and reaches the database only for a wallet that exists. */
  it('types a non-numeric limit and offset on the wallet-entry listing', async () => {
    await pg.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 10n }))
    expectStoreError(await rejection(pg.store.listEntries(ref, { limit: 'abc' as unknown as number })))
    expectStoreError(await rejection(pg.store.listEntries(ref, { offset: 'abc' as unknown as number })))
  })

  /** A numeric bound still works, so the handler changes nothing for a valid call. */
  it('still returns rows for numeric bounds', async () => {
    expect((await pg.store.listEntries(ref, { limit: 5, offset: 0 })).entries).toHaveLength(1)
    expect(await pg.store.query({ tenantId: 'bounds', limit: 5, offset: 0 })).toEqual([])
  })
})
