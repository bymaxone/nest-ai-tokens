/**
 * @fileoverview E2E: a price's `effectiveFrom` and `effectiveTo` are `TIMESTAMP` columns without a zone, and the
 * rate lookup compares them with an application instant. They only agree if a `Date` reaches the database as the
 * same UTC wall-clock value whatever the zone of the session and whatever type the client gives the parameter, so
 * each case runs on a database whose session zone is UTC (control), west of UTC and east of UTC.
 * @layer test
 */

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { startPostgres, type PostgresFixture } from './harness'
import { shippedMigrationSql } from './migration-files'

const ZONES = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo'] as const
const HOUR_MS = 3_600_000
const FROM = new Date('2026-06-01T12:00:00.000Z')

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
  return shippedMigrationSql()
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/** A store on a fresh database whose sessions use `zone`. */
async function storeInZone(zone: string): Promise<PrismaAiTokensStore> {
  databases += 1
  const name = `pt_${databases}_${zone.replace(/[^a-z]/gi, '_').toLowerCase()}`
  await pg.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  await pg.prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" SET timezone TO '${zone}'`)
  const url = pg.url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`)
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  clients.push(client)
  for (const statement of migrationStatements()) await client.$executeRawUnsafe(statement)
  return new PrismaAiTokensStore(client)
}

const price = (inputNanoUsdPerMillion: bigint, effectiveFrom: Date) =>
  ({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputNanoUsdPerMillion, effectiveFrom }) as const

describe.each(ZONES)('price effective dates on a database whose session zone is %s', (zone) => {
  /** The instant a price is given is the instant it is stored and read back. */
  it('stores effectiveFrom as the instant it was given', async () => {
    const store = await storeInZone(zone)
    const stored = await store.upsertPrice(price(10n, FROM))
    expect(stored.effectiveFrom.toISOString()).toBe(FROM.toISOString())
  })

  /** The rate is found from its first instant and not before it, an hour either side of the boundary. */
  it('finds a price from its effectiveFrom and not before it', async () => {
    const store = await storeInZone(zone)
    await store.upsertPrice(price(10n, FROM))
    const lookup = (at: Date) => store.resolveRate('openai', 'gpt-5', 'chat', 'standard', at)
    expect(await lookup(new Date(FROM.getTime() - HOUR_MS))).toBeNull()
    expect((await lookup(new Date(FROM.getTime() + HOUR_MS)))?.inputNanoUsdPerMillion).toBe(10n)
  })

  /** A newer price closes the older one at the newer one's first instant, and each answers on its own side of it. */
  it('closes the previous price at the instant the next one starts', async () => {
    const store = await storeInZone(zone)
    const next = new Date(FROM.getTime() + 24 * HOUR_MS)
    await store.upsertPrice(price(10n, FROM))
    await store.upsertPrice(price(20n, next))
    const lookup = (at: Date) => store.resolveRate('openai', 'gpt-5', 'chat', 'standard', at)
    expect((await lookup(new Date(next.getTime() - HOUR_MS)))?.inputNanoUsdPerMillion).toBe(10n)
    expect((await lookup(new Date(next.getTime() + HOUR_MS)))?.inputNanoUsdPerMillion).toBe(20n)
    const history = await store.getPriceHistory('openai', 'gpt-5', 'chat', 'standard')
    expect(history.find((row) => row.inputNanoUsdPerMillion === 10n)?.effectiveTo?.toISOString()).toBe(next.toISOString())
  })
})
