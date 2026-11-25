/**
 * @fileoverview E2E: migrations 0004 and 0005 on a database that already holds wallet data from 0001–0003. The rows survive, an old
 * row keeps a null sequence and sorts first, a new entry takes the next sequence, and the rollback each file documents restores the
 * schema of 0003 with the data intact.
 * @layer test
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { grantEntry } from '../contracts/wallet-store.contract'
import { POSTGRES_IMAGE } from './images'

const DIRECTORY = join(__dirname, '../../src/prisma/migrations')

/** The statements of one migration file, comment lines stripped. */
function statementsOf(file: string): string[] {
  return readFileSync(join(DIRECTORY, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/** The rollback statements a migration documents in its header: the commented lines that start with two spaces and a SQL verb. */
function rollbackOf(file: string): string[] {
  return readFileSync(join(DIRECTORY, file), 'utf8')
    .split('\n')
    .filter((line) => /^--\s{3}(ALTER|DROP)\b/.test(line))
    .map((line) => line.replace(/^--\s+/, ''))
}

let container: StartedPostgreSqlContainer
let prisma: PrismaClient

beforeAll(async () => {
  container = await new PostgreSqlContainer(process.env['AI_TOKENS_E2E_PG_IMAGE'] ?? POSTGRES_IMAGE).start()
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: container.getConnectionUri() }) })
}, 180_000)

afterAll(async () => {
  await prisma.$disconnect()
  await container.stop()
})

/** The columns of a table, sorted. */
async function columnsOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY column_name`)
  return rows.map((row) => row.column_name)
}

describe('migrations 0004 and 0005 on a populated database', () => {
  /** Upgrade keeps old rows, new entries are ordered after them, and the documented rollback returns to 0003 with the data intact. */
  it('upgrades a database with wallet data, orders old rows first, and rolls back cleanly', async () => {
    const files = readdirSync(DIRECTORY).filter((name) => name.endsWith('.sql')).sort()
    for (const file of files.filter((name) => name < '0004')) for (const statement of statementsOf(file)) await prisma.$executeRawUnsafe(statement)
    const entryColumnsBefore = await columnsOf('ai_wallet_entries')
    const walletColumnsBefore = await columnsOf('ai_wallets')
    await prisma.$executeRawUnsafe(`INSERT INTO "ai_wallets" ("id","tenantId","ownerType","ownerId","balanceNanoUsd") VALUES ('w1','t','user','u',10)`)
    await prisma.$executeRawUnsafe(`INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","idempotencyKey") VALUES ('old-1','w1','grant',10,'old')`)

    for (const file of files.filter((name) => name >= '0004')) for (const statement of statementsOf(file)) await prisma.$executeRawUnsafe(statement)
    const store = new PrismaAiTokensStore(prisma)
    const ref = { tenantId: 't', ownerType: 'user' as const, ownerId: 'u' }
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'new', amountNanoUsd: 5n }))
    const entries = (await store.listEntries(ref)).entries
    expect(entries.map((entry) => [entry.idempotencyKey, entry.seq])).toEqual([['old', undefined], ['new', 1n]])
    expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(15n)

    // Rollback of 0005 then 0004, exactly as their headers print it. The new entry's link and sequence go with the columns.
    for (const file of [...files.filter((name) => name >= '0004')].reverse()) for (const statement of rollbackOf(file)) await prisma.$executeRawUnsafe(statement)
    expect(await columnsOf('ai_wallet_entries')).toEqual(entryColumnsBefore)
    expect(await columnsOf('ai_wallets')).toEqual(walletColumnsBefore)
    const kept = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "ai_wallet_entries"`)
    expect(kept[0]?.n).toBe(2n)
  })
})
