/**
 * @fileoverview `UsageReportService` — real aggregation over the typed ledger
 * (spec §13). `summarize()` groups `SUM`s across the twelve report dimensions
 * (delegating to the store's optional SQL `summarize`, else a documented
 * in-memory fallback capped at `reporting.maxExportRows`) and computes the
 * cache-savings figure per group from each record's effective price. `export()`
 * streams the full §13.2 field set as CSV or line-delimited JSON with every bigint
 * rendered as a decimal string (§15.5) and, for a non-USD presentation currency,
 * additional `fx`-converted columns (§7.4, presentation-only). Every export emits
 * an `ai_tokens.audit` event — it is an ADMIN-PLANE surface the host MUST restrict
 * to privileged roles (§14.4). No prompt/completion text is ever read or emitted.
 * @layer server
 */

import { Injectable } from '@nestjs/common'
import { Readable } from 'node:stream'
import type { LedgerFilter, ProviderId, ReportFilter, TokenCategory, UsageRecord, UsageSummary } from '../../shared'
import { TOKEN_CATEGORIES } from '../../shared'
import { AiTokensException } from '../errors'
import type { ILedgerStore, IPricingStore, ReportGroupBy } from '../interfaces'

/** The resolved-options subset the report service consumes. */
export interface UsageReportOptions {
  currency: string
  fx?: ((date: Date, currency: string) => Promise<bigint> | bigint) | undefined
  reporting: { maxExportRows: number }
}

/** The `summarize()` input: a report filter plus the group-by dimensions. */
export type SummarizeInput = ReportFilter & { groupBy: ReportGroupBy[] }

/** The export serialization format. */
export type ReportExportFormat = 'csv' | 'json'

/** The audit hook the module wires to the event dispatcher (default no-op). */
export type ReportAuditHook = (action: string, details: Record<string, unknown>) => void

/** The default statuses summed into a report (settled records). */
const BALANCE_STATUSES = ['posted', 'reversed'] as const
/** Nano-USD-per-million divisor for a per-token rate. */
const PER_MILLION = 1_000_000n
/** Nano-USD per USD (fx returns nano-units of the presentation currency PER USD). */
const NANO_PER_USD = 1_000_000_000n

@Injectable()
export class UsageReportService {
  /**
   * @param store The ledger store port (query + optional SQL summarize).
   * @param pricing The pricing store port (effective rate for cache savings).
   * @param options The resolved currency/fx/reporting settings.
   * @param audit The audit hook; the module wires it to the dispatcher.
   */
  constructor(
    private readonly store: ILedgerStore,
    private readonly pricing: IPricingStore,
    private readonly options: UsageReportOptions,
    private readonly audit: ReportAuditHook = (): void => undefined,
  ) {}

  /**
   * Aggregate `SUM … GROUP BY` across the report dimensions. Delegates to the
   * store's SQL `summarize` when present, else aggregates in memory. The in-memory
   * fallback REFUSES to emit partial totals: like `export()` it throws when the
   * filter matches more than `reporting.maxExportRows` rows (paginate instead) — a
   * silent truncation would hand callers incorrect aggregates. An empty `groupBy`
   * yields one grand-total row.
   *
   * @param input The report filter plus the group-by dimensions.
   * @returns One {@link UsageSummary} per group.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the matched rows exceed `reporting.maxExportRows`.
   */
  async summarize(input: SummarizeInput): Promise<UsageSummary[]> {
    const { groupBy, ...filter } = input
    const max = this.options.reporting.maxExportRows
    if (this.store.summarize !== undefined) return this.store.summarize(toLedgerFilter(filter, max), groupBy)
    const records = await this.store.query(toLedgerFilter(filter, max + 1))
    this.assertWithinMaxRows(records.length, 'summarize')
    const groups = new Map<string, UsageSummary>()
    for (const record of records) {
      const savings = await this.cacheSavings(record)
      for (const group of expandGroups(record, groupBy)) {
        const key = JSON.stringify(group)
        const summary = groups.get(key) ?? emptySummary(group)
        accumulate(summary, record, savings)
        groups.set(key, summary)
      }
    }
    return [...groups.values()]
  }

  /**
   * Stream the §13.2 export field set as CSV or line-delimited JSON, bigints as
   * decimal strings, plus fx-converted columns for a non-USD currency. Emits an
   * `ai_tokens.audit` event. ADMIN PLANE (§14.4): restrict to privileged roles.
   *
   * @param filter The report filter.
   * @param format `'csv'` or `'json'` (ndjson).
   * @returns A readable stream of the export.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the result exceeds `reporting.maxExportRows`.
   */
  async export(filter: ReportFilter, format: ReportExportFormat): Promise<Readable> {
    const max = this.options.reporting.maxExportRows
    const records = await this.store.query(toLedgerFilter(filter, max + 1))
    this.assertWithinMaxRows(records.length, 'export')
    this.audit('ai_tokens.audit', { action: 'export', tenantId: filter.tenantId, format, rows: records.length })
    return Readable.from(this.serialize(records, format))
  }

