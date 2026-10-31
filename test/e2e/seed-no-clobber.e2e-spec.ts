/**
 * @fileoverview E2E (spec §6.4): a later boot never touches price history. A sequential
 * second boot adds no rows, and a rate the host set with `upsertPrice` stays the open
 * row. Against real PostgreSQL.
 * @layer test
 */

import { MODEL_PRICES_SEED } from '@bymax-one/nest-ai-tokens/prices'
import { bootMeteringModule, startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture

beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)

afterAll(async () => {
  await pg.stop()
})

/** Row counts of the price table: all rows, closed rows, and open rows. */
async function priceCounts(): Promise<{ total: bigint; closed: bigint; open: bigint }> {
  const rows = await pg.prisma.$queryRaw<{ total: bigint; closed: bigint; open: bigint }[]>`
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE "effectiveTo" IS NOT NULL)::bigint AS closed,
           COUNT(*) FILTER (WHERE "effectiveTo" IS NULL)::bigint AS open
    FROM "ai_model_prices"`
  return rows[0] ?? { total: -1n, closed: -1n, open: -1n }
}

describe('E2E — a later boot leaves price history alone (§6.4)', () => {
  /** Boot twice in sequence: the second boot finds every key seeded and writes nothing. */
  it('adds no rows on a sequential second boot', async () => {
    const first = await bootMeteringModule({ store: pg.store, seedFromSnapshot: true })
    await first.close()
    const afterFirst = await priceCounts()
    const second = await bootMeteringModule({ store: pg.store, seedFromSnapshot: true })
    await second.close()
    const afterSecond = await priceCounts()
    console.log('seed counts', { afterFirst, afterSecond })
    expect(afterFirst.total).toBe(BigInt(MODEL_PRICES_SEED.length))
    expect(afterSecond).toEqual(afterFirst)
    expect(afterSecond.closed).toBe(0n)
  })

  /** A rate the host set is the open row before a restart and still is after it. */
  it('keeps a host price override as the open row across a boot', async () => {
    const seeded = MODEL_PRICES_SEED.find(
      (row) => row.model === 'gpt-5' && (row.serviceTier ?? 'standard') === 'standard',
    )
    if (seeded === undefined) throw new Error('seed row for gpt-5 not found')
    const host = await bootMeteringModule({ store: pg.store, seedFromSnapshot: true })
    const overrideFrom = new Date('2026-09-01T00:00:00.000Z')
    await host.pricing.upsertPrice({
      ...seeded,
      inputNanoUsdPerMillion: 999n,
      effectiveFrom: overrideFrom,
      source: 'host',
    })
    await host.close()
    const before = await priceCounts()

    const restarted = await bootMeteringModule({ store: pg.store, seedFromSnapshot: true })
    const rate = await restarted.pricing.resolveRate({
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      at: new Date(),
    })
    const history = await restarted.pricing.getPriceHistory('openai', 'gpt-5', 'chat', 'standard')
    await restarted.close()
    const after = await priceCounts()
    console.log('override counts', {
      before,
      after,
      open: history
        .filter((h) => h.effectiveTo === null)
        .map((h) => [h.source, h.inputNanoUsdPerMillion, h.effectiveFrom]),
    })
    expect(rate?.inputNanoUsdPerMillion).toBe(999n)
    expect(history.filter((h) => h.effectiveTo === null)).toHaveLength(1)
    expect(after).toEqual(before)
  })
})
