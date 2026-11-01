/**
 * @fileoverview E2E (spec §8.4): a retry of `record()` with a key the ledger already holds returns
 * the stored row and moves nothing a second time, against real PostgreSQL. The stored row comes
 * back through the Prisma row mapper, so these cases also prove its nulls, arrays and timestamps
 * compare equal to the values a new call carries.
 * @layer test
 */

import type { AiTokensErrorResponse, MeteringScope } from '@bymax-one/nest-ai-tokens/shared'
import type { AiTokensException } from '@bymax-one/nest-ai-tokens'
import {
  bootMeteringModule,
  e2eContext,
  e2eUsage,
  grantWallet,
  seedPrice,
  startPostgres,
  upsertBudget,
  type Booted,
  type PostgresFixture,
} from './harness'

const PAYER: MeteringScope = { type: 'user', id: 'u1' }

let pg: PostgresFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  app = await bootMeteringModule({ store: pg.store })
  await seedPrice(app.pricing)
  await grantWallet(app.wallets, 1_000_000_000_000n)
  await upsertBudget(app.budgets, {
    scope: PAYER,
    window: 'total',
    limitNanoUsd: 1_000_000_000_000n,
  })
}, 180_000)

afterAll(async () => {
  await app.close()
  await pg.stop()
})

/** The payer's budget spend and wallet balance, which a replay must leave alone. */
async function spend(): Promise<{ count: number; nanoUsd: bigint; balance: bigint }> {
  const [status] = await app.budgets.status('e2e', PAYER)
  const balance = await app.wallets.getBalance({
    tenantId: 'e2e',
    ownerType: 'user',
    ownerId: 'u1',
  })
  return {
    count: status?.spent.count ?? -1,
    nanoUsd: status?.spent.nanoUsd ?? -1n,
    balance: balance.nanoUsd,
  }
}

/** The number of ledger rows stored under a key. */
async function rowsFor(key: string): Promise<number> {
  const rows = await app.ledger.query({ tenantId: 'e2e' })
  return rows.filter((row) => row.idempotencyKey === key).length
}

/** The typed error code behind a rejected call. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

describe('E2E — a retry returns the stored row and moves nothing again', () => {
  /** The retry names no occurredAt, so its defaulted value differs from the stored one. */
  it('returns the stored row for a retry without an occurredAt, with one budget consume', async () => {
    const context = e2eContext({ idempotencyKey: 'replay-default', enforce: true })
    const first = await app.metering.record({
      usage: e2eUsage(),
      context,
      occurredAt: new Date('2026-06-15T12:00:00.000Z'),
    })
    const afterFirst = await spend()

    const second = await app.metering.record({ usage: e2eUsage(), context })

    expect(second.id).toBe(first.id)
    expect(await spend()).toEqual(afterFirst)
    expect(await rowsFor('replay-default')).toBe(1)
  })

  /** The retry repeats the stored occurredAt, which the ledger itself would accept as a replay. */
  it('returns the stored row for a retry with the same occurredAt, with one budget consume', async () => {
    const context = e2eContext({ idempotencyKey: 'replay-same-time', enforce: true })
    const occurredAt = new Date('2026-06-15T12:00:00.123Z')
    const first = await app.metering.record({ usage: e2eUsage(), context, occurredAt })
    const afterFirst = await spend()

    const second = await app.metering.record({ usage: e2eUsage(), context, occurredAt })

    expect(second.id).toBe(first.id)
    expect(await spend()).toEqual(afterFirst)
  })

  /** The price is computed while serving the call; a retry after it changed gets the original record. */
  it('returns the stored row, at its original cost, after the price changed', async () => {
    const context = e2eContext({ idempotencyKey: 'replay-price', enforce: true })
    const first = await app.metering.record({ usage: e2eUsage(), context })
    await seedPrice(app.pricing, {
      inputNanoUsdPerMillion: 9_000_000_000n,
      outputNanoUsdPerMillion: 90_000_000_000n,
    })

    const second = await app.metering.record({ usage: e2eUsage(), context })

    expect(second.id).toBe(first.id)
    expect(second.rawCostNanoUsd).toBe(first.rawCostNanoUsd)
    expect(await rowsFor('replay-price')).toBe(1)
  })

  /** A row with no optional field set comes back from the mapper with those keys absent. */
  it('matches a stored row whose optional fields are all null', async () => {
    const context = e2eContext({ idempotencyKey: 'replay-nulls' })
    const first = await app.metering.record({ usage: e2eUsage(), context })
    const second = await app.metering.record({ usage: e2eUsage(), context })
    expect(second.id).toBe(first.id)
  })

  /** Every optional field set, with an array of tags, comes back equal after the round trip. */
  it('matches a stored row with every optional field set', async () => {
    const context = e2eContext({
      idempotencyKey: 'replay-full',
      enforce: true,
      beneficiary: { type: 'team', id: 'team-1' },
      requestedBy: 'actor-1',
      tags: ['team:research', 'env:test'],
      extraUnits: { web_search_requests: 2 },
      correlationId: 'corr-1',
      isSystemCost: false,
      systemCostCategory: 'retry',
      baseModel: 'gpt-5',
    })
    const first = await app.metering.record({ usage: e2eUsage(), context })
    const afterFirst = await spend()

    const second = await app.metering.record({ usage: e2eUsage(), context })

    expect(second.id).toBe(first.id)
    expect(second.tags).toEqual(['team:research', 'env:test'])
    expect(await spend()).toEqual(afterFirst)
  })

  /** Two simultaneous calls with one key take turns in the process and consume once. */
  it('consumes once for two concurrent calls with one key', async () => {
    const context = e2eContext({ idempotencyKey: 'replay-concurrent', enforce: true })
    const before = await spend()

    const [a, b] = await Promise.all([
      app.metering.record({ usage: e2eUsage(), context }),
      app.metering.record({ usage: e2eUsage(), context }),
    ])

    const after = await spend()
    expect(b.id).toBe(a.id)
    expect(after.count - before.count).toBe(1)
    expect(await rowsFor('replay-concurrent')).toBe(1)
  })

  /** A different request under the key is still a conflict, and it consumes nothing. */
  it('conflicts for a different request and consumes nothing', async () => {
    const context = e2eContext({ idempotencyKey: 'replay-conflict', enforce: true })
    await app.metering.record({ usage: e2eUsage(), context })
    const afterFirst = await spend()

    const error = await app.metering
      .record({ usage: e2eUsage({ inputTokens: 2000 }), context })
      .catch((e: unknown) => e)

    expect(codeOf(error)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
    expect(await spend()).toEqual(afterFirst)
  })
})
