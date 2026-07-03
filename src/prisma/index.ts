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
 * (connection details are never leaked). The wallet/budget halves are not yet implemented.
 * @layer prisma
 */

import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { isLegalTransitionPatchKey } from '../shared'
import type {
  AiOperation,
  Budget,
  BudgetWindowKind,
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

/** A SQL executor — either the client or an interactive-transaction client. */
type SqlExecutor = Prisma.TransactionClient

/** One row of `ai_usage_records` as returned by `$queryRaw` (column names as-is). */
interface UsageRow {
  id: string
  tenantId: string
  scopeType: string
  scopeId: string
  beneficiaryType: string | null
  beneficiaryId: string | null
  requestedBy: string | null
  provider: string
  model: string
  requestedModel: string | null
  operation: string
  serviceTier: string
  feature: string
  tags: string[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  reasoningTokens: number
  audioInTokens: number
  audioOutTokens: number
  imageInTokens: number
  imageOutTokens: number
  totalTokens: number
  extraUnits: Record<string, number> | null
  priceVersionId: string | null
  rawCostNanoUsd: bigint
  surchargeNanoUsd: bigint
  billedCostNanoUsd: bigint
  markupMultiplier: Prisma.Decimal
  currency: string
  priceMissing: boolean
  status: string
  reversedByRecordId: string | null
  reversesRecordId: string | null
  idempotencyKey: string
  payloadHash: string
  correlationId: string | null
  requestId: string | null
  isSystemCost: boolean
  systemCostCategory: string | null
  enforced: boolean
  prevHash: string | null
  hash: string | null
  occurredAt: Date
  createdAt: Date
  updatedAt: Date
}

/** One row of `ai_model_prices` as returned by `$queryRaw`. */
interface PriceRow {
  id: string
  provider: string
  model: string
  operation: string
  serviceTier: string
  inputNanoUsdPerMillion: bigint
  outputNanoUsdPerMillion: bigint
  cacheReadNanoUsdPerMillion: bigint
  cacheWrite5mNanoUsdPerMillion: bigint
  cacheWrite1hNanoUsdPerMillion: bigint
  reasoningNanoUsdPerMillion: bigint
  audioInNanoUsdPerMillion: bigint
  audioOutNanoUsdPerMillion: bigint
  imageInNanoUsdPerMillion: bigint
  imageOutNanoUsdPerMillion: bigint
  tierThresholdTokens: number | null
  tierInputNanoUsdPerMillion: bigint | null
  tierOutputNanoUsdPerMillion: bigint | null
  unitRates: Record<string, string> | null
  currency: string
  effectiveFrom: Date
  effectiveTo: Date | null
  source: string
}

/** The ordered column list for a usage insert (identifiers are trusted constants). */
const USAGE_COLUMNS = [
  'id', 'tenantId', 'scopeType', 'scopeId', 'beneficiaryType', 'beneficiaryId', 'requestedBy',
  'provider', 'model', 'requestedModel', 'operation', 'serviceTier', 'feature', 'tags',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens',
  'reasoningTokens', 'audioInTokens', 'audioOutTokens', 'imageInTokens', 'imageOutTokens',
  'totalTokens', 'extraUnits', 'priceVersionId', 'rawCostNanoUsd', 'surchargeNanoUsd',
  'billedCostNanoUsd', 'markupMultiplier', 'currency', 'priceMissing', 'status',
  'reversedByRecordId', 'reversesRecordId', 'idempotencyKey', 'payloadHash', 'correlationId',
  'requestId', 'isSystemCost', 'systemCostCategory', 'enforced', 'prevHash', 'hash', 'occurredAt',
] as const

/** Rebuild a scope from its two columns, or `undefined` when absent. */
function scopeOf(type: string | null, id: string | null): { type: 'tenant' | 'team' | 'user' | 'key'; id: string } | undefined {
  if (type === null || id === null) return undefined
  return { type: type as 'tenant' | 'team' | 'user' | 'key', id }
}

/** Convert a `UsageRow` to the canonical {@link UsageRecord} (nulls → absent). */
function mapUsageRow(row: UsageRow): UsageRecord {
  const beneficiary = scopeOf(row.beneficiaryType, row.beneficiaryId)
  return {
    id: row.id,
    tenantId: row.tenantId,
    scope: { type: row.scopeType as 'tenant' | 'team' | 'user' | 'key', id: row.scopeId },
    ...(beneficiary !== undefined ? { beneficiary } : {}),
    ...(row.requestedBy !== null ? { requestedBy: row.requestedBy } : {}),
    provider: row.provider,
    model: row.model,
    ...(row.requestedModel !== null ? { requestedModel: row.requestedModel } : {}),
    operation: row.operation as AiOperation,
    serviceTier: row.serviceTier as ServiceTier,
    feature: row.feature,
    tags: row.tags,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWrite5mTokens: row.cacheWrite5mTokens,
    cacheWrite1hTokens: row.cacheWrite1hTokens,
    reasoningTokens: row.reasoningTokens,
    audioInTokens: row.audioInTokens,
    audioOutTokens: row.audioOutTokens,
    imageInTokens: row.imageInTokens,
    imageOutTokens: row.imageOutTokens,
    totalTokens: row.totalTokens,
    ...(row.extraUnits !== null ? { extraUnits: row.extraUnits } : {}),
    priceVersionId: row.priceVersionId,
    rawCostNanoUsd: row.rawCostNanoUsd,
    surchargeNanoUsd: row.surchargeNanoUsd,
    billedCostNanoUsd: row.billedCostNanoUsd,
    markupMultiplier: row.markupMultiplier.toNumber(),
    currency: row.currency,
    priceMissing: row.priceMissing,
    status: row.status as UsageStatus,
    ...(row.reversedByRecordId !== null ? { reversedByRecordId: row.reversedByRecordId } : {}),
    ...(row.reversesRecordId !== null ? { reversesRecordId: row.reversesRecordId } : {}),
    idempotencyKey: row.idempotencyKey,
    ...(row.correlationId !== null ? { correlationId: row.correlationId } : {}),
    ...(row.requestId !== null ? { requestId: row.requestId } : {}),
    isSystemCost: row.isSystemCost,
    ...(row.systemCostCategory !== null ? { systemCostCategory: row.systemCostCategory } : {}),
    enforced: row.enforced,
    ...(row.prevHash !== null ? { prevHash: row.prevHash } : {}),
    ...(row.hash !== null ? { hash: row.hash } : {}),
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Serialize a bigint unit-rate map to JSON of decimal strings for storage. */
function serializeUnitRates(units: Record<string, bigint>): string {
  const out: Record<string, string> = {}
  for (const [unit, rate] of Object.entries(units)) out[unit] = rate.toString()
  return JSON.stringify(out)
}

/** Parse a stored decimal-string unit-rate map back to bigint. */
function parseUnitRates(units: Record<string, string>): Record<string, bigint> {
  const out: Record<string, bigint> = {}
  for (const [unit, rate] of Object.entries(units)) out[unit] = BigInt(rate)
  return out
}

/** Convert a `PriceRow` to the canonical {@link PriceVersion}. */
function mapPriceRow(row: PriceRow): PriceVersion {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    operation: row.operation as AiOperation,
    serviceTier: row.serviceTier as ServiceTier,
    inputNanoUsdPerMillion: row.inputNanoUsdPerMillion,
    outputNanoUsdPerMillion: row.outputNanoUsdPerMillion,
    cacheReadNanoUsdPerMillion: row.cacheReadNanoUsdPerMillion,
    cacheWrite5mNanoUsdPerMillion: row.cacheWrite5mNanoUsdPerMillion,
    cacheWrite1hNanoUsdPerMillion: row.cacheWrite1hNanoUsdPerMillion,
    reasoningNanoUsdPerMillion: row.reasoningNanoUsdPerMillion,
    audioInNanoUsdPerMillion: row.audioInNanoUsdPerMillion,
    audioOutNanoUsdPerMillion: row.audioOutNanoUsdPerMillion,
    imageInNanoUsdPerMillion: row.imageInNanoUsdPerMillion,
    imageOutNanoUsdPerMillion: row.imageOutNanoUsdPerMillion,
    ...(row.tierThresholdTokens !== null ? { tierThresholdTokens: row.tierThresholdTokens } : {}),
    ...(row.tierInputNanoUsdPerMillion !== null ? { tierInputNanoUsdPerMillion: row.tierInputNanoUsdPerMillion } : {}),
    ...(row.tierOutputNanoUsdPerMillion !== null ? { tierOutputNanoUsdPerMillion: row.tierOutputNanoUsdPerMillion } : {}),
    ...(row.unitRates !== null ? { unitRates: parseUnitRates(row.unitRates) } : {}),
    currency: 'USD',
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    source: row.source,
  }
}

/** Return the first row, or raise a store error when a `RETURNING` query yielded none. */
function firstOrThrow<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {})
  return row
}

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Whether an error is a unique-constraint violation. A raw query surfaces the
 * native SQLSTATE (`23505`) under `P2010.meta.code`; a model call would surface
 * `P2002`. Both map to the exactly-once replay-or-conflict path (§15.2).
 */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code === 'P2002') return true
  const meta = error.meta as { code?: string } | undefined
  return meta?.code === PG_UNIQUE_VIOLATION
}

