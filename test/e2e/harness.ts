/**
 * @fileoverview Shared end-to-end harness (spec §19.2). Starts a PostgreSQL (and,
 * on demand, a Redis) container once per suite file, applies the shipped SQL
 * migration, boots a real NestJS `BymaxAiTokensModule` over the official
 * `PrismaAiTokensStore`, and exposes typed seed helpers. Containers are per FILE
 * (not per test); the e2e Jest config caps `maxWorkers: 1` so only one container
 * set is alive at a time.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Test } from '@nestjs/testing'
import type { TestingModule } from '@nestjs/testing'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Redis } from 'ioredis'
import type { Budget, MeteringScope, NormalizedUsage, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import {
  BudgetService,
  BymaxAiTokensModule,
  LedgerService,
  MeteringService,
  PricingService,
  UsageReportService,
  WalletService,
  providerPresets,
} from '@bymax-one/nest-ai-tokens'
import type { IAiTokensStore, IBudgetCounterStore, MeteringContext, UpsertBudgetInput } from '@bymax-one/nest-ai-tokens'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { RedisBudgetCounterStore } from '@bymax-one/nest-ai-tokens/redis'

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

/** A started PostgreSQL fixture: two independent clients + stores (for replica races). */
export interface PostgresFixture {
  container: StartedPostgreSqlContainer
  url: string
  prisma: PrismaClient
  prismaB: PrismaClient
  store: PrismaAiTokensStore
  storeB: PrismaAiTokensStore
  stop: () => Promise<void>
}

/** Start PostgreSQL, apply the migration, and open two client connections. */
export async function startPostgres(): Promise<PostgresFixture> {
  const container = await new PostgreSqlContainer('postgres:16').start()
  const url = container.getConnectionUri()
  const prisma = clientFor(url)
  const prismaB = clientFor(url)
  for (const statement of migrationStatements()) await prisma.$executeRawUnsafe(statement)
  const stop = async (): Promise<void> => {
    await prisma.$disconnect()
    await prismaB.$disconnect()
    await container.stop()
  }
  return { container, url, prisma, prismaB, store: new PrismaAiTokensStore(prisma), storeB: new PrismaAiTokensStore(prismaB), stop }
}

/** A started Redis fixture with a budget counter store. */
export interface RedisFixture {
  container: StartedTestContainer
  client: Redis
  counter: RedisBudgetCounterStore
  stop: () => Promise<void>
}

/** Start Redis and open a counter store. */
export async function startRedis(): Promise<RedisFixture> {
  const container = await new GenericContainer('redis:7').withExposedPorts(6379).start()
  const client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379), maxRetriesPerRequest: null })
  const counter = new RedisBudgetCounterStore(client)
  const stop = async (): Promise<void> => {
    client.disconnect()
    await container.stop()
  }
  return { container, client, counter, stop }
}

/** Options for booting the metering module. */
export interface BootOptions {
  store: IAiTokensStore
  markup?: number
  counter?: IBudgetCounterStore
  overdraftNanoUsd?: bigint
  holdTtlSeconds?: number
  seedFromSnapshot?: boolean
}

/** The booted module and its resolved services. */
export interface Booted {
  moduleRef: TestingModule
  metering: MeteringService
  wallets: WalletService
  budgets: BudgetService
  pricing: PricingService
  ledger: LedgerService
  report: UsageReportService
  close: () => Promise<void>
}

/** Boot a real `BymaxAiTokensModule` over the given store with wallets + budgets enabled. */
export async function bootMeteringModule(options: BootOptions): Promise<Booted> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      BymaxAiTokensModule.forRoot({
        store: options.store,
        markup: options.markup ?? 1,
        pricing: { seedFromSnapshot: options.seedFromSnapshot ?? false, strict: false },
        wallets: { overdraftNanoUsd: options.overdraftNanoUsd ?? 0n },
        budgets: options.counter !== undefined ? { counter: options.counter } : {},
        holds: { ttlSeconds: options.holdTtlSeconds ?? 3_600, reaperIntervalSeconds: 3_600 },
        scopeResolver: () => ({ tenantId: 'e2e', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }),
      }),
    ],
  }).compile()
  await moduleRef.init()
  return {
    moduleRef,
    metering: moduleRef.get(MeteringService),
    wallets: moduleRef.get(WalletService),
    budgets: moduleRef.get(BudgetService),
    pricing: moduleRef.get(PricingService),
    ledger: moduleRef.get(LedgerService),
    report: moduleRef.get(UsageReportService),
    close: () => moduleRef.close(),
  }
}

/** A metering context for the default e2e user (trusted input). */
export function e2eContext(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: 'e2e', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', preset: providerPresets.openaiChat, ...over }
}

/** A complete normalized usage for a gpt-5 chat call. */
export function e2eUsage(over: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
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
    ...over,
  }
}

/** Seed a price row ($1.25/M input, $10/M output by default). */
export async function seedPrice(
  pricing: PricingService,
  over: Partial<{ model: string; inputNanoUsdPerMillion: bigint; outputNanoUsdPerMillion: bigint; cacheReadNanoUsdPerMillion: bigint }> = {},
): Promise<void> {
  await pricing.upsertPrice({
    provider: 'openai',
    model: over.model ?? 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: over.inputNanoUsdPerMillion ?? 1_250_000_000n,
    outputNanoUsdPerMillion: over.outputNanoUsdPerMillion ?? 10_000_000_000n,
    ...(over.cacheReadNanoUsdPerMillion !== undefined ? { cacheReadNanoUsdPerMillion: over.cacheReadNanoUsdPerMillion } : {}),
    effectiveFrom: new Date(0),
  })
}

/** Grant the default e2e user wallet. */
export function grantWallet(wallets: WalletService, amountNanoUsd: bigint, over: Partial<{ idempotencyKey: string; expiresAt: Date; ownerId: string }> = {}): Promise<unknown> {
  const ref: WalletRef = { tenantId: 'e2e', ownerType: 'user', ownerId: over.ownerId ?? 'u1' }
  return wallets.grant(ref, {
    amountNanoUsd,
    // Anchor the grant in the past so it is spendable regardless of container clock skew
    // (the Postgres CURRENT_TIMESTAMP may lag the test process's wall clock).
    effectiveAt: new Date(0),
    idempotencyKey: over.idempotencyKey ?? `grant-${amountNanoUsd.toString()}`,
    reason: 'e2e seed',
    ...(over.expiresAt !== undefined ? { expiresAt: over.expiresAt } : {}),
  })
}

/** Upsert a tenant-wide budget for the e2e tenant. */
export function upsertBudget(budgets: BudgetService, over: Partial<Budget> = {}): Promise<Budget> {
  const input: UpsertBudgetInput = {
    tenantId: 'e2e',
    scope: (over.scope ?? { type: 'tenant', id: 'e2e' }) as MeteringScope,
    window: over.window ?? 'month',
    ...(over.limitNanoUsd !== undefined ? { limitNanoUsd: over.limitNanoUsd } : {}),
    ...(over.limitTokens !== undefined ? { limitTokens: over.limitTokens } : {}),
    ...(over.limitCount !== undefined ? { limitCount: over.limitCount } : {}),
    ...(over.features !== undefined ? { features: over.features } : {}),
    ...(over.anchorAt !== undefined ? { anchorAt: over.anchorAt } : {}),
  }
  return budgets.upsertBudget(input)
}

/** The default e2e wallet ref. */
export const E2E_WALLET: WalletRef = { tenantId: 'e2e', ownerType: 'user', ownerId: 'u1' }
