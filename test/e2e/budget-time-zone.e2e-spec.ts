/**
 * @fileoverview E2E: a budget's `createdAt` anchors its 'total' window and its custom window when no `anchorAt` is
 * set, so it must be written in UTC whatever zone the database session uses. Spend is recomputed from the ledger
 * over `occurredAt >= windowStart`: a `createdAt` stamped east of UTC lies in the future, the recompute finds
 * nothing, and a blocked tenant spends past its limit. Each case runs on a database whose session zone is UTC
 * (control), west of UTC and east of UTC.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import type { AiTokensException } from '@bymax-one/nest-ai-tokens'
import type { AiTokensErrorResponse } from '@bymax-one/nest-ai-tokens/shared'
import { bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, upsertBudget, type Booted, type PostgresFixture } from './harness'

const MIGRATION = join(__dirname, '../../src/prisma/migrations/0001_init.sql')
const QUERY = readFileSync(join(__dirname, 'sql/detect-shifted-budget-timestamps.sql'), 'utf8')
const ZONES = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo'] as const
const MINUTE_MS = 60_000
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

/** A booted module over a fresh database whose sessions use `zone`. */
async function appInZone(zone: string): Promise<{ app: Booted; client: PrismaClient }> {
  databases += 1
  const name = `bt_${databases}_${zone.replace(/[^a-z]/gi, '_').toLowerCase()}`
  await pg.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  await pg.prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" SET timezone TO '${zone}'`)
  const url = pg.url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`)
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  clients.push(client)
  for (const statement of migrationStatements()) await client.$executeRawUnsafe(statement)
  const app = await bootMeteringModule({ store: new PrismaAiTokensStore(client) })
  await seedPrice(app.pricing)
  await grantWallet(app.wallets, 100_000_000n)
  return { app, client }
}

/** The error code a failed call carries. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

describe.each(ZONES)('budget timestamps on a database whose session zone is %s', (zone) => {
  /** A budget created now has a createdAt within a minute of now, whatever the zone. */
  it('stamps createdAt on the UTC clock', async () => {
    const { app } = await appInZone(zone)
    const budget = await upsertBudget(app.budgets, { window: 'total', limitTokens: 3000 })

    expect(Math.abs(budget.createdAt.getTime() - Date.now())).toBeLessThan(MINUTE_MS)
    await app.close()
  })

  /** QA's repro: limit 1000, two calls of 400, reconcile, and the third call of 400 is still refused. */
  it('keeps a total-window budget blocking after reconcileWindow', async () => {
    const { app } = await appInZone(zone)
    const budget = await upsertBudget(app.budgets, { window: 'total', limitTokens: 1000 })
    const meter = (key: string): Promise<unknown> =>
      app.metering.record({ usage: e2eUsage({ inputTokens: 400, outputTokens: 0 }), context: e2eContext({ idempotencyKey: key, enforce: true }) })
    await meter('b1')
    await meter('b2')
    const before = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(before?.spent.tokens).toBe(800)

    await app.budgets.reconcileWindow(budget.id, 'e2e', before?.windowStart as Date)

    const after = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(after?.spent.tokens).toBe(800)
    const third = await meter('b3').catch((e: unknown) => e)
    expect(codeOf(third)).toBe('AI_TOKENS_QUOTA_EXCEEDED')
    await app.close()
  })

  /** A two-hour custom window with no anchor starts within two hours of now and survives a recompute. */
  it('places a two-hour custom window around now and keeps its spend through reconcileWindow', async () => {
    const { app } = await appInZone(zone)
    const budget = await upsertBudget(app.budgets, { window: { customSeconds: 7_200 }, limitTokens: 3000 })
    await app.metering.record({ usage: e2eUsage(), context: e2eContext({ idempotencyKey: 'c1', enforce: true }) })
    const before = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    const start = before?.windowStart as Date
    expect(Date.now() - start.getTime()).toBeGreaterThanOrEqual(0)
    expect(Date.now() - start.getTime()).toBeLessThan(2 * HOUR_MS)
    expect(before?.spent.tokens).toBe(1500)

    await app.budgets.reconcileWindow(budget.id, 'e2e', start)

    const after = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(after?.spent.tokens).toBe(1500)
    await app.close()
  })

  /** The operator query reads about zero hours from now for a budget the store wrote. */
  it('lists no shifted budget for one the store wrote', async () => {
    const { app, client } = await appInZone(zone)
    await upsertBudget(app.budgets, { window: 'total', limitTokens: 3000 })

    const rows = await client.$queryRawUnsafe<{ hoursFromNow: string }[]>(QUERY)

    expect(rows).toHaveLength(1)
    expect(Math.abs(Number(rows[0]?.hoursFromNow))).toBeLessThan(0.1)
    await app.close()
  })
})

/** A budget inserted without createdAt takes the session-zone default, which the query exposes as the zone's offset. */
describe('detect-shifted-budget-timestamps.sql', () => {
  it.each([
    ['Asia/Tokyo', 9],
    ['America/Sao_Paulo', -3],
  ] as const)('reports a budget stamped by the database in %s', async (zone, hours) => {
    const { app, client } = await appInZone(zone)
    await client.$executeRawUnsafe(
      `INSERT INTO "ai_budgets" ("id", "tenantId", "scopeType", "scopeId", "features", "window", "softThresholds", "policy")
       VALUES ('legacy', 'e2e', 'tenant', 'e2e', ARRAY[]::text[], 'total', '[]'::jsonb, 'block')`,
    )

    const rows = await client.$queryRawUnsafe<{ hoursFromNow: string; sessionZone: string }[]>(QUERY)

    expect(rows.map((row) => row.sessionZone)).toEqual([zone])
    expect(Number(rows[0]?.hoursFromNow)).toBeCloseTo(hours, 0)
    await app.close()
  })
})