/** Map an unknown driver error to a domain store error (never leaks connection details). */
function storeError(error: unknown): AiTokensException {
  const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined
  return new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, code === undefined ? {} : { code })
}

/** Build the ordered value fragments for a usage insert (aligned with {@link USAGE_COLUMNS}). */
function usageValues(id: string, record: NewUsageRecord, payloadHash: string, prevHash: string | null, hash: string | null): Prisma.Sql[] {
  const extraUnits =
    record.extraUnits === undefined ? Prisma.sql`NULL` : Prisma.sql`${JSON.stringify(record.extraUnits)}::jsonb`
  return [
    Prisma.sql`${id}`, Prisma.sql`${record.tenantId}`, Prisma.sql`${record.scope.type}`, Prisma.sql`${record.scope.id}`,
    Prisma.sql`${record.beneficiary?.type ?? null}`, Prisma.sql`${record.beneficiary?.id ?? null}`,
    Prisma.sql`${record.requestedBy ?? null}`, Prisma.sql`${record.provider}`, Prisma.sql`${record.model}`,
    Prisma.sql`${record.requestedModel ?? null}`, Prisma.sql`${record.operation}`, Prisma.sql`${record.serviceTier}`,
    Prisma.sql`${record.feature}`, Prisma.sql`${record.tags}::text[]`, Prisma.sql`${record.inputTokens}`,
    Prisma.sql`${record.outputTokens}`, Prisma.sql`${record.cacheReadTokens}`, Prisma.sql`${record.cacheWrite5mTokens}`,
    Prisma.sql`${record.cacheWrite1hTokens}`, Prisma.sql`${record.reasoningTokens}`, Prisma.sql`${record.audioInTokens}`,
    Prisma.sql`${record.audioOutTokens}`, Prisma.sql`${record.imageInTokens}`, Prisma.sql`${record.imageOutTokens}`,
    Prisma.sql`${record.totalTokens}`, extraUnits, Prisma.sql`${record.priceVersionId}`,
    Prisma.sql`${record.rawCostNanoUsd}`, Prisma.sql`${record.surchargeNanoUsd}`, Prisma.sql`${record.billedCostNanoUsd}`,
    Prisma.sql`${record.markupMultiplier}`, Prisma.sql`${record.currency}`, Prisma.sql`${record.priceMissing}`,
    Prisma.sql`${record.status}`, Prisma.sql`${record.reversedByRecordId ?? null}`, Prisma.sql`${record.reversesRecordId ?? null}`,
    Prisma.sql`${record.idempotencyKey}`, Prisma.sql`${payloadHash}`, Prisma.sql`${record.correlationId ?? null}`,
    Prisma.sql`${record.requestId ?? null}`, Prisma.sql`${record.isSystemCost}`, Prisma.sql`${record.systemCostCategory ?? null}`,
    Prisma.sql`${record.enforced}`, Prisma.sql`${prevHash}`, Prisma.sql`${hash}`, Prisma.sql`${record.occurredAt}`,
  ]
}

