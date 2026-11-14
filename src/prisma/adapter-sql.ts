/**
 * @fileoverview Row shapes, mappers, and parameterized-SQL builders for the
 * official Prisma adapter (spec §15.1–15.3). Split out of the adapter class so
 * `index.ts` stays focused on the store methods. Every column identifier is a
 * trusted constant and every value is a bound parameter, so the raw SQL is
 * injection-safe; money is `BIGINT` nano-USD; `Decimal(10,4)` and `NUMERIC`
 * expressions convert to `number`/`bigint` at the boundary.
 * @layer prisma
 */

import { randomUUID } from 'node:crypto'
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
  ServiceTier,
  UsageRecord,
  UsageStatus,
  Wallet,
  WalletEntry,
} from '../shared'
import type { BudgetWindowSpend, OpenGrant, WalletEntryFilter } from '../server'
// By package specifier, not by relative path: entry points are separate
// bundles, so a relative import would copy the class into this one and the
// server's four `instanceof AiTokensException` guards would stop matching
// what this store throws — silently, since the copy has the same name.
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { attachCause } from '../server/errors/attach-cause'
import { identifier, identifiers, join, sql, type Sql } from './sql'
import { ACTIVATION_KEY_PREFIX, ACTIVATION_REASON } from '../server/utils/wallet-keys'

/** A decimal as the database driver returns it: all the adapter needs of it is its value as a number. */
export interface DecimalLike {
  toNumber(): number
}