  /**
   * Refuse a partial result: throw when a `maxExportRows + 1`-bounded query matched
   * more rows than `reporting.maxExportRows`, signaling the caller to paginate. Both
   * `summarize()` and `export()` share this guard so neither ever silently truncates.
   *
   * @param rowCount The number of rows the `(max + 1)`-bounded query returned.
   * @param operation The operation name for the error reason (`summarize`/`export`).
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when `rowCount` exceeds the limit.
   */
  private assertWithinMaxRows(rowCount: number, operation: string): void {
    const max = this.options.reporting.maxExportRows
    if (rowCount > max) {
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: `${operation} exceeds reporting.maxExportRows (${String(max)}); paginate the filter` })
    }
  }

  /** Yield the serialized rows (CSV header + rows, or ndjson lines). */
  private async *serialize(records: UsageRecord[], format: ReportExportFormat): AsyncGenerator<string> {
    const converting = this.options.currency !== 'USD' && this.options.fx !== undefined
    if (format === 'csv') yield `${csvLine(this.headers(converting))}\n`
    for (const record of records) {
      const row = await this.rowOf(record, converting)
      yield format === 'csv' ? `${csvLine(row.map((cell) => cell[1]))}\n` : `${JSON.stringify(Object.fromEntries(row))}\n`
    }
  }

  /** The ordered header names for the export (with fx columns when converting). */
  private headers(converting: boolean): string[] {
    const base = baseCells(exampleRecord).map((cell) => cell[0])
    return converting ? [...base, 'presentationCurrency', 'rawCostConverted', 'surchargeConverted', 'billedCostConverted'] : base
  }

  /** Build one export row as ordered `[header, cell]` pairs (all cells strings). */
  private async rowOf(record: UsageRecord, converting: boolean): Promise<[string, string][]> {
    const cells = baseCells(record)
    if (!converting || this.options.fx === undefined) return cells
    const rate = await this.options.fx(record.occurredAt, this.options.currency)
    return [
      ...cells,
      ['presentationCurrency', this.options.currency],
      ['rawCostConverted', convert(record.rawCostNanoUsd, rate).toString()],
      ['surchargeConverted', convert(record.surchargeNanoUsd, rate).toString()],
      ['billedCostConverted', convert(record.billedCostNanoUsd, rate).toString()],
    ]
  }

  /** The nano-USD cache savings for a record: `cacheReadTokens × (inputRate − cacheReadRate)`. */
  private async cacheSavings(record: UsageRecord): Promise<bigint> {
    if (record.priceVersionId === null) return 0n
    const rate = await this.pricing.resolveRate(record.provider, record.model, record.operation, record.serviceTier, record.occurredAt)
    if (rate === null) return 0n
    return (BigInt(record.cacheReadTokens) * (rate.inputNanoUsdPerMillion - rate.cacheReadNanoUsdPerMillion)) / PER_MILLION
  }
}

/** Map a {@link ReportFilter} to a {@link LedgerFilter}, defaulting the settled statuses. */
function toLedgerFilter(filter: ReportFilter, limit: number): LedgerFilter {
  return {
    tenantId: filter.tenantId,
    ...(filter.scope !== undefined ? { scope: filter.scope } : {}),
    ...(filter.beneficiary !== undefined ? { beneficiary: filter.beneficiary } : {}),
    ...(filter.feature !== undefined ? { feature: filter.feature } : {}),
    ...(filter.features !== undefined ? { features: filter.features } : {}),
    ...(filter.provider !== undefined ? { provider: filter.provider } : {}),
    ...(filter.model !== undefined ? { model: filter.model } : {}),
    ...(filter.operation !== undefined ? { operation: filter.operation } : {}),
    ...(filter.serviceTier !== undefined ? { serviceTier: filter.serviceTier } : {}),
    ...(filter.tags !== undefined ? { tags: filter.tags } : {}),
    ...(filter.isSystemCost !== undefined ? { isSystemCost: filter.isSystemCost } : {}),
    ...(filter.systemCostCategory !== undefined ? { systemCostCategory: filter.systemCostCategory } : {}),
    ...(filter.enforcedOnly !== undefined ? { enforcedOnly: filter.enforcedOnly } : {}),
    status: filter.status ?? [...BALANCE_STATUSES],
    from: filter.from,
    to: filter.to,
    limit,
  }
}

/** Expand a record into its group rows (tag grouping unnests the record's tags). */
function expandGroups(record: UsageRecord, groupBy: ReportGroupBy[]): Record<string, string>[] {
  const base: Record<string, string> = {}
  for (const dim of groupBy) {
    if (dim !== 'tag') base[dim] = dimensionValue(record, dim)
  }
  if (!groupBy.includes('tag')) return [base]
  return record.tags.map((tag) => ({ ...base, tag }))
}