/** The identifier list `("id", "tenantId", …)` for a usage insert (trusted constants). */
const USAGE_COLUMNS_SQL = Prisma.raw(USAGE_COLUMNS.map((column) => `"${column}"`).join(', '))

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
        await this.applyBalanceDelta(tx, wallet.id, walletBalanceDelta(entry))
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

/** The ordered column list for a price insert. */
const PRICE_COLUMNS = [
  'id', 'provider', 'model', 'operation', 'serviceTier', 'inputNanoUsdPerMillion', 'outputNanoUsdPerMillion',
  'cacheReadNanoUsdPerMillion', 'cacheWrite5mNanoUsdPerMillion', 'cacheWrite1hNanoUsdPerMillion',
  'reasoningNanoUsdPerMillion', 'audioInNanoUsdPerMillion', 'audioOutNanoUsdPerMillion', 'imageInNanoUsdPerMillion',
  'imageOutNanoUsdPerMillion', 'tierThresholdTokens', 'tierInputNanoUsdPerMillion', 'tierOutputNanoUsdPerMillion',
  'unitRates', 'currency', 'effectiveFrom', 'effectiveTo', 'source',
] as const

/** The identifier list for a price insert (trusted constants). */
const PRICE_COLUMNS_SQL = Prisma.raw(PRICE_COLUMNS.map((column) => `"${column}"`).join(', '))

