/**
 * @fileoverview `PrismaAiTokensStore` — the official PostgreSQL adapter (spec
 * §15.1–15.3). It implements the ledger + pricing halves of `IAiTokensStore`
 * against any Prisma client with the raw-query members of `PrismaRawClient`, talking to
 * PostgreSQL EXCLUSIVELY through PARAMETERIZED raw SQL (`$queryRawUnsafe`/
 * `$executeRawUnsafe`/`$transaction`) so it never depends on generated model delegates
 * or on Prisma's runtime, and stays valid against the host's schema and generator.
 * Column identifiers are checked constants (never interpolated from input) and
 * every value is a bound parameter, so the raw SQL is injection-safe (see `./sql`). Money is
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
  ApplicationOutcome,
  BudgetDelta,
  BudgetKey,
  BudgetLimits,
  BudgetReference,
  BudgetWindowSpend,
  CommitOutcome,
  DropOutcome,
  IAiTokensStore,
  LedgerCostSummary,
  OpenGrant,
  PricedModel,
  WalletEntryFilter,
  WalletEntryPage,
} from '../server'
// By package specifier, not by relative path: entry points are separate
// bundles, so a relative import would copy the class into this one and the
// server's four `instanceof AiTokensException` guards would stop matching
// what this store throws — silently, since the copy has the same name.
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { SqlClient, type PrismaRawClient, type SqlExecutor } from './raw-client'
import { BudgetApplications } from './budget-applications'
import { adjustWindowSql, consumeWindowSql, ensureWindowSql } from './budget-statements'
import { empty, join, sql, type Sql } from './sql'
import { LedgerIdempotencyConflict, isLedgerIdempotencyConflict } from '../server/services/ledger-idempotency-conflict'
import { chainHash } from '../server/utils/hash-chain'
import { attachCause } from '../server/errors/attach-cause'
import { setErrorMessage } from '../server/errors/set-error-message'
import { ACTIVATION_REASON, RESERVED_KEY_HELD_MESSAGE, RESERVED_KEY_HELD_REASON, RESERVED_KEY_REASON, activationKey, expiryKey, isReservedWalletKey } from '../server/utils/wallet-keys'
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
  priceLockKey,
  priceValues,
  spendableBalanceSql,
  GRANT_REMAINING_JOIN_SQL,
  ACTIVATED_SQL,
  CREDITED_SQL,
  DB_NOW_SQL,
  DUE_AT_APPEND_SQL,
  clockSql,
  pendingGrantsSql,
  GRANT_REMAINING_JOINED_SQL,
  GRANT_REMAINING_SQL,
  SIGNED_BALANCE_SQL,
  statusAssignments,
  rethrowAsStoreError,
  storeError,
  usageValues,
  walletAutoCreatable,
  walletBalanceDelta,
  walletEntryMatches,
  walletEntryWhere,
} from './adapter-sql'
import type { BudgetRow, BudgetWindowRow, OpenGrantRow, PriceRow, UsageRow, WalletEntryRow, WalletRow } from './adapter-sql'

/**
 * Refuse a caller's entry whose key is in the namespace the store writes for itself. The error is built
 * here, from the class this entry point takes from the package root.
 */
function assertCallerKey(idempotencyKey: string): void {
  if (!isReservedWalletKey(idempotencyKey)) return
  // Stryker disable next-line ObjectLiteral: error context is internal diagnostics; tests check the error code only
  throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: RESERVED_KEY_REASON })
}

/**
 * The refusal for a reserved key that another entry holds. The body names the code and a fixed reason; the wallet,
 * key and grant ride on the cause, for the server-side log, because the body is what a client receives.
 */
function reservedKeyHeld(walletId: string, key: string, grantId: string): AiTokensException {
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and cause text are internal diagnostics; tests check the code and the identifiers
  return attachCause(
    setErrorMessage(new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: RESERVED_KEY_HELD_REASON }), RESERVED_KEY_HELD_MESSAGE),
    new Error(`wallet ${walletId}: the reserved key ${key} of grant ${grantId} is held by an entry the store did not write`),
  )
}

