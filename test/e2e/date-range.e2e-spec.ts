/**
 * @fileoverview E2E: the instants the service accepts as a date, from the year 1 to the year 9999, are the instants PostgreSQL
 * stores and reads back as they were given. A date outside that range is refused by the service by name before it reaches the
 * store, because the store's own failure for it does not say which input it was.
 * @layer test
 */

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { startPostgres, type PostgresFixture } from './harness'
import { shippedMigrationSql } from './migration-files'

/** The first and the last instant the service accepts, in milliseconds since the epoch. */
const FIRST_MS = -62_135_596_800_000
const LAST_MS = 253_402_300_799_999

let pg: PostgresFixture
let client: PrismaClient
let store: PrismaAiTokensStore

beforeAll(async () => {
  pg = await startPostgres()
  const name = 'date_range'
  await pg.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`) }) })
  const statements = shippedMigrationSql()
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
  for (const statement of statements) await client.$executeRawUnsafe(statement)
  store = new PrismaAiTokensStore(client)
}, 180_000)

afterAll(async () => {
  await client.$disconnect()
  await pg.stop()
})

const price = (model: string, effectiveFrom: Date) =>
  ({ provider: 'openai', model, operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n, effectiveFrom }) as const

describe('the dates a store holds', () => {
  it.each([FIRST_MS, 0, LAST_MS])('keeps the instant %p as it was given', async (ms) => {
    const row = await store.upsertPrice(price(`m${String(ms)}`, new Date(ms)))
    expect(row.effectiveFrom.getTime()).toBe(ms)
  })

  /** One millisecond outside either end, and at the ends of a JS Date, the store itself fails: this is the range the service guards. */
  it.each([FIRST_MS - 1, LAST_MS + 1, -8.64e15, 8.64e15])('fails on the instant %p, which is why the service refuses it first', async (ms) => {
    await expect(store.upsertPrice(price(`o${String(ms)}`, new Date(ms)))).rejects.toBeInstanceOf(AiTokensException)
  })
})
