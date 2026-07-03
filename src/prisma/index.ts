/**
 * @fileoverview `PrismaAiTokensStore` — the official PostgreSQL adapter (spec
 * §15.1–15.3). It implements the ledger + pricing halves of `IAiTokensStore`
 * against any `@prisma/client` instance, talking to PostgreSQL EXCLUSIVELY through
 * PARAMETERIZED raw SQL (`$queryRaw`/`$executeRaw`/`$transaction`) so it never
 * depends on generated model delegates and stays valid against the host's schema.
 * Column identifiers are hardcoded constants (never interpolated from input) and
 * every value is a bound parameter, so the raw SQL is injection-safe. Money is
 * `BIGINT` nano-USD; `unitRates` round-trip as JSON of decimal strings; the
 * `markupMultiplier` `Decimal(10,4)` maps to a `number` at the boundary (exact by
 * the 4-dp rule, §7.2). Store errors map to the domain catalog (§15.2); a payload
 * hash mismatch on the `(tenantId, idempotencyKey)` unique index becomes the
 * exactly-once conflict, and unknown driver errors become `AI_TOKENS_STORE_ERROR`
 * (connection details are never leaked). Row shapes, mappers, and SQL builders live
 * in `./adapter-sql`; the wallet/budget halves use the same conditional-write
 * discipline as the ledger half (§9.4, §10.8).
 * @layer prisma
 */

import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type {
  AiOperation,
  Budget,
  LedgerFilter,
  MeteringScope,
  NewPriceVersion,
  NewUsageRecord,
  NewWalletEntry,
  PriceVersion,
  ProviderId,
  ServiceTier,
  UsageRecord,
  UsageStatus,
  Wallet,
  WalletEntry,
  WalletRef,
} from '../shared'
import type {
  BudgetDelta,
  BudgetLimits,
  BudgetWindowSpend,
  IAiTokensStore,
  LedgerCostSummary,
  OpenGrant,
  PricedModel,
  WalletEntryFilter,
  WalletEntryPage,
} from '../server'
import { AiTokensException } from '../server/errors'
import { LedgerIdempotencyConflict, isLedgerIdempotencyConflict } from '../server/services/ledger-idempotency-conflict'
import { chainHash } from '../server/utils/hash-chain'
import {
  BUDGET_COLUMNS_SQL,
  PRICE_COLUMNS_SQL,
  USAGE_COLUMNS_SQL,
  WalletMissingError,
  budgetUpdateAssignments,
  budgetValues,
  buildWhere,
  firstOrThrow,
  isUniqueViolation,
  isWalletMissing,
  mapBudgetRow,
  mapBudgetWindowRow,
  mapOpenGrantRow,
  mapPriceRow,
  mapUsageRow,
  mapWalletEntryRow,
  mapWalletRow,
  priceValues,
  spendableBalanceSql,
  statusAssignments,
  storeError,
  usageValues,
  walletAutoCreatable,
  walletBalanceDelta,
  walletEntryMatches,
  walletEntryWhere,
} from './adapter-sql'
import type { BudgetRow, BudgetWindowRow, OpenGrantRow, PriceRow, UsageRow, WalletEntryRow, WalletRow } from './adapter-sql'

/** A SQL executor — either the client or an interactive-transaction client. */
type SqlExecutor = Prisma.TransactionClient

/**
 * The official PostgreSQL adapter. Construct it with the host's `PrismaClient`
 * (the host's schema must include the shipped models, §15.3).
 */
export class PrismaAiTokensStore implements IAiTokensStore {
  private readonly burnOrder: 'expiry' | 'priority' | 'fifo'

  /**
   * @param prisma The host's Prisma client (talks to PostgreSQL).
   * @param options Optional wallet grant burn order (must match the module's `wallets.burnOrder`; default `'expiry'`).
   */
  constructor(
    private readonly prisma: PrismaClient,
    options: { burnOrder?: 'expiry' | 'priority' | 'fifo' } = {},
  ) {
    this.burnOrder = options.burnOrder ?? 'expiry'
  }