/**
 * The official PostgreSQL adapter. Construct it with the host's `PrismaClient`
 * (the host's schema must include the shipped models, §15.3).
 */
export class PrismaAiTokensStore implements IAiTokensStore {
  private readonly prisma: SqlClient
  private readonly applications: BudgetApplications
  private readonly burnOrder: 'expiry' | 'priority' | 'fifo'

  /**
   * @param client The host's Prisma client (talks to PostgreSQL); any client with the raw-query members of {@link PrismaRawClient}.
   * @param options Optional wallet grant burn order (must match the module's `wallets.burnOrder`; default `'expiry'`).
   */
  constructor(client: PrismaRawClient, options: { burnOrder?: 'expiry' | 'priority' | 'fifo' } = {}) {
    this.prisma = new SqlClient(client)
    this.applications = new BudgetApplications(this.prisma)
    this.burnOrder = options.burnOrder ?? 'expiry'
  }

  async append(record: NewUsageRecord, payloadHash: string, hashChain?: boolean): Promise<UsageRecord> {
    try {
      if (hashChain === true && record.status === 'posted') {
        return await this.prisma.transaction((tx) => this.insertChained(tx, record, payloadHash))
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
    const rows = await this.prisma.query<UsageRow[]>(
      sql`SELECT * FROM "ai_usage_records" WHERE "tenantId" = ${tenantId} AND "idempotencyKey" = ${key} LIMIT 1`,
    )
    return rows[0] === undefined ? null : mapUsageRow(rows[0])
  }

  async findById(id: string): Promise<UsageRecord | null> {
    const rows = await this.prisma.query<UsageRow[]>(
      sql`SELECT * FROM "ai_usage_records" WHERE "id" = ${id} LIMIT 1`,
    )
    return rows[0] === undefined ? null : mapUsageRow(rows[0])
  }

  async findExpiredHolds(olderThan: Date, limit: number): Promise<UsageRecord[]> {
    const rows = await this.prisma.query<UsageRow[]>(sql`
      SELECT * FROM "ai_usage_records"
      WHERE "status" = 'pending' AND "createdAt" < ${olderThan}
      ORDER BY "createdAt" ASC LIMIT ${limit}
    `)
    return rows.map(mapUsageRow)
  }

  async query(filter: LedgerFilter): Promise<UsageRecord[]> {
    const limit = filter.limit === undefined ? empty : sql`LIMIT ${filter.limit}`
    const offset = filter.offset === undefined ? empty : sql`OFFSET ${filter.offset}`
    const rows = await this.prisma.query<UsageRow[]>(sql`
      SELECT * FROM "ai_usage_records" WHERE ${buildWhere(filter)}
      ORDER BY "createdAt" ASC ${limit} ${offset}
    `).catch(rethrowAsStoreError)
    return rows.map(mapUsageRow)
  }

  async sumCost(filter: LedgerFilter): Promise<LedgerCostSummary> {
    const rows = await this.prisma.query<{ raw: bigint; billed: bigint; surcharge: bigint; tokens: bigint; records: number }[]>(sql`
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
    const rows = await this.prisma.query<PriceRow[]>(sql`
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
    const key = priceLockKey(input.provider, input.model, input.operation, serviceTier)
    return this.prisma.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`)
      await tx.execute(sql`
        UPDATE "ai_model_prices" SET "effectiveTo" = ${effectiveFrom}
        WHERE "provider" = ${input.provider} AND "model" = ${input.model} AND "operation" = ${input.operation}
          AND "serviceTier" = ${serviceTier} AND "effectiveTo" IS NULL
      `)
      const rows = await tx.query<PriceRow[]>(sql`
        INSERT INTO "ai_model_prices" (${PRICE_COLUMNS_SQL}) VALUES (${join(priceValues(input, serviceTier, effectiveFrom))})
        RETURNING *
      `)
      return mapPriceRow(firstOrThrow(rows))
    })
  }

  /**
   * Insert a price row only when its (provider, model, operation, serviceTier) tuple has no
   * row yet. The check and the insert run in one transaction under the same per-tuple
   * `pg_advisory_xact_lock` as {@link upsertPrice}, so concurrent boots serialize on the
   * tuple, the loser finds the winner's row and inserts nothing, and the lock is released
   * when the transaction ends rather than when the connection does.
   */
  async seedPrice(input: NewPriceVersion): Promise<boolean> {
    const serviceTier: ServiceTier = input.serviceTier ?? 'standard'
    const effectiveFrom = input.effectiveFrom ?? new Date()
    const key = priceLockKey(input.provider, input.model, input.operation, serviceTier)
    return this.prisma.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`)
      const existing = await tx.query<{ id: string }[]>(sql`
        SELECT "id" FROM "ai_model_prices"
        WHERE "provider" = ${input.provider} AND "model" = ${input.model} AND "operation" = ${input.operation}
          AND "serviceTier" = ${serviceTier}
        LIMIT 1
      `)
      if (existing.length > 0) return false
      await tx.query(sql`
        INSERT INTO "ai_model_prices" (${PRICE_COLUMNS_SQL}) VALUES (${join(priceValues(input, serviceTier, effectiveFrom))})
        RETURNING *
      `)
      return true
    })
  }

