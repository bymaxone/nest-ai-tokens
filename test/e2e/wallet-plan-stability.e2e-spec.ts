/**
 * @fileoverview E2E: the open-grants read keeps a per-grant index-lookup plan when the planner's statistics are stale.
 * Small wallets are analysed, then one wallet grows to thousands of grants and allocations with no further ANALYZE (the
 * state of a large shared table between autovacuum runs). The statement the store actually runs must not group the
 * allocations (whose row estimate would then be taken from the stale statistics) and must stay within a small multiple
 * of the same read taken with a correlated sum per grant.
 * @layer test
 */

import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { GRANT_REMAINING_SQL, CREDITED_SQL, DB_NOW_SQL } from '../../src/prisma/adapter-sql'
import { sql } from '../../src/prisma/sql'
import { grantEntry } from '../contracts/wallet-store.contract'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture
beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)
afterAll(async () => {
  await pg.stop()
})

const BIG: WalletRef = { tenantId: 'plan', ownerType: 'user', ownerId: 'big' }
const GRANTS = 3_000
const OPEN = 10

interface PlanNode {
  'Node Type': string
  Strategy?: string
  Plans?: PlanNode[]
}
interface Explained {
  Plan: PlanNode
  'Execution Time': number
}

/** Every node of a plan tree. */
function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)]
}

/** The statement the store runs for the open grants of `ref`, captured from its raw client. */
async function openGrantsStatement(ref: WalletRef): Promise<{ text: string; values: unknown[] }> {
  let captured: { text: string; values: unknown[] } | undefined
  const spy = {
    $queryRawUnsafe: async (text: string, ...values: unknown[]): Promise<unknown> => {
      if (text.includes('"remaining"')) captured = { text, values }
      return pg.prisma.$queryRawUnsafe(text, ...values)
    },
    $executeRawUnsafe: (text: string, ...values: unknown[]) =>
      pg.prisma.$executeRawUnsafe(text, ...values),
    $transaction: pg.prisma.$transaction.bind(pg.prisma),
  } as unknown as ConstructorParameters<typeof PrismaAiTokensStore>[0]
  await new PrismaAiTokensStore(spy).openGrants(ref, 'expiry')
  if (captured === undefined) throw new Error('the open-grants statement was not captured')
  return captured
}

/** EXPLAIN ANALYZE a statement a few times and keep the fastest run. */
async function explain(text: string, values: unknown[]): Promise<Explained> {
  let best: Explained | undefined
  for (let run = 0; run < 3; run++) {
    const result = await pg.prisma.$queryRawUnsafe<{ 'QUERY PLAN': Explained[] }[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`,
      ...values,
    )
    const explained = result[0]!['QUERY PLAN'][0]!
    if (best === undefined || explained['Execution Time'] < best['Execution Time']) best = explained
  }
  return best!
}

describe('open-grants plan under stale statistics', () => {
  /** Reproduces a large shared table: small wallets analysed, then one wallet grown without a fresh ANALYZE. */
  it('keeps a per-grant lookup when one wallet grows after the last ANALYZE', async () => {
    await pg.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ai_wallet_debit_allocations", "ai_wallet_entries", "ai_wallets" CASCADE',
    )
    await pg.prisma.$executeRawUnsafe(
      'ALTER TABLE "ai_wallet_entries" SET (autovacuum_enabled = false)',
    )
    await pg.prisma.$executeRawUnsafe(
      'ALTER TABLE "ai_wallet_debit_allocations" SET (autovacuum_enabled = false)',
    )
    for (let i = 0; i < 30; i++) {
      await pg.store.appendEntry(
        { tenantId: 'plan', ownerType: 'user', ownerId: `small-${i}` },
        grantEntry({ idempotencyKey: `s-${i}`, amountNanoUsd: 100n }),
      )
    }
    await pg.store.appendEntry(BIG, grantEntry({ idempotencyKey: 'seed', amountNanoUsd: 100n }))
    await pg.prisma.$executeRawUnsafe('ANALYZE "ai_wallet_entries"')
    await pg.prisma.$executeRawUnsafe('ANALYZE "ai_wallet_debit_allocations"')

    const walletId = (await pg.store.getWallet(BIG))!.id
    await pg.prisma.$executeRawUnsafe(
      `INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","expiresAt","idempotencyKey","reason","createdAt")
       SELECT 'g-' || n, '${walletId}', 'grant', 100, 0, TIMESTAMP '2020-01-01', TIMESTAMP '2040-01-01' + n * interval '1 second', 'g-' || n, 'seed', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 day'
       FROM generate_series(1, ${GRANTS}) AS n`,
    )
    await pg.prisma.$executeRawUnsafe(
      `INSERT INTO "ai_wallet_entries" ("id","walletId","type","amountNanoUsd","priority","effectiveAt","idempotencyKey","reason","createdAt")
       VALUES ('dx','${walletId}','debit',-1,0,TIMESTAMP '2020-01-01','dx','seed',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 day')`,
    )
    await pg.prisma.$executeRawUnsafe(
      `INSERT INTO "ai_wallet_debit_allocations" ("id","debitEntryId","grantEntryId","amountNanoUsd")
       SELECT 'a-' || n, 'dx', 'g-' || n, 100 FROM generate_series(${OPEN + 1}, ${GRANTS}) AS n`,
    )

    const { text, values } = await openGrantsStatement(BIG)
    const plan = await explain(text, values)

    // No grouped aggregate over the allocations: its row estimate would come from the stale statistics.
    const grouped = nodes(plan.Plan).filter(
      (node) => node['Node Type'] === 'Aggregate' && node.Strategy !== 'Plain',
    )
    expect(grouped).toEqual([])

    // And no slower than a small multiple of the same read with a correlated sum per grant.
    const reference = sql`SELECT g.*, ${GRANT_REMAINING_SQL}::bigint AS "remaining" FROM "ai_wallet_entries" g
       WHERE g."walletId" = ${walletId} AND g."type" = 'grant' AND ${CREDITED_SQL}
         AND g."effectiveAt" <= ${DB_NOW_SQL} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${DB_NOW_SQL}) AND ${GRANT_REMAINING_SQL} > 0
       ORDER BY g."expiresAt" ASC NULLS LAST, g."createdAt" ASC`
    const baseline = await explain(reference.text, reference.parameters)
    expect(plan['Execution Time']).toBeLessThan(baseline['Execution Time'] * 3 + 15)

    const open = await pg.store.openGrants(BIG, 'expiry')
    expect(open).toHaveLength(OPEN + 1) // the ten unspent grants and the seed grant
  }, 120_000)
})
