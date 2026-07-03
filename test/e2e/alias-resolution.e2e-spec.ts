/**
 * @fileoverview E2E scenario 7 (spec §19.2, §6.6): a price row for `gpt-5.2` rates
 * a response reporting the dated snapshot `gpt-5.2-2026-03-14` (normalized model
 * resolution), and an Azure deployment name resolves via `baseModel`. Against real
 * PostgreSQL.
 * @layer test
 */

import { bootMeteringModule, e2eContext, e2eUsage, seedPrice, startPostgres, type Booted, type PostgresFixture } from './harness'

let pg: PostgresFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  app = await bootMeteringModule({ store: pg.store })
  await seedPrice(app.pricing, { model: 'gpt-5.2' })
}, 180_000)

afterAll(async () => {
  await app.close()
  await pg.stop()
})

describe('E2E — model alias/deployment resolution (§6.6)', () => {
  /** A dated snapshot model resolves to its base price row. */
  it('rates a dated snapshot against the base model price', async () => {
    const record = await app.metering.record({
      usage: e2eUsage({ model: 'gpt-5.2-2026-03-14', inputTokens: 1000, outputTokens: 500 }),
      context: e2eContext({ idempotencyKey: 'alias-1' }),
    })
    expect(record.priceMissing).toBe(false)
    expect(record.rawCostNanoUsd).toBe(6_250_000n) // 1000×1.25/M + 500×10/M
  })

  /** An Azure deployment name resolves via context.baseModel. */
  it('rates an Azure deployment via baseModel', async () => {
    const record = await app.metering.record({
      usage: e2eUsage({ model: 'my-azure-deployment', inputTokens: 1000, outputTokens: 500 }),
      context: e2eContext({ idempotencyKey: 'alias-2', baseModel: 'gpt-5.2' }),
    })
    expect(record.priceMissing).toBe(false)
    expect(record.requestedModel).toBe('gpt-5.2')
    expect(record.rawCostNanoUsd).toBe(6_250_000n)
  })
})
