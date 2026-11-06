/**
 * @fileoverview E2E: a usage record's `createdAt` and `updatedAt` are `TIMESTAMP` columns without a zone, so they
 * are only comparable with an application instant (the hold reaper's cutoff) if the store writes them in UTC,
 * whatever zone the database session uses. Each case runs on a database whose session zone is UTC (control), west
 * of UTC and east of UTC.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import type { NewUsageRecord } from '@bymax-one/nest-ai-tokens/shared'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { startPostgres, type PostgresFixture } from './harness'

const MIGRATION = join(__dirname, '../../src/prisma/migrations/0001_init.sql')
const ZONES = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo'] as const
const HOUR_MS = 3_600_000

let pg: PostgresFixture
const clients: PrismaClient[] = []
let databases = 0

beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)

afterAll(async () => {
  for (const client of clients) await client.$disconnect()
  await pg.stop()
})

/** Split the shipped migration into individual statements. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/** A store and its client on a fresh database whose sessions use `zone`. */
async function storeInZone(zone: string): Promise<{ store: PrismaAiTokensStore; client: PrismaClient }> {
  databases += 1
  const name = `ut_${databases}_${zone.replace(/[^a-z]/gi, '_').toLowerCase()}`
  await pg.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  await pg.prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" SET timezone TO '${zone}'`)
  const url = pg.url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`)
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  clients.push(client)
  for (const statement of migrationStatements()) await client.$executeRawUnsafe(statement)
  return { store: new PrismaAiTokensStore(client), client }
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

describe.each(ZONES)('usage record timestamps on a database whose session zone is %s', (zone) => {
  /** A hold created just now is not expired, whatever the zone: a one-hour TTL has not elapsed. */
  it('does not report a hold created just now as expired', async () => {
    const { store } = await storeInZone(zone)
    await store.append(makeRecord({ idempotencyKey: 'fresh', status: 'pending' }), 'hash-fresh')

    const expired = await store.findExpiredHolds(new Date(Date.now() - HOUR_MS), 10)

    expect(expired.map((record) => record.idempotencyKey)).toEqual([])
  })

  /** A hold the database stamped two hours ago is expired for a one-hour TTL, whatever the zone. */
  it('reports a hold created two hours ago as expired', async () => {
    const { store, client } = await storeInZone(zone)
    await store.append(makeRecord({ idempotencyKey: 'old', status: 'pending' }), 'hash-old')
    // Two hours earlier than the store stamped it: what it would have stamped two hours ago on the same clock.
    await client.$executeRawUnsafe(`UPDATE "ai_usage_records" SET "createdAt" = "createdAt" - interval '2 hours'`)

    const expired = await store.findExpiredHolds(new Date(Date.now() - HOUR_MS), 10)

    expect(expired.map((record) => record.idempotencyKey)).toEqual(['old'])
  })

  /** The `createdAt` of the record returned is the instant it was created, within seconds. */
  it('returns a createdAt that is the instant the record was created', async () => {
    const { store } = await storeInZone(zone)
    const stored = await store.append(makeRecord({ idempotencyKey: 'stamp' }), 'hash-stamp')

    expect(Math.abs(stored.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
  })
})

/**
 * In a zone with daylight saving time the session clock repeats an hour at fall-back, so a `createdAt` taken from it
 * can go backwards and rows sort in the wrong order. A `createdAt` that is the UTC instant cannot. The transition
 * itself cannot be staged, so the case asserts the invariant that prevents it: each row carries the real instant, and
 * rows list in the order they were created.
 */
describe('usage record timestamps on a database whose session zone has daylight saving time', () => {
  it('stamps the real instant and lists rows in the order they were created', async () => {
    const { store } = await storeInZone('America/New_York')
    const first = await store.append(makeRecord({ idempotencyKey: 'first' }), 'hash-first')
    await new Promise((resolve) => setTimeout(resolve, 25))
    const second = await store.append(makeRecord({ idempotencyKey: 'second' }), 'hash-second')

    expect(Math.abs(first.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
    expect(Math.abs(second.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
    const listed = await store.query({ tenantId: 't1' })
    expect(listed.map((record) => record.idempotencyKey)).toEqual(['first', 'second'])
  })
})

/**
 * The query shipped for operators to find records whose timestamps the database stamped in a session zone that is not
 * UTC. It is read from the file the release notes carry, and run in both directions: east of UTC (createdAt ahead) and
 * west (createdAt behind). A record stamped on the UTC clock is never listed, whatever the zone.
 */
describe.each(['America/Sao_Paulo', 'Asia/Tokyo', 'UTC'] as const)('the query that finds shifted usage records on a database whose zone is %s', (zone) => {
  const QUERY = readFileSync(join(__dirname, 'sql/detect-shifted-usage-timestamps.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')

  /** A record whose timestamps come from the column default, which uses the session zone. */
  async function insertWithSessionZoneDefaults(client: PrismaClient, key: string): Promise<void> {
    await client.$executeRawUnsafe(`
      INSERT INTO "ai_usage_records" ("id", "tenantId", "scopeType", "scopeId", "provider", "model", "operation", "serviceTier", "feature", "tags",
        "inputTokens", "outputTokens", "totalTokens", "rawCostNanoUsd", "surchargeNanoUsd", "billedCostNanoUsd", "markupMultiplier", "currency",
        "priceMissing", "status", "idempotencyKey", "payloadHash", "isSystemCost", "enforced", "occurredAt")
      VALUES ('${key}', 't1', 'user', 'u1', 'openai', 'gpt-5', 'chat', 'standard', 'f', '{}', 1, 1, 2, 1, 0, 1, 1, 'USD', false, 'posted', '${key}', 'h', false, false, now() AT TIME ZONE 'UTC')`)
  }

  it('lists a record stamped by the session-zone default, and not one stamped on the UTC clock', async () => {
    const { store, client } = await storeInZone(zone)
    await insertWithSessionZoneDefaults(client, 'default-stamped')
    await store.append(makeRecord({ idempotencyKey: 'fixed', occurredAt: new Date() }), 'hash-fixed')

    const rows = await client.$queryRawUnsafe<{ id: string; sessionZone: string; hoursApart: string }[]>(QUERY)

    if (zone === 'UTC') {
      expect(rows).toEqual([])
      return
    }
    expect(rows.map((row) => row.id)).toEqual(['default-stamped'])
    expect(rows[0]?.sessionZone).toBe(zone)
    expect(Number(rows[0]?.hoursApart)).toBe(zone === 'Asia/Tokyo' ? 9 : -3)
  })
})

/**
 * The chain tail comes from the chain's own links, not from creation times. Rows stamped in the session zone of a
 * database east of UTC carry a `createdAt` hours in the future of rows stamped in UTC; ordering by `createdAt` would pick
 * the first kind as the tail again and again and fork the chain.
 */
describe('the hash chain on a database east of UTC holding rows stamped in its session zone', () => {
  const FORK_QUERY = readFileSync(join(__dirname, 'sql/detect-forked-usage-chain.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')

  /** A chained posted record written outside the store, with the given links and creation time. */
  async function insertChained(client: PrismaClient, id: string, hash: string, prevHash: string, createdAtSql: string): Promise<void> {
    await client.$executeRawUnsafe(`
      INSERT INTO "ai_usage_records" ("id", "tenantId", "scopeType", "scopeId", "provider", "model", "operation", "serviceTier", "feature", "tags",
        "inputTokens", "outputTokens", "totalTokens", "rawCostNanoUsd", "surchargeNanoUsd", "billedCostNanoUsd", "markupMultiplier", "currency",
        "priceMissing", "status", "idempotencyKey", "payloadHash", "isSystemCost", "enforced", "occurredAt", "prevHash", "hash", "createdAt", "updatedAt")
      VALUES ('${id}', 't1', 'user', 'u1', 'openai', 'gpt-5', 'chat', 'standard', 'f', '{}', 1, 1, 2, 1, 0, 1, 1, 'USD', false, 'posted', '${id}', 'h',
        false, false, now() AT TIME ZONE 'UTC', '${prevHash}', '${hash}', ${createdAtSql}, ${createdAtSql})`)
  }

  /** Each new record links to the newest, whatever the old rows' stamps say. */
  it('links each new record to the previous one although an older row is stamped hours later', async () => {
    const { store, client } = await storeInZone('Asia/Tokyo')
    const first = await store.append(makeRecord({ idempotencyKey: 'A', status: 'posted' }), 'hash-a', true)
    await client.$executeRawUnsafe(`UPDATE "ai_usage_records" SET "createdAt" = "createdAt" + interval '9 hours' WHERE "idempotencyKey" = 'A'`)

    const second = await store.append(makeRecord({ idempotencyKey: 'B', status: 'posted' }), 'hash-b', true)
    const third = await store.append(makeRecord({ idempotencyKey: 'C', status: 'posted' }), 'hash-c', true)

    expect(first.prevHash).toBeUndefined()
    expect(second.prevHash).toBe(first.hash)
    expect(third.prevHash).toBe(second.hash)
    expect(await client.$queryRawUnsafe(FORK_QUERY)).toEqual([])
  })

  /** A chain that already forked still gets a deterministic tail, and the query finds the fork. */
  it('takes the newest of two tails when the chain has already forked, and the query lists the fork', async () => {
    const { store, client } = await storeInZone('Asia/Tokyo')
    const first = await store.append(makeRecord({ idempotencyKey: 'A', status: 'posted' }), 'hash-a', true)
    const second = await store.append(makeRecord({ idempotencyKey: 'B', status: 'posted' }), 'hash-b', true)
    await insertChained(client, 'fork', 'hash-of-the-fork', first.hash as string, `(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 minute'`)

    const forks = await client.$queryRawUnsafe<{ tenantId: string; prevHash: string; records: bigint; ids: string[] }[]>(FORK_QUERY)
    expect(forks.map((row) => [row.tenantId, row.prevHash, Number(row.records), row.ids.length])).toEqual([['t1', first.hash, 2, 2]])
    expect(forks[0]?.ids).toContain(second.id)

    const next = await store.append(makeRecord({ idempotencyKey: 'D', status: 'posted' }), 'hash-d', true)
    expect(next.prevHash).toBe('hash-of-the-fork')
  })
})
