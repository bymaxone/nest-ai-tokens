/**
 * @fileoverview E2E scenario 8 (spec §19.2, §6.4): two module boots against one
 * database seed the price registry EXACTLY ONCE — the advisory lock
 * (`acquireSeedLock`) makes the snapshot seed idempotent. Against real PostgreSQL.
 * @layer test
 */

import { MODEL_PRICES_SEED } from '@bymax-one/nest-ai-tokens/prices'
import { bootMeteringModule, startPostgres, type Booted, type PostgresFixture } from './harness'

let pg: PostgresFixture
let appA: Booted
let appB: Booted

beforeAll(async () => {
  pg = await startPostgres()
  // Two independent boots (independent Prisma connections) racing the one-time seed.
  ;[appA, appB] = await Promise.all([
    bootMeteringModule({ store: pg.store, seedFromSnapshot: true }),
    bootMeteringModule({ store: pg.storeB, seedFromSnapshot: true }),
  ])
}, 180_000)

afterAll(async () => {
  await appA.close()
  await appB.close()
  await pg.stop()
})

describe('E2E — seed idempotence (§6.4)', () => {
  /** The price table holds exactly one row per seeded tuple (no double seed). */
  it('seeds the registry exactly once across two boots', async () => {
    const rows = await pg.prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*)::bigint AS count FROM "ai_model_prices"`
    expect(rows[0]?.count).toBe(BigInt(MODEL_PRICES_SEED.length))
  })
})
