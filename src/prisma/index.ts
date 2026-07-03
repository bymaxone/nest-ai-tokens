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
import type {
  AiOperation,
  LedgerFilter,
  NewPriceVersion,
  NewUsageRecord,
  PriceVersion,
  ProviderId,
  ServiceTier,
  UsageRecord,
  UsageStatus,
} from '../shared'
import type {
  IAiTokensStore,
  LedgerCostSummary,
  PricedModel,
} from '../server'
import { AiTokensException } from '../server/errors'
import { LedgerIdempotencyConflict } from '../server/services/ledger-idempotency-conflict'
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
  /**
   * @param prisma The host's Prisma client (talks to PostgreSQL).
   */
  constructor(private readonly prisma: PrismaClient) {}

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

  getWallet(): Promise<never> {
    return this.notPhase3()
  }

  appendEntry(): Promise<never> {
    return this.notPhase3()
  }

  conditionalDebit(): Promise<never> {
    return this.notPhase3()
  }

  openGrants(): Promise<never> {
    return this.notPhase3()
  }

  listEntries(): Promise<never> {
    return this.notPhase3()
  }

  reconcile(): Promise<never> {
    return this.notPhase3()
  }

  upsert(): Promise<never> {
    return this.notPhase3()
  }

  remove(): Promise<never> {
    return this.notPhase3()
  }

  findMatching(): Promise<never> {
    return this.notPhase3()
  }

  conditionalConsume(): Promise<never> {
    return this.notPhase3()
  }

  adjustWindow(): Promise<never> {
    return this.notPhase3()
  }

  getWindow(): Promise<never> {
    return this.notPhase3()
  }

  setWindowStart(): Promise<never> {
    return this.notPhase3()
  }

  /** Reject a wallet/budget call until those halves are implemented. */
  private notPhase3(): Promise<never> {
    return Promise.reject(
      new AiTokensException('AI_TOKENS_NOT_CONFIGURED', undefined, { reason: 'the wallet/budget store is not yet implemented' }),
    )
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

/** The amount/cost columns a settlement (`pending → posted`) replaces with actuals. */
const AMOUNT_COLUMNS = new Set<string>([
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'reasoningTokens',
  'audioInTokens', 'audioOutTokens', 'imageInTokens', 'imageOutTokens', 'totalTokens', 'rawCostNanoUsd',
  'surchargeNanoUsd', 'billedCostNanoUsd', 'priceVersionId', 'priceMissing', 'markupMultiplier',
])

/**
 * Whether a patch column may be set on a transition FROM `from`. Enforces
 * append-only at the store boundary (§8.3): amount/cost columns are writable ONLY
 * when settling a hold (`from = 'pending'`); the sole post-`posted` annotation is
 * `reversedByRecordId`. Raw identifiers are whitelisted, guarding against injection.
 */
function isPatchable(column: string, from: UsageStatus): boolean {
  if (column === 'reversedByRecordId') return true
  return from === 'pending' && AMOUNT_COLUMNS.has(column)
}

/** Build the `SET` clause for a status transition (status + updatedAt + append-only patch + chain). */
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
      if (isPatchable(key, from)) parts.push(Prisma.sql`${Prisma.raw(`"${key}"`)} = ${value}`)
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