/** Build the ordered value fragments for a price insert (aligned with {@link PRICE_COLUMNS}). */
function priceValues(input: NewPriceVersion, serviceTier: ServiceTier, effectiveFrom: Date): Prisma.Sql[] {
  const unitRates =
    input.unitRates === undefined ? Prisma.sql`NULL` : Prisma.sql`${serializeUnitRates(input.unitRates)}::jsonb`
  return [
    Prisma.sql`${randomUUID()}`, Prisma.sql`${input.provider}`, Prisma.sql`${input.model}`, Prisma.sql`${input.operation}`,
    Prisma.sql`${serviceTier}`, Prisma.sql`${input.inputNanoUsdPerMillion ?? 0n}`, Prisma.sql`${input.outputNanoUsdPerMillion ?? 0n}`,
    Prisma.sql`${input.cacheReadNanoUsdPerMillion ?? 0n}`, Prisma.sql`${input.cacheWrite5mNanoUsdPerMillion ?? 0n}`,
    Prisma.sql`${input.cacheWrite1hNanoUsdPerMillion ?? 0n}`, Prisma.sql`${input.reasoningNanoUsdPerMillion ?? 0n}`,
    Prisma.sql`${input.audioInNanoUsdPerMillion ?? 0n}`, Prisma.sql`${input.audioOutNanoUsdPerMillion ?? 0n}`,
    Prisma.sql`${input.imageInNanoUsdPerMillion ?? 0n}`, Prisma.sql`${input.imageOutNanoUsdPerMillion ?? 0n}`,
    Prisma.sql`${input.tierThresholdTokens ?? null}`, Prisma.sql`${input.tierInputNanoUsdPerMillion ?? null}`,
    Prisma.sql`${input.tierOutputNanoUsdPerMillion ?? null}`, unitRates, Prisma.sql`${'USD'}`,
    Prisma.sql`${effectiveFrom}`, Prisma.sql`${null}`, Prisma.sql`${input.source ?? 'snapshot'}`,
  ]
}

/**
 * Build the `SET` clause for a status transition (status + updatedAt + the
 * validated append-only patch + optional chain hashes). Every patch column is
 * checked against the shared per-transition whitelist ({@link isLegalTransitionPatchKey}),
 * the same guard the service layer runs, so the two layers can never drift. An
 * out-of-whitelist column is REJECTED with the typed conflict — never silently
 * dropped — so a caller bug can never post a settlement whose chain hash was
 * computed from a field that would not be persisted (§8.3/§8.6). Because only a
 * whitelisted (constant) column name survives the check, the raw identifier
 * interpolation stays injection-safe.
 */
function statusAssignments(
  from: UsageStatus,
  to: UsageStatus,
  patch: Partial<UsageRecord> | undefined,
  prevHash: string | null,
  hash: string | null,
): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`"status" = ${to}`, Prisma.sql`"updatedAt" = CURRENT_TIMESTAMP`]
  if (patch !== undefined) {
    for (const [key, value] of Object.entries(patch)) {
      if (!isLegalTransitionPatchKey(from, to, key)) {
        throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
          reason: `${from} → ${to} may not patch "${key}"`,
        })
      }
      parts.push(Prisma.sql`${Prisma.raw(`"${key}"`)} = ${value}`)
    }
  }
  if (hash !== null) {
    parts.push(Prisma.sql`"prevHash" = ${prevHash}`, Prisma.sql`"hash" = ${hash}`)
  }
  return Prisma.join(parts, ', ')
}

