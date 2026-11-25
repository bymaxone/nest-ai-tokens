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
  BudgetApplication, BudgetDelta,
  BudgetKey,
  BudgetLimits,
  BudgetReference,
  BudgetWindowSpend,
  CommitOutcome,
  DropOutcome,
  StaleReference, StaleReferenceQuery,
  IAiTokensStore,
  LedgerCostSummary,
  OpenGrant,
  OwedEffects,
  OwedEffectsMarker,
  PricedModel,
  WalletDebit,
  WalletDebitQuery,
  RefundToSourceInput,
  WalletBalanceBreakdown,
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
import { guardStoreErrors } from './store-boundary'
import { adjustWindowSql, consumeWindowSql, ensureWindowSql, findBudgetSql, matchingBudgetsSql, removeBudgetSql, removeBudgetWindowsSql, resetWindowSql, windowSql } from './budget-statements'
import { empty, join, sql } from './sql'
import { clearEffectsOwedSql, effectsOwedForSql, effectsOwedSql, mapOwedRow, withMarkerSql } from './effects-owed-sql'
import { LedgerIdempotencyConflict, isLedgerIdempotencyConflict } from '../server/services/ledger-idempotency-conflict'
import { chainHash } from '../server/utils/hash-chain'
import { RESERVED_KEY_REASON, isReservedWalletKey } from '../server/utils/wallet-keys'
import {
  PRICE_COLUMNS_SQL,
  USAGE_COLUMNS_SQL,
  WalletMissingError,
  buildWhere,
  firstOrThrow,
  isUniqueViolation,
  isWalletMissing,
  mapOpenGrantRow,
  mapPriceRow,
  mapUsageRow,
  mapWalletEntryRow,
  mapWalletRow,
  priceLockKey,
  priceValues,
  spendableBalanceSql,
  DB_NOW_SQL,
  pendingGrantsSql,
  statusAssignments,
  awaitStatement,
  storeError,
  usageValues,
  walletAutoCreatable,
  walletBalanceDelta,
  walletEntryOrderSql,
  entryDeltaSql,
  walletEntryMatches,
  walletEntryWhere,
} from './adapter-sql'
import { BUDGET_COLUMNS_SQL, budgetUpdateAssignments, budgetValues, mapBudgetRow, mapBudgetWindowRow } from './budget-rows'
import { balanceAtSql, balanceBreakdownSql, type BreakdownRow } from './balance-statements'
import { splitByWeights } from './refund-split'
import { activateDueGrants, applyBalanceDelta, burnDown, ensureWallet, expireRestoredParts, fundedAllocations, getWalletWithin, insertAllocations, insertWalletEntry, lockWallet, lockedBalance, restorableOf, sourceDebit, sourceRefusal, sweepExpiredGrants } from './wallet-writes'
import { mapWalletDebitRow, openGrantsSql, walletDebitsSql, type WalletDebitRow } from './wallet-statements'
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
    // The option is the host's own: one left out is not answered by a key planted on `Object.prototype`.
    this.burnOrder = (Object.hasOwn(options, 'burnOrder') ? options.burnOrder : undefined) ?? 'expiry'
    return guardStoreErrors(this, (error) => isWalletMissing(error) || isLedgerIdempotencyConflict(error))
  }

  async append(record: NewUsageRecord, payloadHash: string, hashChain?: boolean, owed?: OwedEffectsMarker): Promise<UsageRecord> {
    try {
      if (hashChain === true && record.status === 'posted') {
        return await this.prisma.transaction((tx) => this.insertChained(tx, record, payloadHash, owed))
      }
      return await this.insert(this.prisma, randomUUID(), record, payloadHash, null, null, owed)
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
    owed?: OwedEffectsMarker,
  ): Promise<UsageRecord | null> {
    if (hashChain === true && to === 'posted') return this.settleChained(id, from, patch, owed)
    return this.updateStatus(this.prisma, id, from, to, patch, null, null, owed)
  }

  async findEffectsOwed(olderThan: Date, limit: number): Promise<OwedEffects[]> {
    return (await this.prisma.query<UsageRow[]>(effectsOwedSql(olderThan, limit))).map(mapOwedRow)
  }

  async findEffectsOwedFor(id: string): Promise<OwedEffects | null> {
    const [row] = await this.prisma.query<UsageRow[]>(effectsOwedForSql(id))
    return row === undefined ? null : mapOwedRow(row)
  }

  async clearEffectsOwed(id: string): Promise<boolean> {
    return (await this.prisma.query<unknown[]>(clearEffectsOwedSql(id))).length > 0
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
    const rows = await awaitStatement(
      this.prisma.query<UsageRow[]>(sql`
      SELECT * FROM "ai_usage_records" WHERE ${buildWhere(filter)}
      ORDER BY "createdAt" ASC ${limit} ${offset}
    `),
    )
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
    owed?: OwedEffectsMarker,
  ): Promise<UsageRecord> {
    const rows = await executor.query<UsageRow[]>(withMarkerSql(sql`INSERT INTO "ai_usage_records" (${USAGE_COLUMNS_SQL}) VALUES (${join(usageValues(id, record, payloadHash, prevHash, hash))}) RETURNING *`, owed))
    return mapUsageRow(firstOrThrow(rows))
  }

  /** Insert a `posted` row under the per-tenant chain lock (§8.6). */
  private async insertChained(tx: SqlExecutor, record: NewUsageRecord, payloadHash: string, owed?: OwedEffectsMarker): Promise<UsageRecord> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.tenantId})::bigint)`)
    const prevHash = await this.lastHashWithin(tx, record.tenantId)
    const id = randomUUID()
    const hash = chainHash(prevHash, { ...record, id })
    return this.insert(tx, id, record, payloadHash, prevHash, hash, owed)
  }

  /** Settle a hold `pending → posted`, computing its chain hash under the lock (§8.6). */
  private settleChained(id: string, from: UsageStatus, patch?: Partial<UsageRecord>, owed?: OwedEffectsMarker): Promise<UsageRecord | null> {
    return this.prisma.transaction(async (tx) => {
      const rows = await tx.query<UsageRow[]>(
        sql`SELECT * FROM "ai_usage_records" WHERE "id" = ${id} AND "status" = ${from} FOR UPDATE`,
      )
      if (rows[0] === undefined) return null
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${rows[0].tenantId})::bigint)`)
      const prevHash = await this.lastHashWithin(tx, rows[0].tenantId)
      const settled = { ...mapUsageRow(rows[0]), ...patch, status: 'posted' as const }
      return this.updateStatus(tx, id, from, 'posted', patch, prevHash, chainHash(prevHash, settled), owed)
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
    owed?: OwedEffectsMarker,
  ): Promise<UsageRecord | null> {
    const assignments = statusAssignments(from, to, patch, prevHash, hash)
    const rows = await executor.query<UsageRow[]>(
      withMarkerSql(sql`UPDATE "ai_usage_records" SET ${assignments} WHERE "id" = ${id} AND "status" = ${from} RETURNING *`, owed),
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
        const wallet = await ensureWallet(tx, ref, walletAutoCreatable(entry))
        if (wallet === null) throw new WalletMissingError()
        // The wallet row first, as every other writer takes it: the sequence and the balance after the entry are read under it.
        const balance = await lockedBalance(tx, wallet.id)
        const stored = await insertWalletEntry(tx, wallet.id, entry, sql`${balance}::bigint + ${entryDeltaSql(entry)}`)
        await insertAllocations(tx, stored.id, allocations)
        await applyBalanceDelta(tx, wallet.id, walletBalanceDelta(stored))
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
        const wallet = (await getWalletWithin(tx, ref)) ?? null
        if (wallet === null) return null
        await lockWallet(tx, wallet.id)
        const replay = await this.walletReplay(tx, wallet.id, ref, entry)
        if (replay !== undefined) return replay
        await activateDueGrants(tx, wallet.id, now)
        await sweepExpiredGrants(tx, wallet.id, now)
        const cost = -entry.amountNanoUsd
        const reserved = await tx.query<WalletRow[]>(sql`
          UPDATE "ai_wallets" SET "balanceNanoUsd" = "balanceNanoUsd" - ${cost}, "updatedAt" = ${DB_NOW_SQL}
          WHERE "id" = ${wallet.id} AND "balanceNanoUsd" - ${pendingGrantsSql(wallet.id, now)} - ${cost} >= ${-overdraftNanoUsd} RETURNING *
        `)
        if (reserved[0] === undefined) return null
        const debit = await insertWalletEntry(tx, wallet.id, entry, sql`${firstOrThrow(reserved).balanceNanoUsd}::bigint`)
        await insertAllocations(tx, debit.id, await burnDown(tx, wallet.id, cost, this.burnOrder, now))
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
    const rows = await this.prisma.query<OpenGrantRow[]>(openGrantsSql(wallet.id, order, now))
    return rows.map(mapOpenGrantRow)
  }

  async listEntries(ref: WalletRef, filter: WalletEntryFilter = Object.create(null) as WalletEntryFilter): Promise<WalletEntryPage> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) return { entries: [], total: 0 }
    const where = walletEntryWhere(wallet.id, filter)
    const limit = filter.limit === undefined ? empty : sql`LIMIT ${filter.limit}`
    const offset = filter.offset === undefined ? empty : sql`OFFSET ${filter.offset}`
    // One statement after the other, each waited for natively: `Promise.all` asks the live `Promise.resolve` for every element and builds its
    // answer with the live species, which a host can make answer for the page and the count.
    const entries = await awaitStatement(
      this.prisma.query<WalletEntryRow[]>(
        sql`SELECT * FROM "ai_wallet_entries" WHERE ${where} ORDER BY ${walletEntryOrderSql(filter.order)} ${limit} ${offset}`,
      ),
    )
    const counts = await awaitStatement(this.prisma.query<{ total: bigint }[]>(sql`SELECT COUNT(*)::bigint AS "total" FROM "ai_wallet_entries" WHERE ${where}`))
    return { entries: entries.map(mapWalletEntryRow), total: Number(counts[0]?.total ?? 0n) }
  }

  async refundToSource(ref: WalletRef, input: RefundToSourceInput): Promise<WalletEntry> {
    const { entry, debitEntryId, now } = input
    assertCallerKey(entry.idempotencyKey)
    try {
      return await this.prisma.transaction(async (tx) => {
        const wallet = await getWalletWithin(tx, ref)
        if (wallet === undefined) throw new WalletMissingError()
        const balance = await lockedBalance(tx, wallet.id)
        // A replay is judged on the stored row's own fields, before the source is resolved: a debit that appeared later with the same usage id
        // cannot make a retry ambiguous, and a plain refund with this key is a conflict.
        const prior = await tx.query<WalletEntryRow[]>(sql`SELECT * FROM "ai_wallet_entries" WHERE "walletId" = ${wallet.id} AND "idempotencyKey" = ${entry.idempotencyKey} LIMIT 1`)
        if (prior[0] !== undefined) {
          if (walletEntryMatches(prior[0], entry, true) && (debitEntryId === undefined || debitEntryId === prior[0].refundsEntryId)) return mapWalletEntryRow(prior[0])
          throw new LedgerIdempotencyConflict(ref.tenantId, entry.idempotencyKey)
        }
        const debit = await sourceDebit(tx, wallet.id, entry, debitEntryId)
        if (debit.idempotencyKey.startsWith('hold:') || debit.idempotencyKey.startsWith('record:')) throw sourceRefusal('a debit the library wrote itself (hold: / record:) cannot be refunded to its source')
        const left = await restorableOf(tx, wallet.id, debit, entry.amountNanoUsd)
        const funded = await fundedAllocations(tx, debit.id)
        const weights = funded.map((allocation) => allocation.amountNanoUsd - allocation.restored)
        weights.push(left.available - weights.reduce((sum, weight) => sum + weight, 0n))
        const shares = splitByWeights(weights, entry.amountNanoUsd)
        const stored = await insertWalletEntry(tx, wallet.id, entry, sql`${balance + entry.amountNanoUsd}::bigint`, debit.id)
        const parts = funded.map((allocation, index) => ({ ...allocation, part: shares[index] ?? 0n })).filter((allocation) => allocation.part > 0n)
        await insertAllocations(tx, stored.id, parts.map((allocation) => ({ grantEntryId: allocation.grantEntryId, amountNanoUsd: -allocation.part })))
        await applyBalanceDelta(tx, wallet.id, entry.amountNanoUsd)
        await expireRestoredParts(tx, wallet.id, stored.id, parts, balance + entry.amountNanoUsd, now)
        return stored
      })
    } catch (error) {
      if (isLedgerIdempotencyConflict(error)) throw error
      if (isWalletMissing(error)) throw error
      throw storeError(error)
    }
  }

  async balanceAt(ref: WalletRef, asOf: Date): Promise<bigint> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) return 0n
    const rows = await awaitStatement(this.prisma.query<{ balance: bigint }[]>(balanceAtSql(wallet.id, asOf)))
    return rows[0]?.balance ?? 0n
  }

  async balanceBreakdown(ref: WalletRef, asOf: Date): Promise<WalletBalanceBreakdown> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) return { asOf, nanoUsd: 0n, unallocatedNanoUsd: 0n, buckets: [] }
    const rows = await awaitStatement(this.prisma.query<BreakdownRow[]>(balanceBreakdownSql(wallet.id, asOf, this.burnOrder)))
    const buckets = rows.filter((row) => row.kind === 'bucket').map((row) => ({
      grantEntryId: row.id ?? '',
      remainingNanoUsd: row.remaining ?? 0n,
      priority: row.priority ?? 0,
      ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
      ...(row.reason === null ? {} : { reason: row.reason }),
    }))
    const nanoUsd = rows.find((row) => row.kind === 'total')?.total ?? 0n
    return { asOf, nanoUsd, unallocatedNanoUsd: nanoUsd - buckets.reduce((sum, bucket) => sum + bucket.remainingNanoUsd, 0n), buckets }
  }

  async findDebitsBefore(query: WalletDebitQuery): Promise<WalletDebit[]> {
    const rows = await awaitStatement(this.prisma.query<WalletDebitRow[]>(walletDebitsSql(query)))
    return rows.map(mapWalletDebitRow)
  }

  async reconcile(ref: WalletRef, now?: Date): Promise<Wallet> {
    const wallet = await this.getWallet(ref)
    if (wallet === null) throw new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', undefined, { reason: 'wallet does not exist' })
    return this.prisma.transaction(async (tx) => {
      await lockWallet(tx, wallet.id)
      await activateDueGrants(tx, wallet.id, now)
      await sweepExpiredGrants(tx, wallet.id, now)
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
      await tx.execute(removeBudgetWindowsSql(key.id, key.tenantId))
      await tx.execute(removeBudgetSql(key.id, key.tenantId))
    })
  }

  async findBudgetById(key: BudgetKey): Promise<Budget | null> {
    const rows = await this.prisma.query<BudgetRow[]>(findBudgetSql(key.id, key.tenantId))
    return rows[0] === undefined ? null : mapBudgetRow(rows[0])
  }

  async findMatching(tenantId: string, scope: MeteringScope): Promise<Budget[]> {
    return (await this.prisma.query<BudgetRow[]>(matchingBudgetsSql(tenantId, scope, new Date()))).map(mapBudgetRow)
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

  findStaleReferences(query: StaleReferenceQuery): Promise<StaleReference[]> {
    return this.applications.stale(query)
  }

  pruneApplication(application: BudgetApplication, before: Date): Promise<boolean> {
    return this.applications.prune(application, before)
  }

  pruneGivenBack(before: Date, limit: number): Promise<number> {
    return this.applications.pruneGivenBack(before, limit)
  }

  pruneGivenBackExcept(before: Date, limit: number, exceptTenants: string[]): Promise<number> {
    return this.applications.pruneGivenBackExcept(before, limit, exceptTenants)
  }

  async getWindow(budgetId: string, windowStart: Date): Promise<BudgetWindowSpend | null> {
    const rows = await this.prisma.query<BudgetWindowRow[]>(windowSql(budgetId, windowStart))
    return rows[0] === undefined ? null : mapBudgetWindowRow(rows[0])
  }

  async setWindowStart(key: BudgetKey, windowStart: Date): Promise<void> {
    await this.prisma.execute(resetWindowSql(key.id, key.tenantId, windowStart))
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
