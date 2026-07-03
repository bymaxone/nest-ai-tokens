/**
 * @fileoverview E2E scenario 3 (spec §19.2, §5.6): a stream that aborts before its
 * final usage chunk still bills — the collector counts the partial output via the
 * tokenizer, and `capture()` supplies the input tokens from the hold estimate (the
 * §5.6 fallback order). Settled against real PostgreSQL.
 * @layer test
 */

import { StreamUsageCollector, type HoldEstimate, type ITokenizer } from '@bymax-one/nest-ai-tokens'
import { bootMeteringModule, e2eContext, grantWallet, seedPrice, startPostgres, type Booted, type PostgresFixture } from './harness'

const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 800, maxOutputTokens: 400 }

/** A word-count tokenizer. */
const wordTokenizer: ITokenizer = { countTokens: ({ text }): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length) }

let pg: PostgresFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  app = await bootMeteringModule({ store: pg.store })
  await seedPrice(app.pricing)
  await grantWallet(app.wallets, 100_000_000n)
}, 180_000)

afterAll(async () => {
  await app.close()
  await pg.stop()
})

describe('E2E — stream abort (§5.6)', () => {
  /** An aborted stream bills the tokenizer-counted output; input follows the hold estimate. */
  it('bills a tokenizer-counted partial on abort', async () => {
    const hold = await app.metering.hold(e2eContext({ idempotencyKey: 'stream-1' }), ESTIMATE)
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.push({ choices: [{ delta: { content: 'the quick brown' } }] })
    collector.push({ choices: [{ delta: { content: ' fox jumps' } }] })
    // no final usage chunk — the stream aborted
    const record = await app.metering.capture(hold, collector)
    expect(record.status).toBe('posted')
    expect(record.outputTokens).toBe(5) // tokenizer word count
    expect(record.inputTokens).toBe(1_200) // hold.estimatedTokens (800 + 400) — the §5.6 input fallback
    expect(record.billedCostNanoUsd).toBeGreaterThan(0n)
  })
})