/** Build the parameterized `WHERE` clause for a ledger filter (identifiers are constants). */
function buildWhere(filter: LedgerFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`"tenantId" = ${filter.tenantId}`]
  if (filter.scope !== undefined) parts.push(Prisma.sql`"scopeType" = ${filter.scope.type} AND "scopeId" = ${filter.scope.id}`)
  if (filter.beneficiary !== undefined) {
    parts.push(Prisma.sql`"beneficiaryType" = ${filter.beneficiary.type} AND "beneficiaryId" = ${filter.beneficiary.id}`)
  }
  if (filter.feature !== undefined) parts.push(Prisma.sql`"feature" = ${filter.feature}`)
  if (filter.features !== undefined) parts.push(Prisma.sql`"feature" = ANY(${filter.features}::text[])`)
  if (filter.provider !== undefined) parts.push(Prisma.sql`"provider" = ${filter.provider}`)
  if (filter.model !== undefined) parts.push(Prisma.sql`"model" = ${filter.model}`)
  if (filter.operation !== undefined) parts.push(Prisma.sql`"operation" = ${filter.operation}`)
  if (filter.serviceTier !== undefined) parts.push(Prisma.sql`"serviceTier" = ${filter.serviceTier}`)
  if (filter.tags !== undefined) parts.push(Prisma.sql`"tags" @> ${filter.tags}::text[]`)
  if (filter.isSystemCost !== undefined) parts.push(Prisma.sql`"isSystemCost" = ${filter.isSystemCost}`)
  if (filter.systemCostCategory !== undefined) parts.push(Prisma.sql`"systemCostCategory" = ${filter.systemCostCategory}`)
  if (filter.status !== undefined) parts.push(Prisma.sql`"status" = ANY(${filter.status}::text[])`)
  if (filter.enforcedOnly === true) parts.push(Prisma.sql`"enforced" = true`)
  if (filter.from !== undefined) parts.push(Prisma.sql`"occurredAt" >= ${filter.from}`)
  if (filter.to !== undefined) parts.push(Prisma.sql`"occurredAt" <= ${filter.to}`)
  return Prisma.join(parts, ' AND ')
}

// ---------------------------------------------------------------------------
// Wallet + budget rows, mappers, and SQL helpers (§15.1–15.3).
// ---------------------------------------------------------------------------

/** One row of `ai_wallets`. */
interface WalletRow {
  id: string
  tenantId: string
  ownerType: string
  ownerId: string
  balanceNanoUsd: bigint
  createdAt: Date
  updatedAt: Date
}

/** One row of `ai_wallet_entries`. */
interface WalletEntryRow {
  id: string
  walletId: string
  type: string
  amountNanoUsd: bigint
  priority: number
  effectiveAt: Date
  expiresAt: Date | null
  usageRecordId: string | null
  idempotencyKey: string
  reason: string | null
  createdAt: Date
}

/** An open-grant row: a wallet entry plus its computed remaining value. */
interface OpenGrantRow extends WalletEntryRow {
  remaining: bigint
}

/** One row of `ai_budgets`. */
interface BudgetRow {
  id: string
  tenantId: string
  scopeType: string
  scopeId: string
  features: string[]
  limitNanoUsd: bigint | null
  limitTokens: bigint | null
  limitCount: number | null
  window: string
  anchorAt: Date | null
  expiresAt: Date | null
  softThresholds: number[]
  policy: string
  createdAt: Date
  updatedAt: Date
}

/** One row of `ai_budget_windows`. */
interface BudgetWindowRow {
  id: string
  budgetId: string
  windowStart: Date
  spentNanoUsd: bigint
  spentTokens: bigint
  spentCount: number
  updatedAt: Date
}

/** Signal that a wallet does not exist for a non-creating entry (structurally branded, §15.2). */
class WalletMissingError extends Error {
  readonly isWalletMissing = true
  constructor() {
    super('wallet does not exist')
    this.name = 'WalletMissingError'
  }
}

/** Narrow an unknown thrown value to the wallet-missing signal. */
function isWalletMissing(error: unknown): error is { isWalletMissing: true } {
  if (typeof error !== 'object' || error === null) return false
  return (error as Record<string, unknown>).isWalletMissing === true
}

