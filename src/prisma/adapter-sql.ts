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
import { Prisma } from '@prisma/client'
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
import { AiTokensException } from '../server/errors'

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

/** Return the first row, or raise a store error when a `RETURNING` query yielded none. */
export function firstOrThrow<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {})
  return row
}

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505'

/**
 * Whether an error is a unique-constraint violation. A raw query surfaces the
 * native SQLSTATE (`23505`) under `P2010.meta.code`; a model call would surface
 * `P2002`. Both map to the exactly-once replay-or-conflict path (§15.2).
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code === 'P2002') return true
  const meta = error.meta as { code?: string } | undefined
  return meta?.code === PG_UNIQUE_VIOLATION
}

/** Map an unknown driver error to a domain store error (never leaks connection details). */
export function storeError(error: unknown): AiTokensException {
  const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined
  return new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, code === undefined ? {} : { code })
}

/** Build the ordered value fragments for a usage insert (aligned with {@link USAGE_COLUMNS}). */
export function usageValues(id: string, record: NewUsageRecord, payloadHash: string, prevHash: string | null, hash: string | null): Prisma.Sql[] {
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
export const USAGE_COLUMNS_SQL = Prisma.raw(USAGE_COLUMNS.map((column) => `"${column}"`).join(', '))
/** The ordered column list for a price insert. */
export const PRICE_COLUMNS = [
  'id', 'provider', 'model', 'operation', 'serviceTier', 'inputNanoUsdPerMillion', 'outputNanoUsdPerMillion',
  'cacheReadNanoUsdPerMillion', 'cacheWrite5mNanoUsdPerMillion', 'cacheWrite1hNanoUsdPerMillion',
  'reasoningNanoUsdPerMillion', 'audioInNanoUsdPerMillion', 'audioOutNanoUsdPerMillion', 'imageInNanoUsdPerMillion',
  'imageOutNanoUsdPerMillion', 'tierThresholdTokens', 'tierInputNanoUsdPerMillion', 'tierOutputNanoUsdPerMillion',
  'unitRates', 'currency', 'effectiveFrom', 'effectiveTo', 'source',
] as const

/** The identifier list for a price insert (trusted constants). */
export const PRICE_COLUMNS_SQL = Prisma.raw(PRICE_COLUMNS.map((column) => `"${column}"`).join(', '))

/** Build the ordered value fragments for a price insert (aligned with {@link PRICE_COLUMNS}). */
export function priceValues(input: NewPriceVersion, serviceTier: ServiceTier, effectiveFrom: Date): Prisma.Sql[] {
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
export function statusAssignments(
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
export function buildWhere(filter: LedgerFilter): Prisma.Sql {
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
 * The materialized-balance delta for a STORED entry. A grant contributes only while it
 * is spendable at its PERSISTED append instant — the row's `createdAt` (`CURRENT_TIMESTAMP`),
 * never a fresh application-clock read that would depend on clock skew and could miscount
 * grants around their `effectiveAt`/`expiresAt` boundaries. This mirrors the append-instant
 * rule `sweepExpiredGrants` applies (it compares `effectiveAt`/`expiresAt` against the
 * grant's `createdAt`), so the balance stays anchored to the persisted instant.
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
export function walletEntryWhere(walletId: string, filter: WalletEntryFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`"walletId" = ${walletId}`]
  if (filter.type !== undefined) parts.push(Prisma.sql`"type" = ${filter.type}`)
  if (filter.from !== undefined) parts.push(Prisma.sql`"createdAt" >= ${filter.from}`)
  if (filter.to !== undefined) parts.push(Prisma.sql`"createdAt" <= ${filter.to}`)
  return Prisma.join(parts, ' AND ')
}

/** The time-aware spendable-balance expression for `reconcile` (over the outer `w` alias). */
export function spendableBalanceSql(now: Date): Prisma.Sql {
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
  'window', 'anchorAt', 'expiresAt', 'softThresholds', 'policy',
] as const

/** The identifier list for a budget insert. */
export const BUDGET_COLUMNS_SQL = Prisma.raw(BUDGET_COLUMNS.map((column) => `"${column}"`).join(', '))

/** The nullable BigInt for a token limit (a `number` at the boundary). */
export function tokenLimitSql(limit: number | undefined): bigint | null {
  return limit === undefined ? null : BigInt(limit)
}

/** Build the ordered value fragments for a budget insert (aligned with {@link BUDGET_COLUMNS}). */
export function budgetValues(id: string, input: Omit<Budget, 'id' | 'createdAt'>): Prisma.Sql[] {
  return [
    Prisma.sql`${id}`, Prisma.sql`${input.tenantId}`, Prisma.sql`${input.scope.type}`, Prisma.sql`${input.scope.id}`,
    Prisma.sql`${input.features ?? []}::text[]`, Prisma.sql`${input.limitNanoUsd ?? null}`,
    Prisma.sql`${tokenLimitSql(input.limitTokens)}`, Prisma.sql`${input.limitCount ?? null}`,
    Prisma.sql`${serializeWindow(input.window)}`, Prisma.sql`${input.anchorAt ?? null}`, Prisma.sql`${input.expiresAt ?? null}`,
    Prisma.sql`${JSON.stringify(input.softThresholds)}::jsonb`, Prisma.sql`${input.policy}`,
  ]
}

/** Build the `SET` clause for an upsert conflict (every mutable column + updatedAt). */
export function budgetUpdateAssignments(input: Omit<Budget, 'id' | 'createdAt'>): Prisma.Sql {
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