/** The group value for one non-tag dimension. */
function dimensionValue(record: UsageRecord, dim: Exclude<ReportGroupBy, 'tag'>): string {
  switch (dim) {
    case 'day':
      return record.occurredAt.toISOString().slice(0, 10)
    case 'week':
      return weekStartUtc(record.occurredAt)
    case 'month':
      return record.occurredAt.toISOString().slice(0, 7)
    case 'feature':
      return record.feature
    case 'provider':
      return record.provider
    case 'model':
      return record.model
    case 'operation':
      return record.operation
    case 'serviceTier':
      return record.serviceTier
    case 'scope':
      return `${record.scope.type}:${record.scope.id}`
    case 'beneficiary':
      return record.beneficiary === undefined ? '' : `${record.beneficiary.type}:${record.beneficiary.id}`
    default:
      return record.systemCostCategory ?? ''
  }
}

/** The Monday-anchored UTC week start (`YYYY-MM-DD`). */
function weekStartUtc(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const isoDay = (utc.getUTCDay() + 6) % 7 // Monday = 0
  utc.setUTCDate(utc.getUTCDate() - isoDay)
  return utc.toISOString().slice(0, 10)
}

/** A zeroed {@link UsageSummary} for a group. */
function emptySummary(group: Record<string, string>): UsageSummary {
  const tokens = Object.fromEntries(TOKEN_CATEGORIES.map((category) => [category, 0])) as Record<TokenCategory, number>
  return { group, records: 0, totalTokens: 0, tokens, rawCostNanoUsd: 0n, surchargeNanoUsd: 0n, billedCostNanoUsd: 0n, cacheSavingsNanoUsd: 0n }
}

/** Add one record's amounts into a group summary. */
function accumulate(summary: UsageSummary, record: UsageRecord, savings: bigint): void {
  summary.records += 1
  summary.totalTokens += record.totalTokens
  for (const category of TOKEN_CATEGORIES) summary.tokens[category] += record[`${category}Tokens`]
  summary.rawCostNanoUsd += record.rawCostNanoUsd
  summary.surchargeNanoUsd += record.surchargeNanoUsd
  summary.billedCostNanoUsd += record.billedCostNanoUsd
  summary.cacheSavingsNanoUsd += savings
}

/** Convert a nano-USD amount to nano-units of the presentation currency. */
function convert(nanoUsd: bigint, fxRate: bigint): bigint {
  return (nanoUsd * fxRate) / NANO_PER_USD
}

/** Render a CSV line, quoting cells that contain a comma, quote, or newline. */
function csvLine(cells: string[]): string {
  return cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')
}

/** The ordered `[header, cell]` pairs for the §13.2 export field set. */
function baseCells(record: UsageRecord): [string, string][] {
  return [
    ['tenantId', record.tenantId],
    ['scopeType', record.scope.type],
    ['scopeId', record.scope.id],
    ['beneficiaryType', record.beneficiary?.type ?? ''],
    ['beneficiaryId', record.beneficiary?.id ?? ''],
    ['requestedBy', record.requestedBy ?? ''],
    ['feature', record.feature],
    ['tags', record.tags.join(';')],
    ['provider', record.provider],
    ['model', record.model],
    ['requestedModel', record.requestedModel ?? ''],
    ['operation', record.operation],
    ['serviceTier', record.serviceTier],
    ...TOKEN_CATEGORIES.map((category): [string, string] => [`${category}Tokens`, String(record[`${category}Tokens`])]),
    ['totalTokens', String(record.totalTokens)],
    ['extraUnits', record.extraUnits === undefined ? '' : JSON.stringify(record.extraUnits)],
    ['rawCostNanoUsd', record.rawCostNanoUsd.toString()],
    ['surchargeNanoUsd', record.surchargeNanoUsd.toString()],
    ['billedCostNanoUsd', record.billedCostNanoUsd.toString()],
    ['markupMultiplier', String(record.markupMultiplier)],
    ['currency', record.currency],
    ['priceMissing', String(record.priceMissing)],
    ['occurredAt', record.occurredAt.toISOString()],
    ['idempotencyKey', record.idempotencyKey],
    ['correlationId', record.correlationId ?? ''],
    ['requestId', record.requestId ?? ''],
    ['isSystemCost', String(record.isSystemCost)],
    ['systemCostCategory', record.systemCostCategory ?? ''],
    ['enforced', String(record.enforced)],
    ['status', record.status],
  ]
}

/** A minimal record used only to derive the export header order. */
const exampleRecord = {
  id: '',
  tenantId: '',
  scope: { type: 'tenant' as const, id: '' },
  provider: '' as ProviderId,
  model: '',
  operation: 'chat' as const,
  serviceTier: 'standard' as const,
  feature: '',
  tags: [] as string[],
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningTokens: 0,
  audioInTokens: 0,
  audioOutTokens: 0,
  imageInTokens: 0,
  imageOutTokens: 0,
  totalTokens: 0,
  priceVersionId: null,
  rawCostNanoUsd: 0n,
  surchargeNanoUsd: 0n,
  billedCostNanoUsd: 0n,
  markupMultiplier: 1,
  currency: 'USD',
  priceMissing: false,
  status: 'posted' as const,
  idempotencyKey: '',
  isSystemCost: false,
  enforced: false,
  occurredAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies UsageRecord