/** Convert a `WalletRow` to the canonical {@link Wallet}. */
function mapWalletRow(row: WalletRow): Wallet {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerType: row.ownerType as 'tenant' | 'team' | 'user',
    ownerId: row.ownerId,
    balanceNanoUsd: row.balanceNanoUsd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Convert a `WalletEntryRow` to the canonical {@link WalletEntry} (nulls → absent). */
function mapWalletEntryRow(row: WalletEntryRow): WalletEntry {
  return {
    id: row.id,
    walletId: row.walletId,
    type: row.type as WalletEntry['type'],
    amountNanoUsd: row.amountNanoUsd,
    priority: row.priority,
    effectiveAt: row.effectiveAt,
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
    ...(row.usageRecordId !== null ? { usageRecordId: row.usageRecordId } : {}),
    idempotencyKey: row.idempotencyKey,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    createdAt: row.createdAt,
  }
}

/** Convert an `OpenGrantRow` to an {@link OpenGrant}. */
function mapOpenGrantRow(row: OpenGrantRow): OpenGrant {
  return { ...mapWalletEntryRow(row), remainingNanoUsd: row.remaining }
}

/** Whether an entry auto-creates a missing wallet (grant, or a positive adjustment). */
function walletAutoCreatable(entry: NewWalletEntry): boolean {
  return entry.type === 'grant' || (entry.type === 'adjustment' && entry.amountNanoUsd > 0n)
}

/** The materialized-balance delta for an entry (a grant counts only while spendable at insert). */
function walletBalanceDelta(entry: NewWalletEntry): bigint {
  if (entry.type !== 'grant') return entry.amountNanoUsd
  const now = new Date()
  const spendable = entry.effectiveAt <= now && (entry.expiresAt === undefined || entry.expiresAt > now)
  return spendable ? entry.amountNanoUsd : 0n
}

/** Whether a stored entry has the same content as a replayed one (replay-or-conflict, §15.2). */
function walletEntryMatches(row: WalletEntryRow, entry: NewWalletEntry): boolean {
  return (
    row.type === entry.type &&
    row.amountNanoUsd === entry.amountNanoUsd &&
    row.priority === entry.priority &&
    row.effectiveAt.getTime() === entry.effectiveAt.getTime() &&
    (row.expiresAt?.getTime() ?? null) === (entry.expiresAt?.getTime() ?? null) &&
    (row.usageRecordId ?? null) === (entry.usageRecordId ?? null) &&
    (row.reason ?? null) === (entry.reason ?? null)
  )
}

/** Build the parameterized `WHERE` clause for a wallet-entry filter. */
function walletEntryWhere(walletId: string, filter: WalletEntryFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`"walletId" = ${walletId}`]
  if (filter.type !== undefined) parts.push(Prisma.sql`"type" = ${filter.type}`)
  if (filter.from !== undefined) parts.push(Prisma.sql`"createdAt" >= ${filter.from}`)
  if (filter.to !== undefined) parts.push(Prisma.sql`"createdAt" <= ${filter.to}`)
  return Prisma.join(parts, ' AND ')
}

/** The time-aware spendable-balance expression for `reconcile` (over the outer `w` alias). */
function spendableBalanceSql(now: Date): Prisma.Sql {
  return Prisma.sql`(
    SELECT COALESCE(SUM(CASE WHEN e."type" = 'grant'
                             THEN (CASE WHEN e."effectiveAt" <= ${now} THEN e."amountNanoUsd" ELSE 0 END)
                             ELSE e."amountNanoUsd" END), 0)
    FROM "ai_wallet_entries" e WHERE e."walletId" = w."id"
  ) - (
    SELECT COALESCE(SUM(g."amountNanoUsd" - COALESCE((SELECT SUM(a."amountNanoUsd") FROM "ai_wallet_debit_allocations" a WHERE a."grantEntryId" = g."id"), 0)), 0)
    FROM "ai_wallet_entries" g
    WHERE g."walletId" = w."id" AND g."type" = 'grant' AND g."effectiveAt" <= ${now}
      AND g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${now}
  )`
}

/** Serialize a budget window kind to its stored text form. */
function serializeWindow(window: BudgetWindowKind): string {
  return typeof window === 'object' ? `custom:${window.customSeconds.toString()}` : window
}

/** Parse a stored window text back to a {@link BudgetWindowKind}. */
function parseWindow(value: string): BudgetWindowKind {
  if (value.startsWith('custom:')) return { customSeconds: Number(value.slice('custom:'.length)) }
  return value as 'day' | 'week' | 'month' | 'total'
}

