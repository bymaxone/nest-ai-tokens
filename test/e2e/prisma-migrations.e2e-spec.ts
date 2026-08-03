/**
 * @fileoverview Testcontainers smoke for the official Prisma adapter: apply the
 * shipped migration on a fresh PostgreSQL container, verify both partial indexes,
 * and exercise the ledger + pricing halves (exactly-once append, transition race
 * across two connections, effective-dated upsert under concurrency, the advisory
 * seed lock, unitRates round-trip, and the hash chain) against the real database.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { NewUsageRecord } from '@bymax-one/nest-ai-tokens/shared'
import { AiTokensException, LedgerService } from '@bymax-one/nest-ai-tokens'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'

const MIGRATION = join(__dirname, '../../src/prisma/migrations/0001_init.sql')

/**
 * Build a client for a Testcontainers database.
 *
 * Prisma 7 removed `datasourceUrl` from the constructor: a client is now opened
 * through a driver adapter, so the connection string reaches the database through
 * `@prisma/adapter-pg` rather than through Prisma's own engine. The library never
 * does this — the host application constructs the client and hands it over — so
 * this lives in the test harness, which is the only place here that owns one.
 */
function clientFor(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
}

/** Split the shipped migration into individual statements (comment lines stripped first). */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/** Build a complete `NewUsageRecord`; `over` replaces any field under test. */
function makeRecord(over: Partial<NewUsageRecord> = {}): NewUsageRecord {
  return {
    tenantId: 't1',
    scope: { type: 'user', id: 'u1' },
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    feature: 'chat.reply',
    tags: [],
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
    totalTokens: 1500,
    priceVersionId: null,
    rawCostNanoUsd: 6_250_000n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 25_000_000n,
    markupMultiplier: 4,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    idempotencyKey: 'k1',
    isSystemCost: false,
    enforced: false,
    occurredAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  }
}