/** Raw column shape returned by the parameterized usage-record queries. */
export interface UsageRow {
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
  markupMultiplier: DecimalLike
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
export interface PriceRow {
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
export const USAGE_COLUMNS = [
  'id', 'tenantId', 'scopeType', 'scopeId', 'beneficiaryType', 'beneficiaryId', 'requestedBy',
  'provider', 'model', 'requestedModel', 'operation', 'serviceTier', 'feature', 'tags',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens',
  'reasoningTokens', 'audioInTokens', 'audioOutTokens', 'imageInTokens', 'imageOutTokens',
  'totalTokens', 'extraUnits', 'priceVersionId', 'rawCostNanoUsd', 'surchargeNanoUsd',
  'billedCostNanoUsd', 'markupMultiplier', 'currency', 'priceMissing', 'status',
  'reversedByRecordId', 'reversesRecordId', 'idempotencyKey', 'payloadHash', 'correlationId',
  'requestId', 'isSystemCost', 'systemCostCategory', 'enforced', 'prevHash', 'hash', 'occurredAt',
  'createdAt', 'updatedAt',
] as const

/** Rebuild a scope from its two columns, or `undefined` when absent. */
export function scopeOf(type: string | null, id: string | null): { type: 'tenant' | 'team' | 'user' | 'key'; id: string } | undefined {
  if (type === null || id === null) return undefined
  return { type: type as 'tenant' | 'team' | 'user' | 'key', id }
}

/** Convert a `UsageRow` to the canonical {@link UsageRecord} (nulls → absent). */
export function mapUsageRow(row: UsageRow): UsageRecord {
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
export function serializeUnitRates(units: Record<string, bigint>): string {
  const out: Record<string, string> = {}
  for (const [unit, rate] of Object.entries(units)) out[unit] = rate.toString()
  return JSON.stringify(out)
}

/** Parse a stored decimal-string unit-rate map back to bigint. */
export function parseUnitRates(units: Record<string, string>): Record<string, bigint> {
  const out: Record<string, bigint> = {}
  for (const [unit, rate] of Object.entries(units)) out[unit] = BigInt(rate)
  return out
}

/** Convert a `PriceRow` to the canonical {@link PriceVersion}. */
export function mapPriceRow(row: PriceRow): PriceVersion {
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

/**
 * The advisory-lock key of one price tuple. Provider and model are free strings, so each field is
 * encoded as a JSON array element: a `|` inside either cannot move the boundary between them, and
 * two different tuples never share a key.
 */
export function priceLockKey(provider: string, model: string, operation: string, serviceTier: string): string {
  return JSON.stringify([provider, model, operation, serviceTier])
}

/** Return the first row, or raise a store error when a `RETURNING` query yielded none. */
export function firstOrThrow<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {})
  return row
}

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505'

/** The `meta` shapes a raw-query failure arrives in, across supported Prisma majors. */
interface RawQueryErrorMeta {
  /** Prisma 6 and its query engine: the native SQLSTATE, flat on `meta`. */
  readonly code?: string
  /** Prisma 7 and its driver adapters: the driver's own error, nested. */
  readonly driverAdapterError?: {
    readonly cause?: { readonly originalCode?: string; readonly kind?: string }
  }
}

/** The members of Prisma's known-request error that the adapter reads. */
interface KnownRequestErrorLike {
  readonly code: string
  readonly meta?: unknown
}

/**
 * Whether a thrown value is Prisma's known-request error. It is recognised by its name and its string code, not by
 * `instanceof`: the class lives in Prisma's runtime, which this package does not load, and a host with two copies
 * of Prisma would not match a class from either.
 */
function isKnownRequestError(error: unknown): error is KnownRequestErrorLike {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'PrismaClientKnownRequestError' && typeof candidate.code === 'string'
}

/**
 * Whether an error is a unique-constraint violation, which is the exactly-once
 * replay-or-conflict path (§15.2).
 *
 * A model call surfaces `P2002`. A raw query surfaces `P2010` carrying the native
 * SQLSTATE, and *where* it carries it depends on how the client reaches the
 * database: Prisma 6 puts it flat on `meta.code`, while a Prisma 7 driver adapter
 * nests the driver's own error under `meta.driverAdapterError.cause`. Both are
 * read, because the declared peer range spans both majors — and a missed
 * violation is silent, downgrading a 409 conflict into a generic store error.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!isKnownRequestError(error)) return false
  if (error.code === 'P2002') return true
  const meta = error.meta as RawQueryErrorMeta | undefined
  if (meta?.code === PG_UNIQUE_VIOLATION) return true
  const cause = meta?.driverAdapterError?.cause
  return cause?.originalCode === PG_UNIQUE_VIOLATION || cause?.kind === 'UniqueConstraintViolation'
}

/** Map an unknown driver error to a domain store error: the body keeps the code, the original error rides as `cause`. */
export function storeError(error: unknown): AiTokensException {
  if (error instanceof AiTokensException) return error
  const code = isKnownRequestError(error) ? error.code : undefined
  return attachCause(new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, code === undefined ? {} : { code }), error)
}

/**
 * A `catch` handler that rethrows a driver error as the domain store error ({@link storeError}), so a read that
 * fails on caller input, such as a `limit` or `offset` the database cannot read as a number, does not leak a raw
 * Prisma error.
 */
export function rethrowAsStoreError(error: unknown): never {
  throw storeError(error)
}

/** Build the ordered value fragments for a usage insert (aligned with {@link USAGE_COLUMNS}). */
export function usageValues(id: string, record: NewUsageRecord, payloadHash: string, prevHash: string | null, hash: string | null): Sql[] {
  const extraUnits =
    record.extraUnits === undefined ? sql`NULL` : sql`${JSON.stringify(record.extraUnits)}::jsonb`
  return [
    sql`${id}`, sql`${record.tenantId}`, sql`${record.scope.type}`, sql`${record.scope.id}`,
    sql`${record.beneficiary?.type ?? null}`, sql`${record.beneficiary?.id ?? null}`,
    sql`${record.requestedBy ?? null}`, sql`${record.provider}`, sql`${record.model}`,
    sql`${record.requestedModel ?? null}`, sql`${record.operation}`, sql`${record.serviceTier}`,
    sql`${record.feature}`, sql`${record.tags}::text[]`, sql`${record.inputTokens}`,
    sql`${record.outputTokens}`, sql`${record.cacheReadTokens}`, sql`${record.cacheWrite5mTokens}`,
    sql`${record.cacheWrite1hTokens}`, sql`${record.reasoningTokens}`, sql`${record.audioInTokens}`,
    sql`${record.audioOutTokens}`, sql`${record.imageInTokens}`, sql`${record.imageOutTokens}`,
    sql`${record.totalTokens}`, extraUnits, sql`${record.priceVersionId}`,
    sql`${record.rawCostNanoUsd}`, sql`${record.surchargeNanoUsd}`, sql`${record.billedCostNanoUsd}`,
    sql`${record.markupMultiplier}`, sql`${record.currency}`, sql`${record.priceMissing}`,
    sql`${record.status}`, sql`${record.reversedByRecordId ?? null}`, sql`${record.reversesRecordId ?? null}`,
    sql`${record.idempotencyKey}`, sql`${payloadHash}`, sql`${record.correlationId ?? null}`,
    sql`${record.requestId ?? null}`, sql`${record.isSystemCost}`, sql`${record.systemCostCategory ?? null}`,
    sql`${record.enforced}`, sql`${prevHash}`, sql`${hash}`, sql`${record.occurredAt}`,
    DB_NOW_SQL, DB_NOW_SQL,
  ]
}

/** The identifier list `("id", "tenantId", …)` for a usage insert (trusted constants). */
export const USAGE_COLUMNS_SQL = identifiers(USAGE_COLUMNS)
/** The ordered column list for a price insert. */
export const PRICE_COLUMNS = [
  'id', 'provider', 'model', 'operation', 'serviceTier', 'inputNanoUsdPerMillion', 'outputNanoUsdPerMillion',
  'cacheReadNanoUsdPerMillion', 'cacheWrite5mNanoUsdPerMillion', 'cacheWrite1hNanoUsdPerMillion',
  'reasoningNanoUsdPerMillion', 'audioInNanoUsdPerMillion', 'audioOutNanoUsdPerMillion', 'imageInNanoUsdPerMillion',
  'imageOutNanoUsdPerMillion', 'tierThresholdTokens', 'tierInputNanoUsdPerMillion', 'tierOutputNanoUsdPerMillion',
  'unitRates', 'currency', 'effectiveFrom', 'effectiveTo', 'source',
] as const

/** The identifier list for a price insert (trusted constants). */
export const PRICE_COLUMNS_SQL = identifiers(PRICE_COLUMNS)

/** Build the ordered value fragments for a price insert (aligned with {@link PRICE_COLUMNS}). */
export function priceValues(input: NewPriceVersion, serviceTier: ServiceTier, effectiveFrom: Date): Sql[] {
  const unitRates =
    input.unitRates === undefined ? sql`NULL` : sql`${serializeUnitRates(input.unitRates)}::jsonb`
  return [
    sql`${randomUUID()}`, sql`${input.provider}`, sql`${input.model}`, sql`${input.operation}`,
    sql`${serviceTier}`, sql`${input.inputNanoUsdPerMillion ?? 0n}`, sql`${input.outputNanoUsdPerMillion ?? 0n}`,
    sql`${input.cacheReadNanoUsdPerMillion ?? 0n}`, sql`${input.cacheWrite5mNanoUsdPerMillion ?? 0n}`,
    sql`${input.cacheWrite1hNanoUsdPerMillion ?? 0n}`, sql`${input.reasoningNanoUsdPerMillion ?? 0n}`,
    sql`${input.audioInNanoUsdPerMillion ?? 0n}`, sql`${input.audioOutNanoUsdPerMillion ?? 0n}`,
    sql`${input.imageInNanoUsdPerMillion ?? 0n}`, sql`${input.imageOutNanoUsdPerMillion ?? 0n}`,
    sql`${input.tierThresholdTokens ?? null}`, sql`${input.tierInputNanoUsdPerMillion ?? null}`,
    sql`${input.tierOutputNanoUsdPerMillion ?? null}`, unitRates, sql`${'USD'}`,
    sql`${effectiveFrom}`, sql`${null}`, sql`${input.source ?? 'snapshot'}`,
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
export function statusAssignments(
  from: UsageStatus,
  to: UsageStatus,
  patch: Partial<UsageRecord> | undefined,
  prevHash: string | null,
  hash: string | null,
): Sql {
  const parts: Sql[] = [sql`"status" = ${to}`, sql`"updatedAt" = ${DB_NOW_SQL}`]
  if (patch !== undefined) {
    for (const [key, value] of Object.entries(patch)) {
      if (!isLegalTransitionPatchKey(from, to, key)) {
        throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
          reason: `${from} → ${to} may not patch "${key}"`,
        })
      }
      parts.push(sql`${identifier(key)} = ${value}`)
    }
  }
  if (hash !== null) {
    parts.push(sql`"prevHash" = ${prevHash}`, sql`"hash" = ${hash}`)
  }
  return join(parts, ', ')
}

/** Build the parameterized `WHERE` clause for a ledger filter (identifiers are constants). */
export function buildWhere(filter: LedgerFilter): Sql {
  const parts: Sql[] = [sql`"tenantId" = ${filter.tenantId}`]
  if (filter.scope !== undefined) parts.push(sql`"scopeType" = ${filter.scope.type} AND "scopeId" = ${filter.scope.id}`)
  if (filter.beneficiary !== undefined) {
    parts.push(sql`"beneficiaryType" = ${filter.beneficiary.type} AND "beneficiaryId" = ${filter.beneficiary.id}`)
  }
  if (filter.feature !== undefined) parts.push(sql`"feature" = ${filter.feature}`)
  if (filter.features !== undefined) parts.push(sql`"feature" = ANY(${filter.features}::text[])`)
  if (filter.provider !== undefined) parts.push(sql`"provider" = ${filter.provider}`)
  if (filter.model !== undefined) parts.push(sql`"model" = ${filter.model}`)
  if (filter.operation !== undefined) parts.push(sql`"operation" = ${filter.operation}`)
  if (filter.serviceTier !== undefined) parts.push(sql`"serviceTier" = ${filter.serviceTier}`)
  if (filter.tags !== undefined) parts.push(sql`"tags" @> ${filter.tags}::text[]`)
  if (filter.isSystemCost !== undefined) parts.push(sql`"isSystemCost" = ${filter.isSystemCost}`)
  if (filter.systemCostCategory !== undefined) parts.push(sql`"systemCostCategory" = ${filter.systemCostCategory}`)
  if (filter.status !== undefined) parts.push(sql`"status" = ANY(${filter.status}::text[])`)
  if (filter.enforcedOnly === true) parts.push(sql`"enforced" = true`)
  if (filter.from !== undefined) parts.push(sql`"occurredAt" >= ${filter.from}`)
  if (filter.to !== undefined) parts.push(sql`"occurredAt" <= ${filter.to}`)
  return join(parts, ' AND ')
}

// ---------------------------------------------------------------------------
// Wallet + budget rows, mappers, and SQL helpers (§15.1–15.3).
// ---------------------------------------------------------------------------

/** One row of `ai_wallets`. */
export interface WalletRow {
  id: string
  tenantId: string
  ownerType: string
  ownerId: string
  balanceNanoUsd: bigint
  createdAt: Date
  updatedAt: Date
}

/** One row of `ai_wallet_entries`. */
export interface WalletEntryRow {
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
export interface OpenGrantRow extends WalletEntryRow {
  remaining: bigint
}

/** One row of `ai_budgets`. */
export interface BudgetRow {
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
export interface BudgetWindowRow {
  id: string
  budgetId: string
  windowStart: Date
  spentNanoUsd: bigint
  spentTokens: bigint
  spentCount: number
  updatedAt: Date
}

/** Signal that a wallet does not exist for a non-creating entry (structurally branded, §15.2). */
export class WalletMissingError extends Error {
  readonly isWalletMissing = true
  constructor() {
    super('wallet does not exist')
    this.name = 'WalletMissingError'
  }
}

/** Narrow an unknown thrown value to the wallet-missing signal. */
export function isWalletMissing(error: unknown): error is { isWalletMissing: true } {
  if (typeof error !== 'object' || error === null) return false
  return (error as Record<string, unknown>).isWalletMissing === true
}

/** Convert a `WalletRow` to the canonical {@link Wallet}. */
export function mapWalletRow(row: WalletRow): Wallet {
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
export function mapWalletEntryRow(row: WalletEntryRow): WalletEntry {
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
export function mapOpenGrantRow(row: OpenGrantRow): OpenGrant {
  return { ...mapWalletEntryRow(row), remainingNanoUsd: row.remaining }
}

/** Whether an entry auto-creates a missing wallet (grant, or a positive adjustment). */
export function walletAutoCreatable(entry: NewWalletEntry): boolean {
  return entry.type === 'grant' || (entry.type === 'adjustment' && entry.amountNanoUsd > 0n)
}

/**
 * The materialized-balance delta for a STORED entry. A grant contributes only if it was due as
 * it was appended: judged on the row's persisted `createdAt` (written on the UTC clock), never on an
 * application-clock read that depends on clock skew. A grant that was not due then is credited
 * later by the `activate:<grantId>` entry that `activateDueGrants` writes, which carries the
 * amount itself; every other entry contributes its signed amount.
 */
export function walletBalanceDelta(entry: WalletEntry): bigint {
  if (entry.type !== 'grant') return entry.amountNanoUsd
  const spendable = entry.effectiveAt <= entry.createdAt && (entry.expiresAt === undefined || entry.expiresAt > entry.createdAt)
  return spendable ? entry.amountNanoUsd : 0n
}

/**
 * Whether a stored entry has the same content as a replayed one (replay-or-conflict,
 * §15.2). Compares only the stable business payload — type, amount, priority, expiry,
 * usage link, and reason. `effectiveAt` is EXCLUDED because the service defaults it to
 * the wall clock at call time, so a retry that omits it would otherwise mismatch and
 * spuriously conflict; this mirrors the ledger payload hash, which excludes generated
 * timestamps. Both wallet stores use this same field set so their replay semantics agree.
 */
export function walletEntryMatches(row: WalletEntryRow, entry: NewWalletEntry): boolean {
  return (
    row.type === entry.type &&
    row.amountNanoUsd === entry.amountNanoUsd &&
    row.priority === entry.priority &&
    (row.expiresAt?.getTime() ?? null) === (entry.expiresAt?.getTime() ?? null) &&
    (row.usageRecordId ?? null) === (entry.usageRecordId ?? null) &&
    (row.reason ?? null) === (entry.reason ?? null)
  )
}

/** Build the parameterized `WHERE` clause for a wallet-entry filter. */
export function walletEntryWhere(walletId: string, filter: WalletEntryFilter): Sql {
  const parts: Sql[] = [sql`"walletId" = ${walletId}`]
  if (filter.type !== undefined) parts.push(sql`"type" = ${filter.type}`)
  if (filter.from !== undefined) parts.push(sql`"createdAt" >= ${filter.from}`)
  if (filter.to !== undefined) parts.push(sql`"createdAt" <= ${filter.to}`)
  return join(parts, ' AND ')
}

/**
 * The database clock as a UTC wall-clock timestamp, the fallback when the caller gives no instant. The entry
 * timestamps are `TIMESTAMP` columns without a zone: the application writes `effectiveAt` and `expiresAt` as UTC
 * instants, so a clock they are compared with must be UTC too whatever zone the database session uses. The wallet entries'
 * `createdAt`, which orders them, and the usage records' `createdAt` and `updatedAt` are written with it as well: the hold reaper compares `createdAt`
 * with an application instant.
 */
export const DB_NOW_SQL = sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`

/**
 * The instant a wallet statement judges a grant's `effectiveAt` and `expiresAt` on: the caller's `now` as a bound
 * parameter, so the dates and the comparison share the application's clock, or the database clock when none is given.
 */
export function clockSql(now: Date | undefined): Sql {
  return now === undefined ? DB_NOW_SQL : sql`${now}`
}

/** Whether the grant aliased `g` was due as it was appended (judged on its stored `createdAt`). */
export const DUE_AT_APPEND_SQL = sql`(g."effectiveAt" <= g."createdAt" AND (g."expiresAt" IS NULL OR g."expiresAt" > g."createdAt"))`

/** Whether an `activate:<grantId>` entry has credited the grant aliased `g`. */
export const ACTIVATED_SQL = sql`EXISTS (SELECT 1 FROM "ai_wallet_entries" m WHERE m."walletId" = g."walletId" AND m."idempotencyKey" = ${ACTIVATION_KEY_PREFIX} || g."id" AND m."type" = 'adjustment' AND m."reason" = ${ACTIVATION_REASON} AND m."amountNanoUsd" = g."amountNanoUsd")`

/** Whether the grant aliased `g` is part of the materialized balance: due at append, or activated since. */
export const CREDITED_SQL = sql`(${DUE_AT_APPEND_SQL} OR ${ACTIVATED_SQL})`

/** The unspent remainder of the grant aliased `g`, computed per grant. Used where only a few grants are asked about. */
export const GRANT_REMAINING_SQL = sql`(g."amountNanoUsd" - COALESCE((SELECT SUM(a."amountNanoUsd") FROM "ai_wallet_debit_allocations" a WHERE a."grantEntryId" = g."id"), 0))`

/**
 * Joins, for the grant aliased `g`, its unspent remainder as `r."remaining"`: the grant's amount less the sum of
 * its own allocations, computed once per grant by an index lookup on `allocations(grantEntryId)`. Because it is a
 * lateral aggregate keyed by the grant, it never groups the allocations: a grouped subquery joined on
 * the grant lets the planner choose a join order from a row estimate that goes stale as a wallet grows.
 */
export const GRANT_REMAINING_JOIN_SQL = sql`LEFT JOIN LATERAL (
    SELECT g."amountNanoUsd" - COALESCE(SUM(a."amountNanoUsd"), 0) AS "remaining"
    FROM "ai_wallet_debit_allocations" a WHERE a."grantEntryId" = g."id"
  ) r ON TRUE`

/** The unspent remainder of the grant aliased `g`, read from the {@link GRANT_REMAINING_JOIN_SQL} row `r`. */
export const GRANT_REMAINING_JOINED_SQL = sql`r."remaining"`

/**
 * The signed sum of a wallet's entries (over the outer `w` alias): every entry counts in full except a
 * grant, which counts only if it was due as it was appended; a grant credited later is counted by its
 * activation entry. This is what the materialized balance equals before any grant has expired.
 */
export const SIGNED_BALANCE_SQL = sql`(
  SELECT COALESCE(SUM(g."amountNanoUsd"), 0)
  FROM "ai_wallet_entries" g WHERE g."walletId" = w."id" AND (g."type" <> 'grant' OR ${DUE_AT_APPEND_SQL})
)`

/**
 * The spendable-balance expression for `reconcile` (over the outer `w` alias): the signed sum of the
 * entries minus the unspent remainder of any credited grant that has expired at `now`, like the debit path.
 */
export function spendableBalanceSql(now?: Date): Sql {
  return sql`${SIGNED_BALANCE_SQL} - (
    SELECT COALESCE(SUM(${GRANT_REMAINING_JOINED_SQL}), 0)
    FROM "ai_wallet_entries" g ${GRANT_REMAINING_JOIN_SQL}
    WHERE g."walletId" = w."id" AND g."type" = 'grant' AND ${CREDITED_SQL}
      AND g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${clockSql(now)}
  )`
}

/**
 * The unspent remainder of a wallet's credited grants that are not effective yet at `now`. The materialized
 * balance already counts them, because a grant is credited at append on the store's clock, so a debit must not
 * be funded by them: the open-grants query leaves them out, and a debit they funded would carry no allocation.
 */
export function pendingGrantsSql(walletId: string, now?: Date): Sql {
  return sql`(
    SELECT COALESCE(SUM(${GRANT_REMAINING_JOINED_SQL}), 0)
    FROM "ai_wallet_entries" g ${GRANT_REMAINING_JOIN_SQL}
    WHERE g."walletId" = ${walletId} AND g."type" = 'grant' AND ${CREDITED_SQL}
      AND g."effectiveAt" > ${clockSql(now)} AND (g."expiresAt" IS NULL OR g."expiresAt" > ${clockSql(now)})
  )`
}

/** Serialize a budget window kind to its stored text form. */
export function serializeWindow(window: BudgetWindowKind): string {
  return typeof window === 'object' ? `custom:${window.customSeconds.toString()}` : window
}

/** Parse a stored window text back to a {@link BudgetWindowKind}. */
export function parseWindow(value: string): BudgetWindowKind {
  if (value.startsWith('custom:')) return { customSeconds: Number(value.slice('custom:'.length)) }
  return value as 'day' | 'week' | 'month' | 'total'
}

/** Convert a `BudgetRow` to the canonical {@link Budget} (nulls → absent). */
export function mapBudgetRow(row: BudgetRow): Budget {
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
export function mapBudgetWindowRow(row: BudgetWindowRow): BudgetWindowSpend {
  return { spentNanoUsd: row.spentNanoUsd, spentTokens: Number(row.spentTokens), spentCount: row.spentCount }
}

/** The ordered column list for a budget insert (identifiers are trusted constants). */
export const BUDGET_COLUMNS = [
  'id', 'tenantId', 'scopeType', 'scopeId', 'features', 'limitNanoUsd', 'limitTokens', 'limitCount',
  'window', 'anchorAt', 'expiresAt', 'softThresholds', 'policy', 'createdAt', 'updatedAt',
] as const

/** The identifier list for a budget insert. */
export const BUDGET_COLUMNS_SQL = identifiers(BUDGET_COLUMNS)

/** The nullable BigInt for a token limit (a `number` at the boundary). */
export function tokenLimitSql(limit: number | undefined): bigint | null {
  return limit === undefined ? null : BigInt(limit)
}

/** Build the ordered value fragments for a budget insert (aligned with {@link BUDGET_COLUMNS}). */
export function budgetValues(id: string, input: Omit<Budget, 'id' | 'createdAt'> & { createdAt?: Date }): Sql[] {
  return [
    sql`${id}`, sql`${input.tenantId}`, sql`${input.scope.type}`, sql`${input.scope.id}`,
    sql`${input.features ?? []}::text[]`, sql`${input.limitNanoUsd ?? null}`,
    sql`${tokenLimitSql(input.limitTokens)}`, sql`${input.limitCount ?? null}`,
    sql`${serializeWindow(input.window)}`, sql`${input.anchorAt ?? null}`, sql`${input.expiresAt ?? null}`,
    sql`${JSON.stringify(input.softThresholds)}::jsonb`, sql`${input.policy}`,
    input.createdAt === undefined ? DB_NOW_SQL : sql`${input.createdAt}`, DB_NOW_SQL,
  ]
}

/** Build the `SET` clause for an upsert conflict (every mutable column + updatedAt). */
export function budgetUpdateAssignments(input: Omit<Budget, 'id' | 'createdAt'>): Sql {
  return join(
    [
      sql`"scopeType" = ${input.scope.type}`, sql`"scopeId" = ${input.scope.id}`,
      sql`"features" = ${input.features ?? []}::text[]`, sql`"limitNanoUsd" = ${input.limitNanoUsd ?? null}`,
      sql`"limitTokens" = ${tokenLimitSql(input.limitTokens)}`, sql`"limitCount" = ${input.limitCount ?? null}`,
      sql`"window" = ${serializeWindow(input.window)}`, sql`"anchorAt" = ${input.anchorAt ?? null}`,
      sql`"expiresAt" = ${input.expiresAt ?? null}`, sql`"softThresholds" = ${JSON.stringify(input.softThresholds)}::jsonb`,
      sql`"policy" = ${input.policy}`, sql`"updatedAt" = ${DB_NOW_SQL}`,
    ],
    ', ',
  )
}
