/**
 * @fileoverview Testcontainers proof of the Prisma wallet + budget halves (spec
 * §9.4, §10.8, §15.2). The store-agnostic wallet and budget CONTRACT suites run
 * here against real PostgreSQL UNCHANGED — the same assertions that pass on the
 * in-memory fakes prove the raw-SQL conditional debit/consume are atomic on the
 * database. Extra scenarios exercise two independent `PrismaClient` connections
 * racing a debit and a consume, the grant burn-down allocation trail, and the
 * §15.2 error-mapping rows.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { grantEntry, debitEntry, runWalletStoreContract } from '../contracts/wallet-store.contract'
import { delta, runBudgetStoreContract } from '../contracts/budget-store.contract'

const MIGRATION = join(__dirname, '../../src/prisma/migrations/0001_init.sql')

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

let container: StartedPostgreSqlContainer
let prisma: PrismaClient
let prismaB: PrismaClient
let store: PrismaAiTokensStore
let storeB: PrismaAiTokensStore

/** Wipe the wallet tables between contract tests so each gets a fresh wallet. */
async function truncateWallets(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_wallet_debit_allocations", "ai_wallet_entries", "ai_wallets" CASCADE')
}

/** Wipe the budget tables between contract tests. */
async function truncateBudgets(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ai_budget_windows", "ai_budgets" CASCADE')
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start()
  const url = container.getConnectionUri()
  prisma = new PrismaClient({ datasourceUrl: url })
  prismaB = new PrismaClient({ datasourceUrl: url })
  for (const statement of migrationStatements()) await prisma.$executeRawUnsafe(statement)
  store = new PrismaAiTokensStore(prisma)
  storeB = new PrismaAiTokensStore(prismaB)
}, 180_000)

afterAll(async () => {
  await prisma.$disconnect()
  await prismaB.$disconnect()
  await container.stop()
})

runWalletStoreContract('Prisma / PostgreSQL', async () => {
  await truncateWallets()
  return {
    store,
    skew: async (ref: WalletRef, value: bigint): Promise<void> => {
      await prisma.$executeRaw`UPDATE "ai_wallets" SET "balanceNanoUsd" = ${value} WHERE "tenantId" = ${ref.tenantId} AND "ownerType" = ${ref.ownerType} AND "ownerId" = ${ref.ownerId}`
    },
  }
})

runBudgetStoreContract('Prisma / PostgreSQL', async () => {
  await truncateBudgets()
  return store
})