describe('PrismaAiTokensStore (Testcontainers PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer
  let prisma: PrismaClient
  let prismaB: PrismaClient
  let store: PrismaAiTokensStore
  let storeB: PrismaAiTokensStore

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start()
    const url = container.getConnectionUri()
    prisma = clientFor(url)
    prismaB = clientFor(url)
    for (const statement of migrationStatements()) await prisma.$executeRawUnsafe(statement)
    store = new PrismaAiTokensStore(prisma)
    storeB = new PrismaAiTokensStore(prismaB)
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await prismaB.$disconnect()
    await container.stop()
  })

  /** Both PostgreSQL partial indexes are present (they cannot be expressed in Prisma). */
  it('creates both partial indexes', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('ai_model_prices_open_row_key', 'ai_usage_records_pending_createdAt_idx')
    `
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'ai_model_prices_open_row_key',
      'ai_usage_records_pending_createdAt_idx',
    ])
  })

  /** Append persists; a matching replay returns the same row; a mismatch conflicts. */
  it('appends, replays, and conflicts on the idempotency key', async () => {
    const first = await store.append(makeRecord({ idempotencyKey: 'append-1' }), 'hash-A')
    expect(first.id).toBeDefined()
    expect(first.rawCostNanoUsd).toBe(6_250_000n)
    expect(first.markupMultiplier).toBe(4)

    const replay = await store.append(makeRecord({ idempotencyKey: 'append-1' }), 'hash-A')
    expect(replay.id).toBe(first.id)

    await expect(store.append(makeRecord({ idempotencyKey: 'append-1' }), 'hash-B')).rejects.toMatchObject({
      isAiTokensLedgerConflict: true,
    })
  })

  /** Two connections racing the same pending → posted transition: exactly one wins. */
  it('lets exactly one connection win a transition race', async () => {
    const hold = await store.append(makeRecord({ idempotencyKey: 'race-1', status: 'pending' }), 'hash-hold')
    const results = await Promise.all([
      store.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 1n }),
      storeB.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 2n }),
    ])
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })

  /** pending → released persists a legal audit annotation (matching the service contract). */
  it('persists a legal annotation on a release', async () => {
    const hold = await store.append(makeRecord({ idempotencyKey: 'release-1', status: 'pending' }), 'hash-rel')
    const released = await store.transition(hold.id, 'pending', 'released', { correlationId: 'corr-release' })
    expect(released?.status).toBe('released')
    expect(released?.correlationId).toBe('corr-release')
  })

  /** A settlement patch that targets an immutable identity column is rejected, never silently dropped. */
  it('rejects an out-of-whitelist key on a settlement', async () => {
    const hold = await store.append(makeRecord({ idempotencyKey: 'reject-posted', status: 'pending' }), 'hash-rp')
    await expect(store.transition(hold.id, 'pending', 'posted', { tenantId: 'hijacked' })).rejects.toBeInstanceOf(
      AiTokensException,
    )
    const untouched = await store.findById(hold.id)
    expect(untouched?.status).toBe('pending')
    expect(untouched?.tenantId).toBe('t1')
  })

  /** An amount patch on a release is rejected (a void never rewrites amounts). */
  it('rejects an amount patch on a release', async () => {
    const hold = await store.append(makeRecord({ idempotencyKey: 'reject-released', status: 'pending' }), 'hash-rr')
    await expect(store.transition(hold.id, 'pending', 'released', { billedCostNanoUsd: 1n })).rejects.toBeInstanceOf(
      AiTokensException,
    )
    const untouched = await store.findById(hold.id)
    expect(untouched?.status).toBe('pending')
  })

  /** Concurrent effective-dated upserts keep exactly one open row for the key. */
  it('keeps one open price row under concurrent upserts', async () => {
    const base = { provider: 'openai', model: 'race-model', operation: 'chat' as const, serviceTier: 'standard' as const }
    await Promise.all([
      store.upsertPrice({ ...base, inputNanoUsdPerMillion: 100n }),
      storeB.upsertPrice({ ...base, inputNanoUsdPerMillion: 200n }),
    ])
    const open = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "ai_model_prices"
      WHERE "provider" = 'openai' AND "model" = 'race-model' AND "operation" = 'chat'
        AND "serviceTier" = 'standard' AND "effectiveTo" IS NULL
    `
    expect(open[0]?.count).toBe(1n)
  })

  /** The advisory seed lock lets only one of two concurrent seeders proceed. */
  it('grants the seed lock to exactly one concurrent seeder', async () => {
    const [a, b] = await Promise.all([store.acquireSeedLock('seed-test'), storeB.acquireSeedLock('seed-test')])
    expect([a, b].filter((acquired) => acquired)).toHaveLength(1)
  })

  /** unitRates round-trip losslessly as decimal strings ↔ bigint. */
  it('round-trips unitRates as bigint', async () => {
    await store.upsertPrice({
      provider: 'anthropic',
      model: 'claude',
      operation: 'chat',
      serviceTier: 'standard',
      inputNanoUsdPerMillion: 3_000_000_000n,
      unitRates: { web_search_requests: 10_000_000n },
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    })
    const rate = await store.resolveRate('anthropic', 'claude', 'chat', 'standard', new Date('2026-06-01T00:00:00.000Z'))
    expect(rate?.unitRates).toEqual({ web_search_requests: 10_000_000n })
    expect(rate?.inputNanoUsdPerMillion).toBe(3_000_000_000n)
  })

  /** sumCost aggregates posted + reversed rows into exact bigint totals. */
  it('aggregates sumCost over the filtered rows', async () => {
    const tenantId = 'sum-tenant'
    await store.append(makeRecord({ tenantId, idempotencyKey: 's1', rawCostNanoUsd: 100n, billedCostNanoUsd: 400n }), 'h1')
    await store.append(makeRecord({ tenantId, idempotencyKey: 's2', rawCostNanoUsd: 30n, billedCostNanoUsd: 120n }), 'h2')
    const summary = await store.sumCost({ tenantId, status: ['posted', 'reversed'] })
    expect(summary.rawCostNanoUsd).toBe(130n)
    expect(summary.billedCostNanoUsd).toBe(520n)
    expect(summary.records).toBe(2)
    expect(summary.totalTokens).toBe(3000)
  })

  /** The hash chain verifies against the real database (advisory-locked settlement hashing). */
  it('builds and verifies a hash chain', async () => {
    const service = new LedgerService(store, { ledger: { hashChain: true } })
    await service.append(makeRecord({ tenantId: 'chain-t' }), 'c1')
    await service.append(makeRecord({ tenantId: 'chain-t', inputTokens: 5 }), 'c2')
    const result = await service.verifyChain('chain-t')
    expect(result).toEqual({ valid: true })
  })
})