  async getPriceHistory(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier?: ServiceTier,
  ): Promise<PriceVersion[]> {
    const tier = serviceTier === undefined ? empty : sql`AND "serviceTier" = ${serviceTier}`
    const rows = await this.prisma.query<PriceRow[]>(sql`
      SELECT * FROM "ai_model_prices"
      WHERE "provider" = ${provider} AND "model" = ${model} AND "operation" = ${operation} ${tier}
      ORDER BY "effectiveFrom" DESC
    `)
    return rows.map(mapPriceRow)
  }

  async listModels(provider: ProviderId): Promise<PricedModel[]> {
    const rows = await this.prisma.query<{ model: string; operation: string; serviceTier: string }[]>(sql`
      SELECT DISTINCT "model", "operation", "serviceTier" FROM "ai_model_prices" WHERE "provider" = ${provider}
    `)
    return rows.map((row) => ({ model: row.model, operation: row.operation as AiOperation, serviceTier: row.serviceTier as ServiceTier }))
  }

  /**
   * Session-scoped advisory lock: the first caller on a connection wins, and the lock is held
   * until that connection closes, not when a boot ends.
   *
   * @deprecated Use {@link seedPrice}, which seeds atomically under a transaction-scoped lock.
   */
  async acquireSeedLock(key: string): Promise<boolean> {
    const rows = await this.prisma.query<{ acquired: boolean }[]>(
      sql`SELECT pg_try_advisory_lock(hashtext(${key})::bigint) AS "acquired"`,
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
    const values = join(usageValues(id, record, payloadHash, prevHash, hash))
    const rows = await executor.query<UsageRow[]>(
      sql`INSERT INTO "ai_usage_records" (${USAGE_COLUMNS_SQL}) VALUES (${values}) RETURNING *`,
    )
    return mapUsageRow(firstOrThrow(rows))
  }

  /** Insert a `posted` row under the per-tenant chain lock (§8.6). */
  private async insertChained(tx: SqlExecutor, record: NewUsageRecord, payloadHash: string): Promise<UsageRecord> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.tenantId})::bigint)`)
    const prevHash = await this.lastHashWithin(tx, record.tenantId)
    const id = randomUUID()
    const hash = chainHash(prevHash, { ...record, id })
    return this.insert(tx, id, record, payloadHash, prevHash, hash)
  }

  /** Settle a hold `pending → posted`, computing its chain hash under the lock (§8.6). */
  private settleChained(id: string, from: UsageStatus, patch?: Partial<UsageRecord>): Promise<UsageRecord | null> {
    return this.prisma.transaction(async (tx) => {
      const rows = await tx.query<UsageRow[]>(
        sql`SELECT * FROM "ai_usage_records" WHERE "id" = ${id} AND "status" = ${from} FOR UPDATE`,
      )
      if (rows[0] === undefined) return null
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${rows[0].tenantId})::bigint)`)
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
    const rows = await executor.query<UsageRow[]>(
      sql`UPDATE "ai_usage_records" SET ${assignments} WHERE "id" = ${id} AND "status" = ${from} RETURNING *`,
    )
    return rows[0] === undefined ? null : mapUsageRow(rows[0])
  }

  /**
   * The tenant's last chain hash: the hash that no other record of the tenant names as its predecessor. The tail is
   * found by the chain's own links and not by creation time, because rows stamped by different clocks (a database
   * that changed the zone it stamps in) do not sort in the order they were written. Should the chain already have
   * forked, the newest of the tails is taken, ties broken by id.
   */
  private async lastHashWithin(executor: SqlExecutor, tenantId: string): Promise<string | null> {
    const rows = await executor.query<{ hash: string }[]>(sql`
      SELECT r."hash" FROM "ai_usage_records" r
      WHERE r."tenantId" = ${tenantId} AND r."hash" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "ai_usage_records" n WHERE n."tenantId" = ${tenantId} AND n."prevHash" = r."hash")
      ORDER BY r."createdAt" DESC, r."id" DESC LIMIT 1
    `)
    return rows[0]?.hash ?? null
  }

  async getWallet(ref: WalletRef): Promise<Wallet | null> {
    const rows = await this.prisma.query<WalletRow[]>(sql`
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
    assertCallerKey(entry.idempotencyKey)
    try {
      return await this.prisma.transaction(async (tx) => {
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

  async conditionalDebit(ref: WalletRef, entry: NewWalletEntry, overdraftNanoUsd: bigint, now?: Date): Promise<WalletEntry | null> {
    assertCallerKey(entry.idempotencyKey)
    try {
      return await this.prisma.transaction(async (tx) => {
        const wallet = (await this.getWalletWithin(tx, ref)) ?? null
        if (wallet === null) return null
        await this.lockWallet(tx, wallet.id)
        const replay = await this.walletReplay(tx, wallet.id, ref, entry)
        if (replay !== undefined) return replay
        await this.activateDueGrants(tx, wallet.id, now)
        await this.sweepExpiredGrants(tx, wallet.id, now)
        const cost = -entry.amountNanoUsd
        const reserved = await tx.query<WalletRow[]>(sql`
          UPDATE "ai_wallets" SET "balanceNanoUsd" = "balanceNanoUsd" - ${cost}, "updatedAt" = ${DB_NOW_SQL}
          WHERE "id" = ${wallet.id} AND "balanceNanoUsd" - ${pendingGrantsSql(wallet.id, now)} - ${cost} >= ${-overdraftNanoUsd} RETURNING *
        `)
        if (reserved[0] === undefined) return null
        const debit = await this.insertWalletEntry(tx, wallet.id, entry)
        await this.insertAllocations(tx, debit.id, await this.burnDown(tx, wallet.id, cost, now))
        return debit
      })
    } catch (error) {
      if (isLedgerIdempotencyConflict(error)) throw error
      if (isUniqueViolation(error)) return this.replayOrConflictWallet(ref, entry)
      throw storeError(error)
    }
  }

  async openGrants(ref: WalletRef, order: 'expiry' | 'priority' | 'fifo', now?: Date): Promise<OpenGrant[]> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) return []
    const rows = await this.prisma.query<OpenGrantRow[]>(this.openGrantsSql(wallet.id, order, now))
    return rows.map(mapOpenGrantRow)
  }

  async listEntries(ref: WalletRef, filter: WalletEntryFilter = {}): Promise<WalletEntryPage> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) return { entries: [], total: 0 }
    const where = walletEntryWhere(wallet.id, filter)
    const limit = filter.limit === undefined ? empty : sql`LIMIT ${filter.limit}`
    const offset = filter.offset === undefined ? empty : sql`OFFSET ${filter.offset}`
    const [entries, counts] = await Promise.all([
      this.prisma.query<WalletEntryRow[]>(
        sql`SELECT * FROM "ai_wallet_entries" WHERE ${where} ORDER BY "createdAt" ASC, "id" ASC ${limit} ${offset}`,
      ),
      this.prisma.query<{ total: bigint }[]>(sql`SELECT COUNT(*)::bigint AS "total" FROM "ai_wallet_entries" WHERE ${where}`),
    ]).catch(rethrowAsStoreError)
    return { entries: entries.map(mapWalletEntryRow), total: Number(counts[0]?.total ?? 0n) }
  }

  async reconcile(ref: WalletRef, now?: Date): Promise<Wallet> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) throw new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', undefined, { reason: 'wallet does not exist' })
    return this.prisma.transaction(async (tx) => {
      await this.lockWallet(tx, wallet.id)
      await this.activateDueGrants(tx, wallet.id, now)
      await this.sweepExpiredGrants(tx, wallet.id, now)
      const rows = await tx.query<WalletRow[]>(sql`
        UPDATE "ai_wallets" w SET "balanceNanoUsd" = ${spendableBalanceSql(now)}, "updatedAt" = ${DB_NOW_SQL}
        WHERE w."id" = ${wallet.id} RETURNING *
      `)
      return mapWalletRow(firstOrThrow(rows))
    })
  }

  async upsert(input: Omit<Budget, 'id' | 'createdAt'> & { id?: string; createdAt?: Date }): Promise<Budget> {
    const id = input.id ?? randomUUID()
    const rows = await this.prisma.query<BudgetRow[]>(sql`
      INSERT INTO "ai_budgets" (${BUDGET_COLUMNS_SQL}) VALUES (${join(budgetValues(id, input))})
      ON CONFLICT ("id") DO UPDATE SET ${budgetUpdateAssignments(input)} WHERE "ai_budgets"."tenantId" = EXCLUDED."tenantId" RETURNING *
    `)
    // A foreign tenant's id updates nothing: refuse it without saying whose it is.
    if (rows[0] === undefined) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'budget id is not available' })
    return mapBudgetRow(rows[0])
  }

  async remove(key: BudgetKey): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM "ai_budget_windows" WHERE "budgetId" IN (SELECT "id" FROM "ai_budgets" WHERE "id" = ${key.id} AND "tenantId" = ${key.tenantId})`)
      await tx.execute(sql`DELETE FROM "ai_budgets" WHERE "id" = ${key.id} AND "tenantId" = ${key.tenantId}`)
    })
  }

  async findBudgetById(key: BudgetKey): Promise<Budget | null> {
    const rows = await this.prisma.query<BudgetRow[]>(sql`SELECT * FROM "ai_budgets" WHERE "id" = ${key.id} AND "tenantId" = ${key.tenantId} LIMIT 1`)
    return rows[0] === undefined ? null : mapBudgetRow(rows[0])
  }

  async findMatching(tenantId: string, scope: MeteringScope): Promise<Budget[]> {
    const now = new Date()
    const rows = await this.prisma.query<BudgetRow[]>(sql`
      SELECT * FROM "ai_budgets"
      WHERE "tenantId" = ${tenantId}
        AND ("scopeType" = 'tenant' OR ("scopeType" = ${scope.type} AND "scopeId" = ${scope.id}))
        AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
    `)
    return rows.map(mapBudgetRow)
  }

  async conditionalConsume(budgetId: string, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Promise<boolean> {
    return this.prisma.transaction(async (tx) => {
      await tx.execute(ensureWindowSql(budgetId, windowStart))
      return (await tx.query<{ id: string }[]>(consumeWindowSql(budgetId, windowStart, delta, limits)))[0] !== undefined
    })
  }

  async adjustWindow(budgetId: string, windowStart: Date, delta: BudgetDelta): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      await tx.execute(ensureWindowSql(budgetId, windowStart))
      await tx.execute(adjustWindowSql(budgetId, windowStart, delta))
    })
  }

  consumeWindowOnce(reference: BudgetReference, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Promise<ApplicationOutcome> {
    return this.applications.consume(reference, windowStart, delta, limits)
  }

  adjustWindowOnce(reference: BudgetReference, windowStart: Date, delta: BudgetDelta): Promise<'applied' | 'replayed' | 'mismatch'> {
    return this.applications.adjust(reference, windowStart, delta)
  }

  commitReference(reference: BudgetReference): Promise<CommitOutcome> {
    return this.applications.commit(reference)
  }

  dropReference(reference: BudgetReference): Promise<DropOutcome> {
    return this.applications.drop(reference)
  }

  async getWindow(budgetId: string, windowStart: Date): Promise<BudgetWindowSpend | null> {
    const rows = await this.prisma.query<BudgetWindowRow[]>(
      sql`SELECT * FROM "ai_budget_windows" WHERE "budgetId" = ${budgetId} AND "windowStart" = ${windowStart} LIMIT 1`,
    )
    return rows[0] === undefined ? null : mapBudgetWindowRow(rows[0])
  }

  async setWindowStart(key: BudgetKey, windowStart: Date): Promise<void> {
    await this.prisma.execute(sql`
      INSERT INTO "ai_budget_windows" ("id", "budgetId", "windowStart", "spentNanoUsd", "spentTokens", "spentCount", "updatedAt")
      SELECT ${randomUUID()}, "id", ${windowStart}, 0, 0, 0, ${DB_NOW_SQL} FROM "ai_budgets" WHERE "id" = ${key.id} AND "tenantId" = ${key.tenantId}
      ON CONFLICT ("budgetId", "windowStart") DO UPDATE SET "spentNanoUsd" = 0, "spentTokens" = 0, "spentCount" = 0, "updatedAt" = ${DB_NOW_SQL}
    `)
  }

  /** Load the wallet within a transaction (existence + id for the conditional debit). */
  private async getWalletWithin(tx: SqlExecutor, ref: WalletRef): Promise<WalletRow | undefined> {
    const rows = await tx.query<WalletRow[]>(sql`
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
    const rows = await tx.query<WalletRow[]>(sql`
      INSERT INTO "ai_wallets" ("id", "tenantId", "ownerType", "ownerId", "balanceNanoUsd", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${ref.tenantId}, ${ref.ownerType}, ${ref.ownerId}, 0, ${DB_NOW_SQL}, ${DB_NOW_SQL})
      ON CONFLICT ("tenantId", "ownerType", "ownerId") DO UPDATE SET "updatedAt" = "ai_wallets"."updatedAt" RETURNING *
    `)
    return firstOrThrow(rows)
  }

  /** Insert a wallet entry, returning the stored row. */
  private async insertWalletEntry(tx: SqlExecutor, walletId: string, entry: NewWalletEntry): Promise<WalletEntry> {
    const rows = await tx.query<WalletEntryRow[]>(sql`
      INSERT INTO "ai_wallet_entries" ("id", "walletId", "type", "amountNanoUsd", "priority", "effectiveAt", "expiresAt", "usageRecordId", "idempotencyKey", "reason", "createdAt")
      VALUES (${randomUUID()}, ${walletId}, ${entry.type}, ${entry.amountNanoUsd}, ${entry.priority}, ${entry.effectiveAt}, ${entry.expiresAt ?? null}, ${entry.usageRecordId ?? null}, ${entry.idempotencyKey}, ${entry.reason ?? null}, ${DB_NOW_SQL})
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
      await tx.execute(sql`
        INSERT INTO "ai_wallet_debit_allocations" ("id", "debitEntryId", "grantEntryId", "amountNanoUsd")
        VALUES (${randomUUID()}, ${debitEntryId}, ${allocation.grantEntryId}, ${allocation.amountNanoUsd})
      `)
    }
  }

  /** Apply a signed delta to the materialized balance. */
  private async applyBalanceDelta(tx: SqlExecutor, walletId: string, delta: bigint): Promise<void> {
    if (delta === 0n) return
    await tx.execute(sql`
      UPDATE "ai_wallets" SET "balanceNanoUsd" = "balanceNanoUsd" + ${delta}, "updatedAt" = ${DB_NOW_SQL} WHERE "id" = ${walletId}
    `)
  }

  /**
   * Serialize the debits, activations and sweeps of one wallet on its row.
   * @internal
   */
  private async lockWallet(tx: SqlExecutor, walletId: string): Promise<void> {
    await tx.query(sql`SELECT "id" FROM "ai_wallets" WHERE "id" = ${walletId} FOR UPDATE`)
  }

  /**
   * Insert a system entry (an activation or an expiry) effective at `now` and created on the database clock, once per
   * key. Returns the stored row, or `undefined` when the key already exists.
   * @internal
   */
  private async insertSystemEntry(
    tx: SqlExecutor,
    walletId: string,
    entry: { type: 'adjustment' | 'expiry'; amountNanoUsd: bigint; priority: number; idempotencyKey: string; reason: string },
    now?: Date,
  ): Promise<WalletEntry | undefined> {
    const rows = await tx.query<WalletEntryRow[]>(sql`
      INSERT INTO "ai_wallet_entries" ("id", "walletId", "type", "amountNanoUsd", "priority", "effectiveAt", "expiresAt", "usageRecordId", "idempotencyKey", "reason", "createdAt")
      VALUES (${randomUUID()}, ${walletId}, ${entry.type}, ${entry.amountNanoUsd}, ${entry.priority}, ${clockSql(now)}, NULL, NULL, ${entry.idempotencyKey}, ${entry.reason}, ${DB_NOW_SQL})
      ON CONFLICT ("walletId", "idempotencyKey") DO NOTHING
      RETURNING *
    `)
    return rows[0] === undefined ? undefined : mapWalletEntryRow(rows[0])
  }

  /**
   * Credit, once each, every grant that is now due, not credited yet and not expired: an `adjustment`
   * entry keyed `activate:<grantId>` records the credit, and the stored balance is then set to the signed
   * sum of the entries rather than incremented, so a balance that already counts a grant (as an earlier
   * `reconcile` left it) is not credited a second time. A grant that was due as it was appended,
   * judged on the stored `createdAt`, is credited by its own row and is not touched here.
   * @internal
   */
  private async activateDueGrants(tx: SqlExecutor, walletId: string, now?: Date): Promise<void> {
    const due = await tx.query<{ id: string; priority: number; amountNanoUsd: bigint }[]>(sql`
      SELECT g."id", g."priority", g."amountNanoUsd"
      FROM "ai_wallet_entries" g
      WHERE g."walletId" = ${walletId} AND g."type" = 'grant'
        AND NOT ${DUE_AT_APPEND_SQL}
        AND g."effectiveAt" <= ${clockSql(now)} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${clockSql(now)})
        AND NOT ${ACTIVATED_SQL}
    `)
    for (const grant of due) {
      const activation = await this.insertSystemEntry(tx, walletId, {
        type: 'adjustment',
        amountNanoUsd: grant.amountNanoUsd,
        priority: grant.priority,
        idempotencyKey: activationKey(grant.id),
        reason: ACTIVATION_REASON,
      }, now)
      // The wallet row is locked and the grants listed are not activated by shape, so a taken key is an entry the
      // store did not write: crediting without the marker would credit the grant again at the next reconcile.
      if (activation === undefined) throw reservedKeyHeld(walletId, activationKey(grant.id), grant.id)
    }
    if (due.length === 0) return
    await tx.execute(sql`
      UPDATE "ai_wallets" w SET "balanceNanoUsd" = ${SIGNED_BALANCE_SQL}, "updatedAt" = ${DB_NOW_SQL} WHERE w."id" = ${walletId}
    `)
  }

  /** Write an `expiry` entry (with its allocation) for each credited, expired grant with a remainder. */
  private async sweepExpiredGrants(tx: SqlExecutor, walletId: string, now?: Date): Promise<void> {
    const grants = await tx.query<{ id: string; priority: number; remaining: bigint }[]>(sql`
      SELECT g."id", g."priority", ${GRANT_REMAINING_SQL}::bigint AS "remaining"
      FROM "ai_wallet_entries" g
      WHERE g."walletId" = ${walletId} AND g."type" = 'grant' AND ${CREDITED_SQL}
        AND g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${clockSql(now)}
    `)
    for (const grant of grants) {
      if (grant.remaining <= 0n) continue
      const expiry = await this.insertSystemEntry(tx, walletId, {
        type: 'expiry',
        amountNanoUsd: -grant.remaining,
        priority: grant.priority,
        idempotencyKey: expiryKey(grant.id),
        reason: 'grant expired',
      }, now)
      // The wallet row is locked and a swept grant has no remainder, so a taken key here is an entry
      // written outside the store (before the namespace was reserved). Skipping would keep the expired
      // credit spendable, so the debit is refused instead.
      if (expiry === undefined) throw reservedKeyHeld(walletId, expiryKey(grant.id), grant.id)
      await this.insertAllocations(tx, expiry.id, [{ grantEntryId: grant.id, amountNanoUsd: grant.remaining }])
      await this.applyBalanceDelta(tx, walletId, -grant.remaining)
    }
  }

  /** Greedily allocate a debit of `cost` across the open grants in burn order. */
  private async burnDown(tx: SqlExecutor, walletId: string, cost: bigint, now?: Date): Promise<{ grantEntryId: string; amountNanoUsd: bigint }[]> {
    const grants = await tx.query<OpenGrantRow[]>(this.openGrantsSql(walletId, this.burnOrder, now))
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

  /** The open-grants query (credited, remaining > 0, effective and not expired at `now`) ordered per burn order. */
  private openGrantsSql(walletId: string, order: 'expiry' | 'priority' | 'fifo', now?: Date): Sql {
    const orderBy =
      order === 'priority'
        ? sql`g."priority" ASC, g."createdAt" ASC, g."id" ASC`
        : order === 'fifo'
          ? sql`g."createdAt" ASC, g."id" ASC`
          : sql`g."expiresAt" ASC NULLS LAST, g."createdAt" ASC, g."id" ASC`
    return sql`
      SELECT g.*, ${GRANT_REMAINING_JOINED_SQL}::bigint AS "remaining"
      FROM "ai_wallet_entries" g ${GRANT_REMAINING_JOIN_SQL}
      WHERE g."walletId" = ${walletId} AND g."type" = 'grant' AND ${CREDITED_SQL}
        AND g."effectiveAt" <= ${clockSql(now)} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${clockSql(now)})
        AND ${GRANT_REMAINING_JOINED_SQL} > 0
      ORDER BY ${orderBy}
    `
  }

  /** Return the existing entry on a matching replay, throw the conflict, or `undefined` when new. */
  private async walletReplay(tx: SqlExecutor, walletId: string, ref: WalletRef, entry: NewWalletEntry): Promise<WalletEntry | undefined> {
    const rows = await tx.query<WalletEntryRow[]>(
      sql`SELECT * FROM "ai_wallet_entries" WHERE "walletId" = ${walletId} AND "idempotencyKey" = ${entry.idempotencyKey} LIMIT 1`,
    )
    if (rows[0] === undefined) return undefined
    if (walletEntryMatches(rows[0], entry)) return mapWalletEntryRow(rows[0])
    throw new LedgerIdempotencyConflict(ref.tenantId, entry.idempotencyKey)
  }

  /** Map the P2002 replay-or-conflict path for a wallet entry (§15.2). */
  private async replayOrConflictWallet(ref: WalletRef, entry: NewWalletEntry): Promise<WalletEntry> {
    const wallet = await this.getWallet(ref)
    if (wallet !== null) {
      const rows = await this.prisma.query<WalletEntryRow[]>(
        sql`SELECT * FROM "ai_wallet_entries" WHERE "walletId" = ${wallet.id} AND "idempotencyKey" = ${entry.idempotencyKey} LIMIT 1`,
      )
      if (rows[0] !== undefined && walletEntryMatches(rows[0], entry)) return mapWalletEntryRow(rows[0])
    }
    throw new LedgerIdempotencyConflict(ref.tenantId, entry.idempotencyKey)
  }

  /** Return the existing record on a matching payload replay, else raise the conflict (§15.2). */
  private async replayOrConflict(record: NewUsageRecord, payloadHash: string): Promise<UsageRecord> {
    const rows = await this.prisma.query<UsageRow[]>(
      sql`SELECT * FROM "ai_usage_records" WHERE "tenantId" = ${record.tenantId} AND "idempotencyKey" = ${record.idempotencyKey} LIMIT 1`,
    )
    if (rows[0]?.payloadHash === payloadHash) return mapUsageRow(rows[0])
    throw new LedgerIdempotencyConflict(record.tenantId, record.idempotencyKey)
  }
}

export type { PrismaRawClient, RawExecutor } from './raw-client'