describe('PrismaAiTokensStore wallet + budget halves (real connections)', () => {
  const ref: WalletRef = { tenantId: 'e2e', ownerType: 'user', ownerId: 'u1' }

  /** Two independent connections racing a debit against a balance for one: exactly one wins. */
  it('lets exactly one of two connections win a debit race', async () => {
    await truncateWallets()
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
    const [a, b] = await Promise.all([
      store.conditionalDebit(ref, debitEntry(80n, { idempotencyKey: 'race-a' }), 0n),
      storeB.conditionalDebit(ref, debitEntry(80n, { idempotencyKey: 'race-b' }), 0n),
    ])
    expect([a, b].filter((entry) => entry === null)).toHaveLength(1)
    expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(20n)
  })

  /** Two connections racing a consume with headroom for one: exactly one wins. */
  it('lets exactly one of two connections win a consume race', async () => {
    await truncateBudgets()
    await store.upsert({ id: 'race', tenantId: 'e2e', scope: { type: 'tenant', id: 'e2e' }, window: 'total', softThresholds: [], policy: 'block' })
    const windowStart = new Date('2026-06-01T00:00:00.000Z')
    const [a, b] = await Promise.all([
      store.conditionalConsume('race', windowStart, delta(80n), { nanoUsd: 100n }),
      storeB.conditionalConsume('race', windowStart, delta(80n), { nanoUsd: 100n }),
    ])
    expect([a, b].filter((ok) => ok)).toHaveLength(1)
    expect((await store.getWindow('race', windowStart))?.spentNanoUsd).toBe(80n)
  })

  /** A debit spanning two grants burns the soonest-expiring first and records the allocation trail. */
  it('records the grant burn-down allocation trail', async () => {
    await truncateWallets()
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'soon', amountNanoUsd: 30n, expiresAt: new Date('2027-01-01T00:00:00.000Z') }))
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'late', amountNanoUsd: 30n, expiresAt: new Date('2030-01-01T00:00:00.000Z') }))
    const debit = await store.conditionalDebit(ref, debitEntry(40n, { idempotencyKey: 'span' }), 0n)
    const allocations = await prisma.$queryRaw<{ sum: bigint; rows: bigint }[]>`
      SELECT COALESCE(SUM("amountNanoUsd"), 0)::bigint AS "sum", COUNT(*)::bigint AS "rows"
      FROM "ai_wallet_debit_allocations" WHERE "debitEntryId" = ${debit?.id ?? ''}
    `
    expect(allocations[0]?.sum).toBe(40n)
    expect(allocations[0]?.rows).toBe(2n)
    const open = await store.openGrants(ref, 'expiry')
    expect(open.reduce((total, grant) => total + grant.remainingNanoUsd, 0n)).toBe(20n) // 60 granted − 40 debited
  })

  /** A wallet-entry replay returns the stored entry; a key reuse with a different payload conflicts (§15.2). */
  it('maps wallet-entry idempotency replay and conflict', async () => {
    await truncateWallets()
    const first = await store.appendEntry(ref, grantEntry({ idempotencyKey: 'idem', amountNanoUsd: 50n }))
    const replay = await store.appendEntry(ref, grantEntry({ idempotencyKey: 'idem', amountNanoUsd: 50n }))
    expect(replay.id).toBe(first.id)
    await expect(store.appendEntry(ref, grantEntry({ idempotencyKey: 'idem', amountNanoUsd: 99n }))).rejects.toMatchObject({
      isAiTokensLedgerConflict: true,
    })
  })

  /** A debit with no headroom affects no row and returns null (never a store error, §15.2). */
  it('returns null on an insufficient conditional debit', async () => {
    await truncateWallets()
    await store.appendEntry(ref, grantEntry({ idempotencyKey: 'small', amountNanoUsd: 10n }))
    expect(await store.conditionalDebit(ref, debitEntry(50n, { idempotencyKey: 'over' }), 0n)).toBeNull()
    expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(10n) // unchanged
  })

  /** A debit against a nonexistent wallet returns null (mapped to insufficient credits by the service). */
  it('returns null when debiting a nonexistent wallet', async () => {
    await truncateWallets()
    const missing: WalletRef = { tenantId: 'e2e', ownerType: 'user', ownerId: 'ghost' }
    expect(await store.conditionalDebit(missing, debitEntry(10n, { idempotencyKey: 'x' }), 0n)).toBeNull()
  })

  /** A budget window row is deleted with its budget (remove clears windows first). */
  it('removes a budget and its windows', async () => {
    await truncateBudgets()
    const budget = await store.upsert({ tenantId: 'e2e', scope: { type: 'user', id: 'u1' }, limitNanoUsd: 100n, window: 'month', softThresholds: [], policy: 'block' })
    const windowStart = new Date('2026-06-01T00:00:00.000Z')
    await store.conditionalConsume(budget.id, windowStart, delta(10n), { nanoUsd: 100n })
    await store.remove(budget.id)
    expect(await store.findBudgetById(budget.id)).toBeNull()
    expect(await store.getWindow(budget.id, windowStart)).toBeNull()
  })

  /** findMatching returns the exact scope and tenant-wide budgets, excluding expired ones. */
  it('matches scope and tenant-wide budgets, excluding expired', async () => {
    await truncateBudgets()
    await store.upsert({ tenantId: 'e2e', scope: { type: 'user', id: 'u1' }, limitNanoUsd: 100n, window: 'month', softThresholds: [], policy: 'block' })
    await store.upsert({ tenantId: 'e2e', scope: { type: 'tenant', id: 'e2e' }, limitTokens: 1_000, window: 'month', softThresholds: [], policy: 'block' })
    await store.upsert({ tenantId: 'e2e', scope: { type: 'user', id: 'u1' }, limitCount: 5, window: 'month', softThresholds: [], policy: 'block', expiresAt: new Date('2020-01-01T00:00:00.000Z') })
    const matched = await store.findMatching('e2e', { type: 'user', id: 'u1' })
    expect(matched).toHaveLength(2) // user + tenant-wide; expired excluded
    const tenantWide = matched.find((budget) => budget.scope.type === 'tenant')
    expect(tenantWide?.limitTokens).toBe(1_000) // BigInt ↔ number round-trip
  })

  /** A custom-seconds window round-trips through its stored text encoding. */
  it('round-trips a custom-seconds window', async () => {
    await truncateBudgets()
    const budget = await store.upsert({ tenantId: 'e2e', scope: { type: 'user', id: 'u1' }, limitNanoUsd: 100n, window: { customSeconds: 86_400 }, softThresholds: [0.9], policy: 'allow' })
    const reloaded = await store.findBudgetById(budget.id)
    expect(reloaded?.window).toEqual({ customSeconds: 86_400 })
    expect(reloaded?.softThresholds).toEqual([0.9])
    expect(reloaded?.policy).toBe('allow')
  })
})