  async append(record: NewUsageRecord, payloadHash: string, hashChain?: boolean): Promise<UsageRecord> {
    try {
      if (hashChain === true && record.status === 'posted') {
        return await this.prisma.$transaction((tx) => this.insertChained(tx, record, payloadHash))
      }
      return await this.insert(this.prisma, randomUUID(), record, payloadHash, null, null)
    } catch (error) {
      if (isUniqueViolation(error)) return this.replayOrConflict(record, payloadHash)
      throw storeError(error)
    }
  }

  transition(
    id: string,
    from: UsageStatus,
    to: UsageStatus,
    patch?: Partial<UsageRecord>,
    hashChain?: boolean,
  ): Promise<UsageRecord | null> {
    if (hashChain === true && to === 'posted') return this.settleChained(id, from, patch)
    return this.updateStatus(this.prisma, id, from, to, patch, null, null)
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<UsageRecord | null> {
    const rows = await this.prisma.$queryRaw<UsageRow[]>(
      Prisma.sql`SELECT * FROM "ai_usage_records" WHERE "tenantId" = ${tenantId} AND "idempotencyKey" = ${key} LIMIT 1`,
    )
    return rows[0] === undefined ? null : mapUsageRow(rows[0])
  }

  async findById(id: string): Promise<UsageRecord | null> {
    const rows = await this.prisma.$queryRaw<UsageRow[]>(
      Prisma.sql`SELECT * FROM "ai_usage_records" WHERE "id" = ${id} LIMIT 1`,
    )
    return rows[0] === undefined ? null : mapUsageRow(rows[0])
  }

  async findExpiredHolds(olderThan: Date, limit: number): Promise<UsageRecord[]> {
    const rows = await this.prisma.$queryRaw<UsageRow[]>(Prisma.sql`
      SELECT * FROM "ai_usage_records"
      WHERE "status" = 'pending' AND "createdAt" < ${olderThan}
      ORDER BY "createdAt" ASC LIMIT ${limit}
    `)
    return rows.map(mapUsageRow)
  }

  async query(filter: LedgerFilter): Promise<UsageRecord[]> {
    const limit = filter.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${filter.limit}`
    const offset = filter.offset === undefined ? Prisma.empty : Prisma.sql`OFFSET ${filter.offset}`
    const rows = await this.prisma.$queryRaw<UsageRow[]>(Prisma.sql`
      SELECT * FROM "ai_usage_records" WHERE ${buildWhere(filter)}
      ORDER BY "createdAt" ASC ${limit} ${offset}
    `)
    return rows.map(mapUsageRow)
  }

  async sumCost(filter: LedgerFilter): Promise<LedgerCostSummary> {
    const rows = await this.prisma.$queryRaw<{ raw: bigint; billed: bigint; surcharge: bigint; tokens: bigint; records: number }[]>(Prisma.sql`
      SELECT
        COALESCE(SUM("rawCostNanoUsd"), 0)::bigint AS "raw",
        COALESCE(SUM("billedCostNanoUsd"), 0)::bigint AS "billed",
        COALESCE(SUM("surchargeNanoUsd"), 0)::bigint AS "surcharge",
        COALESCE(SUM("totalTokens"), 0)::bigint AS "tokens",
        COUNT(*)::int AS "records"
      FROM "ai_usage_records" WHERE ${buildWhere(filter)}
    `)
    const row = rows[0] ?? { raw: 0n, billed: 0n, surcharge: 0n, tokens: 0n, records: 0 }
    return {
      rawCostNanoUsd: row.raw,
      billedCostNanoUsd: row.billed,
      surchargeNanoUsd: row.surcharge,
      totalTokens: Number(row.tokens),
      records: row.records,
    }
  }

  lastHash(tenantId: string): Promise<string | null> {
    return this.lastHashWithin(this.prisma, tenantId)
  }

  async resolveRate(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier: ServiceTier,
    at: Date,
  ): Promise<PriceVersion | null> {
    const rows = await this.prisma.$queryRaw<PriceRow[]>(Prisma.sql`
      SELECT * FROM "ai_model_prices"
      WHERE "provider" = ${provider} AND "model" = ${model} AND "operation" = ${operation}
        AND "serviceTier" = ${serviceTier} AND "effectiveFrom" <= ${at}
        AND ("effectiveTo" IS NULL OR "effectiveTo" >= ${at})
      ORDER BY "effectiveFrom" DESC LIMIT 1
    `)
    return rows[0] === undefined ? null : mapPriceRow(rows[0])
  }

  async upsertPrice(input: NewPriceVersion): Promise<PriceVersion> {
    const serviceTier: ServiceTier = input.serviceTier ?? 'standard'
    const effectiveFrom = input.effectiveFrom ?? new Date()
    const key = `${input.provider}|${input.model}|${input.operation}|${serviceTier}`
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`
      await tx.$executeRaw(Prisma.sql`
        UPDATE "ai_model_prices" SET "effectiveTo" = ${effectiveFrom}
        WHERE "provider" = ${input.provider} AND "model" = ${input.model} AND "operation" = ${input.operation}
          AND "serviceTier" = ${serviceTier} AND "effectiveTo" IS NULL
      `)
      const rows = await tx.$queryRaw<PriceRow[]>(Prisma.sql`
        INSERT INTO "ai_model_prices" (${PRICE_COLUMNS_SQL}) VALUES (${Prisma.join(priceValues(input, serviceTier, effectiveFrom))})
        RETURNING *
      `)
      return mapPriceRow(firstOrThrow(rows))
    })
  }

  async getPriceHistory(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier?: ServiceTier,
  ): Promise<PriceVersion[]> {
    const tier = serviceTier === undefined ? Prisma.empty : Prisma.sql`AND "serviceTier" = ${serviceTier}`
    const rows = await this.prisma.$queryRaw<PriceRow[]>(Prisma.sql`
      SELECT * FROM "ai_model_prices"
      WHERE "provider" = ${provider} AND "model" = ${model} AND "operation" = ${operation} ${tier}
      ORDER BY "effectiveFrom" DESC
    `)
    return rows.map(mapPriceRow)
  }

  async listModels(provider: ProviderId): Promise<PricedModel[]> {
    const rows = await this.prisma.$queryRaw<{ model: string; operation: string; serviceTier: string }[]>(Prisma.sql`
      SELECT DISTINCT "model", "operation", "serviceTier" FROM "ai_model_prices" WHERE "provider" = ${provider}
    `)
    return rows.map((row) => ({ model: row.model, operation: row.operation as AiOperation, serviceTier: row.serviceTier as ServiceTier }))
  }

  /** Advisory seed lock (§6.4): the first caller wins; concurrent boots seed exactly once. */
  async acquireSeedLock(key: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ acquired: boolean }[]>(
      Prisma.sql`SELECT pg_try_advisory_lock(hashtext(${key})::bigint) AS "acquired"`,
    )
    return rows[0]?.acquired ?? false
  }

  /** Insert one usage row and return it; shared by the plain and chained paths. */
  private async insert(
    executor: SqlExecutor,
    id: string,
    record: NewUsageRecord,
    payloadHash: string,
    prevHash: string | null,
    hash: string | null,
  ): Promise<UsageRecord> {
    const values = Prisma.join(usageValues(id, record, payloadHash, prevHash, hash))
    const rows = await executor.$queryRaw<UsageRow[]>(
      Prisma.sql`INSERT INTO "ai_usage_records" (${USAGE_COLUMNS_SQL}) VALUES (${values}) RETURNING *`,
    )
    return mapUsageRow(firstOrThrow(rows))
  }

  /** Insert a `posted` row under the per-tenant chain lock (§8.6). */
  private async insertChained(tx: SqlExecutor, record: NewUsageRecord, payloadHash: string): Promise<UsageRecord> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${record.tenantId})::bigint)`
    const prevHash = await this.lastHashWithin(tx, record.tenantId)
    const id = randomUUID()
    const hash = chainHash(prevHash, { ...record, id })
    return this.insert(tx, id, record, payloadHash, prevHash, hash)
  }

  /** Settle a hold `pending → posted`, computing its chain hash under the lock (§8.6). */
  private settleChained(id: string, from: UsageStatus, patch?: Partial<UsageRecord>): Promise<UsageRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<UsageRow[]>(
        Prisma.sql`SELECT * FROM "ai_usage_records" WHERE "id" = ${id} AND "status" = ${from} FOR UPDATE`,
      )
      if (rows[0] === undefined) return null
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${rows[0].tenantId})::bigint)`
      const prevHash = await this.lastHashWithin(tx, rows[0].tenantId)
      const settled = { ...mapUsageRow(rows[0]), ...patch, status: 'posted' as const }
      return this.updateStatus(tx, id, from, 'posted', patch, prevHash, chainHash(prevHash, settled))
    })
  }

  /** Atomic status transition via a conditional `UPDATE`; 0 rows → `null` (§8.3). */
  private async updateStatus(
    executor: SqlExecutor,
    id: string,
    from: UsageStatus,
    to: UsageStatus,
    patch: Partial<UsageRecord> | undefined,
    prevHash: string | null,
    hash: string | null,
  ): Promise<UsageRecord | null> {
    const assignments = statusAssignments(from, to, patch, prevHash, hash)
    const rows = await executor.$queryRaw<UsageRow[]>(
      Prisma.sql`UPDATE "ai_usage_records" SET ${assignments} WHERE "id" = ${id} AND "status" = ${from} RETURNING *`,
    )
    return rows[0] === undefined ? null : mapUsageRow(rows[0])
  }

  /** The tenant's last chain hash (most recently created settled row). */
  private async lastHashWithin(executor: SqlExecutor, tenantId: string): Promise<string | null> {
    const rows = await executor.$queryRaw<{ hash: string }[]>(Prisma.sql`
      SELECT "hash" FROM "ai_usage_records"
      WHERE "tenantId" = ${tenantId} AND "hash" IS NOT NULL
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
    `)
    return rows[0]?.hash ?? null
  }

  async getWallet(ref: WalletRef): Promise<Wallet | null> {
    const rows = await this.prisma.$queryRaw<WalletRow[]>(Prisma.sql`
      SELECT * FROM "ai_wallets"
      WHERE "tenantId" = ${ref.tenantId} AND "ownerType" = ${ref.ownerType} AND "ownerId" = ${ref.ownerId} LIMIT 1
    `)
    return rows[0] === undefined ? null : mapWalletRow(rows[0])
  }

  async appendEntry(
    ref: WalletRef,
    entry: NewWalletEntry,
    allocations: { grantEntryId: string; amountNanoUsd: bigint }[] = [],
  ): Promise<WalletEntry> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const wallet = await this.ensureWallet(tx, ref, walletAutoCreatable(entry))
        if (wallet === null) throw new WalletMissingError()
        const stored = await this.insertWalletEntry(tx, wallet.id, entry)
        await this.insertAllocations(tx, stored.id, allocations)
        await this.applyBalanceDelta(tx, wallet.id, walletBalanceDelta(stored))
        return stored
      })
    } catch (error) {
      if (isUniqueViolation(error)) return this.replayOrConflictWallet(ref, entry)
      if (isWalletMissing(error)) throw error
      throw storeError(error)
    }
  }

  async conditionalDebit(ref: WalletRef, entry: NewWalletEntry, overdraftNanoUsd: bigint): Promise<WalletEntry | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const wallet = (await this.getWalletWithin(tx, ref)) ?? null
        if (wallet === null) return null
        const replay = await this.walletReplay(tx, wallet.id, ref, entry)
        if (replay !== undefined) return replay
        await this.sweepExpiredGrants(tx, wallet.id)
        const cost = -entry.amountNanoUsd
        const reserved = await tx.$queryRaw<WalletRow[]>(Prisma.sql`
          UPDATE "ai_wallets" SET "balanceNanoUsd" = "balanceNanoUsd" - ${cost}, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${wallet.id} AND "balanceNanoUsd" - ${cost} >= ${-overdraftNanoUsd} RETURNING *
        `)
        if (reserved[0] === undefined) return null
        const debit = await this.insertWalletEntry(tx, wallet.id, entry)
        await this.insertAllocations(tx, debit.id, await this.burnDown(tx, wallet.id, cost))
        return debit
      })
    } catch (error) {
      if (isLedgerIdempotencyConflict(error)) throw error
      if (isUniqueViolation(error)) return this.replayOrConflictWallet(ref, entry)
      throw storeError(error)
    }
  }

  async openGrants(ref: WalletRef, order: 'expiry' | 'priority' | 'fifo'): Promise<OpenGrant[]> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) return []
    const rows = await this.prisma.$queryRaw<OpenGrantRow[]>(this.openGrantsSql(wallet.id, order))
    return rows.map(mapOpenGrantRow)
  }

  async listEntries(ref: WalletRef, filter: WalletEntryFilter = {}): Promise<WalletEntryPage> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) return { entries: [], total: 0 }
    const where = walletEntryWhere(wallet.id, filter)
    const limit = filter.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${filter.limit}`
    const offset = filter.offset === undefined ? Prisma.empty : Prisma.sql`OFFSET ${filter.offset}`
    const [entries, counts] = await Promise.all([
      this.prisma.$queryRaw<WalletEntryRow[]>(
        Prisma.sql`SELECT * FROM "ai_wallet_entries" WHERE ${where} ORDER BY "createdAt" ASC ${limit} ${offset}`,
      ),
      this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS "total" FROM "ai_wallet_entries" WHERE ${where}`),
    ])
    return { entries: entries.map(mapWalletEntryRow), total: Number(counts[0]?.total ?? 0n) }
  }

  async reconcile(ref: WalletRef): Promise<Wallet> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) throw new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', undefined, { reason: 'wallet does not exist' })
    const now = new Date()
    const rows = await this.prisma.$queryRaw<WalletRow[]>(Prisma.sql`
      UPDATE "ai_wallets" w SET "balanceNanoUsd" = ${spendableBalanceSql(now)}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE w."id" = ${wallet.id} RETURNING *
    `)
    return mapWalletRow(firstOrThrow(rows))
  }

  async upsert(input: Omit<Budget, 'id' | 'createdAt'> & { id?: string }): Promise<Budget> {
    const id = input.id ?? randomUUID()
    const rows = await this.prisma.$queryRaw<BudgetRow[]>(Prisma.sql`
      INSERT INTO "ai_budgets" (${BUDGET_COLUMNS_SQL}) VALUES (${Prisma.join(budgetValues(id, input))})
      ON CONFLICT ("id") DO UPDATE SET ${budgetUpdateAssignments(input)} RETURNING *
    `)
    return mapBudgetRow(firstOrThrow(rows))
  }

  async remove(budgetId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.$executeRaw`DELETE FROM "ai_budget_windows" WHERE "budgetId" = ${budgetId}`,
      this.prisma.$executeRaw`DELETE FROM "ai_budgets" WHERE "id" = ${budgetId}`,
    ])
  }

  async findBudgetById(budgetId: string): Promise<Budget | null> {
    const rows = await this.prisma.$queryRaw<BudgetRow[]>(Prisma.sql`SELECT * FROM "ai_budgets" WHERE "id" = ${budgetId} LIMIT 1`)
    return rows[0] === undefined ? null : mapBudgetRow(rows[0])
  }

  async findMatching(tenantId: string, scope: MeteringScope): Promise<Budget[]> {
    const now = new Date()
    const rows = await this.prisma.$queryRaw<BudgetRow[]>(Prisma.sql`
      SELECT * FROM "ai_budgets"
      WHERE "tenantId" = ${tenantId}
        AND ("scopeType" = 'tenant' OR ("scopeType" = ${scope.type} AND "scopeId" = ${scope.id}))
        AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
    `)
    return rows.map(mapBudgetRow)
  }

  async conditionalConsume(budgetId: string, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.ensureWindow(tx, budgetId, windowStart)
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "ai_budget_windows"
        SET "spentNanoUsd" = "spentNanoUsd" + ${delta.nanoUsd},
            "spentTokens" = "spentTokens" + ${BigInt(delta.tokens)},
            "spentCount" = "spentCount" + ${delta.count},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "budgetId" = ${budgetId} AND "windowStart" = ${windowStart}
          AND (${limits.nanoUsd ?? null}::bigint IS NULL OR "spentNanoUsd" + ${delta.nanoUsd} <= ${limits.nanoUsd ?? null})
          AND (${limits.tokens === undefined ? null : BigInt(limits.tokens)}::bigint IS NULL OR "spentTokens" + ${BigInt(delta.tokens)} <= ${limits.tokens === undefined ? null : BigInt(limits.tokens)})
          AND (${limits.count ?? null}::int IS NULL OR "spentCount" + ${delta.count} <= ${limits.count ?? null})
        RETURNING "id"
      `)
      return rows[0] !== undefined
    })
  }

  async adjustWindow(budgetId: string, windowStart: Date, delta: BudgetDelta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.ensureWindow(tx, budgetId, windowStart)
      await tx.$executeRaw(Prisma.sql`
        UPDATE "ai_budget_windows"
        SET "spentNanoUsd" = GREATEST(0, "spentNanoUsd" + ${delta.nanoUsd}),
            "spentTokens" = GREATEST(0, "spentTokens" + ${BigInt(delta.tokens)}),
            "spentCount" = GREATEST(0, "spentCount" + ${delta.count}),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "budgetId" = ${budgetId} AND "windowStart" = ${windowStart}
      `)
    })
  }

  async getWindow(budgetId: string, windowStart: Date): Promise<BudgetWindowSpend | null> {
    const rows = await this.prisma.$queryRaw<BudgetWindowRow[]>(
      Prisma.sql`SELECT * FROM "ai_budget_windows" WHERE "budgetId" = ${budgetId} AND "windowStart" = ${windowStart} LIMIT 1`,
    )
    return rows[0] === undefined ? null : mapBudgetWindowRow(rows[0])
  }

  async setWindowStart(budgetId: string, windowStart: Date): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ai_budget_windows" ("id", "budgetId", "windowStart", "spentNanoUsd", "spentTokens", "spentCount", "updatedAt")
      VALUES (${randomUUID()}, ${budgetId}, ${windowStart}, 0, 0, 0, CURRENT_TIMESTAMP)
      ON CONFLICT ("budgetId", "windowStart") DO UPDATE SET "spentNanoUsd" = 0, "spentTokens" = 0, "spentCount" = 0, "updatedAt" = CURRENT_TIMESTAMP
    `)
  }

  /** Load the wallet within a transaction (existence + id for the conditional debit). */
  private async getWalletWithin(tx: SqlExecutor, ref: WalletRef): Promise<WalletRow | undefined> {
    const rows = await tx.$queryRaw<WalletRow[]>(Prisma.sql`
      SELECT * FROM "ai_wallets"
      WHERE "tenantId" = ${ref.tenantId} AND "ownerType" = ${ref.ownerType} AND "ownerId" = ${ref.ownerId} LIMIT 1
    `)
    return rows[0]
  }

  /** Fetch or (optionally) create the wallet for a ref within a transaction. */
  private async ensureWallet(tx: SqlExecutor, ref: WalletRef, autoCreate: boolean): Promise<WalletRow | null> {
    const existing = await this.getWalletWithin(tx, ref)
    if (existing !== undefined) return existing
    if (!autoCreate) return null
    const rows = await tx.$queryRaw<WalletRow[]>(Prisma.sql`
      INSERT INTO "ai_wallets" ("id", "tenantId", "ownerType", "ownerId", "balanceNanoUsd", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${ref.tenantId}, ${ref.ownerType}, ${ref.ownerId}, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("tenantId", "ownerType", "ownerId") DO UPDATE SET "updatedAt" = "ai_wallets"."updatedAt" RETURNING *
    `)
    return firstOrThrow(rows)
  }

  /** Insert a wallet entry, returning the stored row. */
  private async insertWalletEntry(tx: SqlExecutor, walletId: string, entry: NewWalletEntry): Promise<WalletEntry> {
    const rows = await tx.$queryRaw<WalletEntryRow[]>(Prisma.sql`
      INSERT INTO "ai_wallet_entries" ("id", "walletId", "type", "amountNanoUsd", "priority", "effectiveAt", "expiresAt", "usageRecordId", "idempotencyKey", "reason", "createdAt")
      VALUES (${randomUUID()}, ${walletId}, ${entry.type}, ${entry.amountNanoUsd}, ${entry.priority}, ${entry.effectiveAt}, ${entry.expiresAt ?? null}, ${entry.usageRecordId ?? null}, ${entry.idempotencyKey}, ${entry.reason ?? null}, CURRENT_TIMESTAMP)
      RETURNING *
    `)
    return mapWalletEntryRow(firstOrThrow(rows))
  }

  /** Insert the debit→grant allocation trail. */
  private async insertAllocations(
    tx: SqlExecutor,
    debitEntryId: string,
    allocations: { grantEntryId: string; amountNanoUsd: bigint }[],
  ): Promise<void> {
    for (const allocation of allocations) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "ai_wallet_debit_allocations" ("id", "debitEntryId", "grantEntryId", "amountNanoUsd")
        VALUES (${randomUUID()}, ${debitEntryId}, ${allocation.grantEntryId}, ${allocation.amountNanoUsd})
      `)
    }
  }

  /** Apply a signed delta to the materialized balance. */
  private async applyBalanceDelta(tx: SqlExecutor, walletId: string, delta: bigint): Promise<void> {
    if (delta === 0n) return
    await tx.$executeRaw(Prisma.sql`
      UPDATE "ai_wallets" SET "balanceNanoUsd" = "balanceNanoUsd" + ${delta}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${walletId}
    `)
  }

  /** Write an `expiry` entry (with its allocation) for each expired grant with a remainder. */
  private async sweepExpiredGrants(tx: SqlExecutor, walletId: string): Promise<void> {
    const now = new Date()
    const grants = await tx.$queryRaw<{ id: string; priority: number; remaining: bigint }[]>(Prisma.sql`
      SELECT g."id", g."priority", (g."amountNanoUsd" - COALESCE((SELECT SUM(a."amountNanoUsd") FROM "ai_wallet_debit_allocations" a WHERE a."grantEntryId" = g."id"), 0))::bigint AS "remaining"
      FROM "ai_wallet_entries" g
      WHERE g."walletId" = ${walletId} AND g."type" = 'grant'
        AND g."effectiveAt" <= g."createdAt" AND (g."expiresAt" IS NULL OR g."expiresAt" > g."createdAt")
        AND g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${now}
    `)
    for (const grant of grants) {
      if (grant.remaining <= 0n) continue
      const expiry = await this.insertWalletEntry(tx, walletId, {
        walletId,
        type: 'expiry',
        amountNanoUsd: -grant.remaining,
        priority: grant.priority,
        effectiveAt: now,
        idempotencyKey: `expiry:${grant.id}`,
        reason: 'grant expired',
      })
      await this.insertAllocations(tx, expiry.id, [{ grantEntryId: grant.id, amountNanoUsd: grant.remaining }])
      await this.applyBalanceDelta(tx, walletId, -grant.remaining)
    }
  }

  /** Greedily allocate a debit of `cost` across the open grants in burn order. */
  private async burnDown(tx: SqlExecutor, walletId: string, cost: bigint): Promise<{ grantEntryId: string; amountNanoUsd: bigint }[]> {
    const grants = await tx.$queryRaw<OpenGrantRow[]>(this.openGrantsSql(walletId, this.burnOrder))
    const trail: { grantEntryId: string; amountNanoUsd: bigint }[] = []
    let remaining = cost
    for (const grant of grants) {
      if (remaining <= 0n) break
      const take = grant.remaining < remaining ? grant.remaining : remaining
      trail.push({ grantEntryId: grant.id, amountNanoUsd: take })
      remaining -= take
    }
    return trail
  }

  /** The open-grants query (remaining > 0, effective, not expired) ordered per burn order. */
  private openGrantsSql(walletId: string, order: 'expiry' | 'priority' | 'fifo'): Prisma.Sql {
    const now = new Date()
    const orderBy =
      order === 'priority'
        ? Prisma.sql`g."priority" ASC, g."createdAt" ASC`
        : order === 'fifo'
          ? Prisma.sql`g."createdAt" ASC`
          : Prisma.sql`g."expiresAt" ASC NULLS LAST, g."createdAt" ASC`
    return Prisma.sql`
      SELECT g.*, (g."amountNanoUsd" - COALESCE((SELECT SUM(a."amountNanoUsd") FROM "ai_wallet_debit_allocations" a WHERE a."grantEntryId" = g."id"), 0))::bigint AS "remaining"
      FROM "ai_wallet_entries" g
      WHERE g."walletId" = ${walletId} AND g."type" = 'grant'
        AND g."effectiveAt" <= ${now} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${now})
        AND (g."amountNanoUsd" - COALESCE((SELECT SUM(a."amountNanoUsd") FROM "ai_wallet_debit_allocations" a WHERE a."grantEntryId" = g."id"), 0)) > 0
      ORDER BY ${orderBy}
    `
  }

  /** Return the existing entry on a matching replay, throw the conflict, or `undefined` when new. */
  private async walletReplay(tx: SqlExecutor, walletId: string, ref: WalletRef, entry: NewWalletEntry): Promise<WalletEntry | undefined> {
    const rows = await tx.$queryRaw<WalletEntryRow[]>(
      Prisma.sql`SELECT * FROM "ai_wallet_entries" WHERE "walletId" = ${walletId} AND "idempotencyKey" = ${entry.idempotencyKey} LIMIT 1`,
    )
    if (rows[0] === undefined) return undefined
    if (walletEntryMatches(rows[0], entry)) return mapWalletEntryRow(rows[0])
    throw new LedgerIdempotencyConflict(ref.tenantId, entry.idempotencyKey)
  }

  /** Ensure a (zeroed) window row exists for first-touch consumption. */
  private async ensureWindow(tx: SqlExecutor, budgetId: string, windowStart: Date): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ai_budget_windows" ("id", "budgetId", "windowStart", "spentNanoUsd", "spentTokens", "spentCount", "updatedAt")
      VALUES (${randomUUID()}, ${budgetId}, ${windowStart}, 0, 0, 0, CURRENT_TIMESTAMP)
      ON CONFLICT ("budgetId", "windowStart") DO NOTHING
    `)
  }

  /** Map the P2002 replay-or-conflict path for a wallet entry (§15.2). */
  private async replayOrConflictWallet(ref: WalletRef, entry: NewWalletEntry): Promise<WalletEntry> {
    const wallet = await this.getWallet(ref)
    if (wallet !== null) {
      const rows = await this.prisma.$queryRaw<WalletEntryRow[]>(
        Prisma.sql`SELECT * FROM "ai_wallet_entries" WHERE "walletId" = ${wallet.id} AND "idempotencyKey" = ${entry.idempotencyKey} LIMIT 1`,
      )
      if (rows[0] !== undefined && walletEntryMatches(rows[0], entry)) return mapWalletEntryRow(rows[0])
    }
    throw new LedgerIdempotencyConflict(ref.tenantId, entry.idempotencyKey)
  }

  /** Return the existing record on a matching payload replay, else raise the conflict (§15.2). */
  private async replayOrConflict(record: NewUsageRecord, payloadHash: string): Promise<UsageRecord> {
    const rows = await this.prisma.$queryRaw<UsageRow[]>(
      Prisma.sql`SELECT * FROM "ai_usage_records" WHERE "tenantId" = ${record.tenantId} AND "idempotencyKey" = ${record.idempotencyKey} LIMIT 1`,
    )
    if (rows[0]?.payloadHash === payloadHash) return mapUsageRow(rows[0])
    throw new LedgerIdempotencyConflict(record.tenantId, record.idempotencyKey)
  }
}