/** Convert a `BudgetRow` to the canonical {@link Budget} (nulls → absent). */
function mapBudgetRow(row: BudgetRow): Budget {
  return {
    id: row.id,
    tenantId: row.tenantId,
    scope: { type: row.scopeType as MeteringScope['type'], id: row.scopeId },
    ...(row.features.length > 0 ? { features: row.features } : {}),
    ...(row.limitNanoUsd !== null ? { limitNanoUsd: row.limitNanoUsd } : {}),
    ...(row.limitTokens !== null ? { limitTokens: Number(row.limitTokens) } : {}),
    ...(row.limitCount !== null ? { limitCount: row.limitCount } : {}),
    window: parseWindow(row.window),
    ...(row.anchorAt !== null ? { anchorAt: row.anchorAt } : {}),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
    softThresholds: row.softThresholds,
    policy: row.policy as Budget['policy'],
    createdAt: row.createdAt,
  }
}

/** Convert a `BudgetWindowRow` to a {@link BudgetWindowSpend}. */
function mapBudgetWindowRow(row: BudgetWindowRow): BudgetWindowSpend {
  return { spentNanoUsd: row.spentNanoUsd, spentTokens: Number(row.spentTokens), spentCount: row.spentCount }
}

/** The ordered column list for a budget insert (identifiers are trusted constants). */
const BUDGET_COLUMNS = [
  'id', 'tenantId', 'scopeType', 'scopeId', 'features', 'limitNanoUsd', 'limitTokens', 'limitCount',
  'window', 'anchorAt', 'expiresAt', 'softThresholds', 'policy',
] as const

/** The identifier list for a budget insert. */
const BUDGET_COLUMNS_SQL = Prisma.raw(BUDGET_COLUMNS.map((column) => `"${column}"`).join(', '))

/** The nullable BigInt for a token limit (a `number` at the boundary). */
function tokenLimitSql(limit: number | undefined): bigint | null {
  return limit === undefined ? null : BigInt(limit)
}

/** Build the ordered value fragments for a budget insert (aligned with {@link BUDGET_COLUMNS}). */
function budgetValues(id: string, input: Omit<Budget, 'id' | 'createdAt'>): Prisma.Sql[] {
  return [
    Prisma.sql`${id}`, Prisma.sql`${input.tenantId}`, Prisma.sql`${input.scope.type}`, Prisma.sql`${input.scope.id}`,
    Prisma.sql`${input.features ?? []}::text[]`, Prisma.sql`${input.limitNanoUsd ?? null}`,
    Prisma.sql`${tokenLimitSql(input.limitTokens)}`, Prisma.sql`${input.limitCount ?? null}`,
    Prisma.sql`${serializeWindow(input.window)}`, Prisma.sql`${input.anchorAt ?? null}`, Prisma.sql`${input.expiresAt ?? null}`,
    Prisma.sql`${JSON.stringify(input.softThresholds)}::jsonb`, Prisma.sql`${input.policy}`,
  ]
}

/** Build the `SET` clause for an upsert conflict (every mutable column + updatedAt). */
function budgetUpdateAssignments(input: Omit<Budget, 'id' | 'createdAt'>): Prisma.Sql {
  return Prisma.join(
    [
      Prisma.sql`"scopeType" = ${input.scope.type}`, Prisma.sql`"scopeId" = ${input.scope.id}`,
      Prisma.sql`"features" = ${input.features ?? []}::text[]`, Prisma.sql`"limitNanoUsd" = ${input.limitNanoUsd ?? null}`,
      Prisma.sql`"limitTokens" = ${tokenLimitSql(input.limitTokens)}`, Prisma.sql`"limitCount" = ${input.limitCount ?? null}`,
      Prisma.sql`"window" = ${serializeWindow(input.window)}`, Prisma.sql`"anchorAt" = ${input.anchorAt ?? null}`,
      Prisma.sql`"expiresAt" = ${input.expiresAt ?? null}`, Prisma.sql`"softThresholds" = ${JSON.stringify(input.softThresholds)}::jsonb`,
      Prisma.sql`"policy" = ${input.policy}`, Prisma.sql`"updatedAt" = CURRENT_TIMESTAMP`,
    ],
    ', ',
  )
}
