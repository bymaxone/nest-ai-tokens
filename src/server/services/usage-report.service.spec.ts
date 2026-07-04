import type { Readable } from 'node:stream'
import type { AiTokensErrorResponse, UsageSummary } from '../../shared'
import type { ReportGroupBy } from '../interfaces'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { ILedgerStore } from '../interfaces'
import type { AiTokensException } from '../errors'
import { LedgerService, type LedgerAppendInput } from './ledger.service'
import { UsageReportService, type UsageReportOptions } from './usage-report.service'

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** Drain a readable stream to a single string. */
async function collect(stream: Readable): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += String(chunk)
  return out
}

const PRICE_ID = 'price-gpt5'
const FROM = new Date('2026-06-01T00:00:00.000Z')
const TO = new Date('2026-07-01T00:00:00.000Z')

/** A full ledger append input; `over` replaces any field. */
function appendInput(over: Partial<LedgerAppendInput> = {}): LedgerAppendInput {
  return {
    tenantId: 'tenant-1',
    scope: { type: 'user', id: 'u1' },
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    feature: 'chat.reply',
    tags: [],
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
    priceVersionId: PRICE_ID,
    rawCostNanoUsd: 6_250_000n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 6_250_000n,
    markupMultiplier: 1,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    isSystemCost: false,
    enforced: false,
    occurredAt: new Date('2026-06-15T12:00:00.000Z'),
    ...over,
  }
}

/** A report service over in-memory stores; seeds the gpt-5 price for cache savings. */
function build(opts: { currency?: string; fx?: UsageReportOptions['fx']; maxExportRows?: number; store?: ILedgerStore } = {}): {
  service: UsageReportService
  ledger: LedgerService
  ledgerStore: InMemoryLedgerStore
  pricingStore: InMemoryPricingStore
  audits: { action: string; details: Record<string, unknown> }[]
} {
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  const ledger = new LedgerService(ledgerStore)
  const options: UsageReportOptions = { currency: opts.currency ?? 'USD', fx: opts.fx, reporting: { maxExportRows: opts.maxExportRows ?? 1_000_000 } }
  const audits: { action: string; details: Record<string, unknown> }[] = []
  const service = new UsageReportService(opts.store ?? ledgerStore, pricingStore, options, (action, details) => void audits.push({ action, details }))
  return { service, ledger, ledgerStore, pricingStore, audits }
}

/** Seed the gpt-5 price ($1.25/M input, $0.125/M cache-read) so cache savings resolve. */
async function seedPrice(pricingStore: InMemoryPricingStore): Promise<void> {
  await pricingStore.upsertPrice({
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_250_000_000n,
    cacheReadNanoUsdPerMillion: 125_000_000n,
    outputNanoUsdPerMillion: 10_000_000_000n,
    effectiveFrom: new Date(0),
  })
}

const FILTER = { tenantId: 'tenant-1', from: FROM, to: TO }

describe('UsageReportService.summarize', () => {
  /** An empty groupBy yields one grand-total row. */
  it('produces a grand total for an empty groupBy', async () => {
    const built = build()
    await built.ledger.append(appendInput(), 'a')
    await built.ledger.append(appendInput({ billedCostNanoUsd: 4_000_000n }), 'b')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: [] })
    expect(summary?.group).toEqual({})
    expect(summary?.records).toBe(2)
    expect(summary?.billedCostNanoUsd).toBe(10_250_000n)
    expect(summary?.tokens.input).toBe(2000)
  })

  /** groupBy day buckets records by their UTC calendar day. */
  it('groups by UTC day', async () => {
    const built = build()
    await built.ledger.append(appendInput({ occurredAt: new Date('2026-06-15T23:00:00.000Z') }), 'a')
    await built.ledger.append(appendInput({ occurredAt: new Date('2026-06-16T01:00:00.000Z') }), 'b')
    const summaries = await built.service.summarize({ ...FILTER, groupBy: ['day'] })
    expect(summaries.map((s) => s.group.day).sort()).toEqual(['2026-06-15', '2026-06-16'])
  })

  /** groupBy week anchors to the Monday of the UTC week. */
  it('groups by ISO week start', async () => {
    const built = build()
    await built.ledger.append(appendInput({ occurredAt: new Date('2026-06-17T12:00:00.000Z') }), 'a') // Wed
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: ['week'] })
    expect(summary?.group.week).toBe('2026-06-15') // the Monday
  })

  /** groupBy month buckets by YYYY-MM. */
  it('groups by month', async () => {
    const built = build()
    await built.ledger.append(appendInput(), 'a')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: ['month'] })
    expect(summary?.group.month).toBe('2026-06')
  })

  /** groupBy tag unnests each record's tags. */
  it('unnests tags', async () => {
    const built = build()
    await built.ledger.append(appendInput({ tags: ['team:a', 'team:b'] }), 'a')
    await built.ledger.append(appendInput({ tags: ['team:a'] }), 'b')
    const summaries = await built.service.summarize({ ...FILTER, groupBy: ['tag'] })
    expect(summaries.map((s) => `${String(s.group.tag)}=${String(s.records)}`).sort()).toEqual(['team:a=2', 'team:b=1'])
  })

  /** A tagless record drops out of a tag-grouped report (unnest semantics). */
  it('drops tagless records when grouping by tag', async () => {
    const built = build()
    await built.ledger.append(appendInput({ tags: [] }), 'a')
    expect(await built.service.summarize({ ...FILTER, groupBy: ['tag'] })).toHaveLength(0)
  })

  /** groupBy beneficiary keys on the beneficiary type:id (empty when absent). */
  it('groups by beneficiary', async () => {
    const built = build()
    await built.ledger.append(appendInput({ beneficiary: { type: 'user', id: 'client-1' } }), 'a')
    await built.ledger.append(appendInput(), 'b')
    const summaries = await built.service.summarize({ ...FILTER, groupBy: ['beneficiary'] })
    expect(summaries.map((s) => s.group.beneficiary).sort()).toEqual(['', 'user:client-1'])
  })

  /** groupBy across scope/provider/model/operation/serviceTier/feature/systemCostCategory. */
  it('groups by the remaining dimensions', async () => {
    const built = build()
    await built.ledger.append(appendInput({ isSystemCost: true, systemCostCategory: 'retry' }), 'a')
    const [s] = await built.service.summarize({ ...FILTER, groupBy: ['scope', 'provider', 'model', 'operation', 'serviceTier', 'feature', 'systemCostCategory'] })
    expect(s?.group).toEqual({ scope: 'user:u1', provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', feature: 'chat.reply', systemCostCategory: 'retry' })
  })

  /** cacheSavingsNanoUsd = Σ cacheReadTokens × (inputRate − cacheReadRate). */
  it('computes cache savings from the effective price', async () => {
    const built = build()
    await seedPrice(built.pricingStore)
    await built.ledger.append(appendInput({ cacheReadTokens: 1_000_000 }), 'a')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: [] })
    // 1_000_000 × (1_250_000_000 − 125_000_000) / 1_000_000 = 1_125_000_000
    expect(summary?.cacheSavingsNanoUsd).toBe(1_125_000_000n)
  })

  /** A record with a null priceVersionId contributes zero cache savings, even when a price exists. */
  it('contributes zero savings for a price-missing record', async () => {
    const built = build()
    // Seed a real price so resolveRate returns non-null (ensures CE→false would produce non-zero savings):
    await seedPrice(built.pricingStore)
    await built.ledger.append(appendInput({ priceVersionId: null, cacheReadTokens: 1_000_000, priceMissing: true }), 'a')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: [] })
    // Must be 0n because priceVersionId is null — kills CE→false on `priceVersionId === null`:
    expect(summary?.cacheSavingsNanoUsd).toBe(0n)
  })

  /** A record whose price no longer resolves contributes zero savings. */
  it('contributes zero savings when the price no longer resolves', async () => {
    const built = build()
    await built.ledger.append(appendInput({ model: 'unpriced', cacheReadTokens: 5 }), 'a')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: [] })
    expect(summary?.cacheSavingsNanoUsd).toBe(0n)
  })

  /** isSystemCost filtering restricts the aggregation (fitness admin reports). */
  it('filters by isSystemCost', async () => {
    const built = build()
    await built.ledger.append(appendInput({ isSystemCost: true, systemCostCategory: 'retry' }), 'a')
    await built.ledger.append(appendInput(), 'b')
    const [summary] = await built.service.summarize({ ...FILTER, isSystemCost: true, groupBy: [] })
    expect(summary?.records).toBe(1)
  })

  /** Every ReportFilter dimension narrows the aggregation. */
  it('applies the full report filter', async () => {
    const built = build()
    const match = appendInput({ beneficiary: { type: 'user', id: 'client-1' }, tags: ['t1'], enforced: true, systemCostCategory: 'cat' })
    await built.ledger.append(match, 'match')
    await built.ledger.append(appendInput({ provider: 'anthropic', model: 'claude', tags: [] }), 'other')
    const [summary] = await built.service.summarize({
      tenantId: 'tenant-1',
      scope: { type: 'user', id: 'u1' },
      beneficiary: { type: 'user', id: 'client-1' },
      feature: 'chat.reply',
      features: ['chat.reply'],
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      serviceTier: 'standard',
      tags: ['t1'],
      isSystemCost: false,
      systemCostCategory: 'cat',
      enforcedOnly: true,
      status: ['posted'],
      from: FROM,
      to: TO,
      groupBy: [],
    })
    expect(summary?.records).toBe(1)
  })

  /** A record without a systemCostCategory groups under the empty key. */
  it('groups an absent systemCostCategory as empty', async () => {
    const built = build()
    await built.ledger.append(appendInput(), 'a')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: ['systemCostCategory'] })
    expect(summary?.group.systemCostCategory).toBe('')
  })

  /** summarize refuses to emit partial totals: it throws when matches exceed maxExportRows (not truncate). */
  it('throws when matched rows exceed maxExportRows instead of truncating', async () => {
    const built = build({ maxExportRows: 1 })
    await built.ledger.append(appendInput({ billedCostNanoUsd: 1_000_000n }), 'a')
    await built.ledger.append(appendInput({ billedCostNanoUsd: 2_000_000n }), 'b')
    const error = await built.service.summarize({ ...FILTER, groupBy: [] }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** At exactly maxExportRows the aggregate is complete — the boundary neither truncates nor throws. */
  it('returns complete totals at exactly maxExportRows', async () => {
    const built = build({ maxExportRows: 2 })
    await built.ledger.append(appendInput({ billedCostNanoUsd: 1_000_000n }), 'a')
    await built.ledger.append(appendInput({ billedCostNanoUsd: 2_000_000n }), 'b')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: [] })
    expect(summary?.records).toBe(2)
    expect(summary?.billedCostNanoUsd).toBe(3_000_000n)
  })

  /**
   * All three accumulated fields (totalTokens, rawCostNanoUsd, surchargeNanoUsd) use +=
   * not -=. With two different-sized records, each should ACCUMULATE (not cancel/reverse).
   * Kills AssignmentOperator mutation (-= instead of +=) on the accumulate loop.
   */
  it('accumulates totalTokens, rawCostNanoUsd, and surchargeNanoUsd across records', async () => {
    const built = build({ maxExportRows: 2 })
    // inputTokens: 100 → totalTokens = 100; rawCostNanoUsd: 5_000n, surchargeNanoUsd: 500n
    await built.ledger.append(appendInput({ inputTokens: 100, outputTokens: 0, rawCostNanoUsd: 5_000n, surchargeNanoUsd: 500n }), 'a')
    // inputTokens: 200 → totalTokens = 200; rawCostNanoUsd: 10_000n, surchargeNanoUsd: 1_000n
    await built.ledger.append(appendInput({ inputTokens: 200, outputTokens: 0, rawCostNanoUsd: 10_000n, surchargeNanoUsd: 1_000n }), 'b')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: [] })
    // With -= mutation: 100-200=-100, 5000-10000=-5000, 500-1000=-500 (wrong negative values).
    expect(summary?.totalTokens).toBe(300)
    expect(summary?.rawCostNanoUsd).toBe(15_000n)
    expect(summary?.surchargeNanoUsd).toBe(1_500n)
  })

  /** A store implementing summarize is delegated to directly. */
  it('delegates to a store summarize implementation', async () => {
    const canned: UsageSummary[] = [{ group: { model: 'gpt-5' }, records: 9, totalTokens: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0, audioIn: 0, audioOut: 0, imageIn: 0, imageOut: 0 }, rawCostNanoUsd: 0n, surchargeNanoUsd: 0n, billedCostNanoUsd: 0n, cacheSavingsNanoUsd: 0n }]
    const store = Object.assign(new InMemoryLedgerStore(), { summarize: (): Promise<UsageSummary[]> => Promise.resolve(canned) })
    const built = build({ store })
    expect(await built.service.summarize({ ...FILTER, groupBy: ['model'] })).toBe(canned)
  })
})

describe('UsageReportService.export', () => {
  /** CSV export streams the §13.2 field set with bigints as decimal strings + audit. */
  it('streams a CSV export and emits an audit event', async () => {
    const built = build()
    await built.ledger.append(appendInput({ tags: ['a', 'b'], correlationId: 'corr-1' }), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    const [header, row] = csv.trim().split('\n')
    expect(header).toContain('billedCostNanoUsd')
    expect(header).toContain('occurredAt')
    expect(row).toContain('6250000')
    expect(row).toContain('a;b')
    expect(built.audits[0]?.action).toBe('ai_tokens.audit')
    expect(built.audits[0]?.details).toEqual(expect.objectContaining({ action: 'export', format: 'csv' }))
  })

  /** The CSV header lists every §13.2 column name in exact declaration order — kills all StringLiteral mutations in baseCells keys. */
  it('emits all §13.2 columns in declaration order', async () => {
    const built = build()
    await built.ledger.append(appendInput(), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    const headers = csv.trim().split('\n')[0]!.split(',')
    expect(headers).toEqual([
      'tenantId', 'scopeType', 'scopeId',
      'beneficiaryType', 'beneficiaryId', 'requestedBy',
      'feature', 'tags',
      'provider', 'model', 'requestedModel',
      'operation', 'serviceTier',
      'inputTokens', 'outputTokens', 'cacheReadTokens',
      'cacheWrite5mTokens', 'cacheWrite1hTokens', 'reasoningTokens',
      'audioInTokens', 'audioOutTokens', 'imageInTokens', 'imageOutTokens',
      'totalTokens', 'extraUnits',
      'rawCostNanoUsd', 'surchargeNanoUsd', 'billedCostNanoUsd',
      'markupMultiplier', 'currency', 'priceMissing',
      'occurredAt', 'idempotencyKey', 'correlationId', 'requestId',
      'isSystemCost', 'systemCostCategory', 'enforced', 'status',
    ])
  })

  /** Every optional record field renders in the export row. */
  it('renders all optional record fields', async () => {
    const built = build()
    await built.ledger.append(appendInput({ beneficiary: { type: 'user', id: 'client-1' }, requestedBy: 'actor-1', requestedModel: 'gpt-5', extraUnits: { web_search_requests: 2 }, correlationId: 'corr-1', requestId: 'req-1', systemCostCategory: 'cat', isSystemCost: true }), 'a')
    const ndjson = (await collect(await built.service.export(FILTER, 'json'))).trim().split('\n')
    const row = JSON.parse(ndjson[0]!) as Record<string, string>
    expect(row.beneficiaryId).toBe('client-1')
    expect(row.requestedBy).toBe('actor-1')
    expect(row.requestedModel).toBe('gpt-5')
    expect(row.extraUnits).toBe('{"web_search_requests":2}')
    expect(row.correlationId).toBe('corr-1')
    expect(row.requestId).toBe('req-1')
    expect(row.systemCostCategory).toBe('cat')
  })

  /**
   * Absent optional string fields (beneficiaryType, beneficiaryId, requestedBy, requestedModel,
   * correlationId, requestId, systemCostCategory) render as empty string in the export.
   * Kills StringLiteral mutations that change the `''` fallback to "Stryker was here!".
   * Also kills SL on extraUnits '' sentinel (when extraUnits is undefined → renders '').
   */
  it('renders absent optional fields as empty string', async () => {
    const built = build()
    // appendInput defaults: no beneficiary, no requestedBy/requestedModel/correlationId/requestId/systemCostCategory/extraUnits
    // (Omit optional fields entirely — exactOptionalPropertyTypes disallows passing `undefined`)
    await built.ledger.append(appendInput(), 'a')
    const ndjson = (await collect(await built.service.export(FILTER, 'json'))).trim().split('\n')
    const row = JSON.parse(ndjson[0]!) as Record<string, string>
    expect(row.beneficiaryType).toBe('')
    expect(row.beneficiaryId).toBe('')
    expect(row.requestedBy).toBe('')
    expect(row.requestedModel).toBe('')
    expect(row.correlationId).toBe('')
    expect(row.requestId).toBe('')
    expect(row.systemCostCategory).toBe('')
    expect(row.extraUnits).toBe('')
  })

  /** JSON export is line-delimited with decimal-string bigints. */
  it('streams line-delimited JSON', async () => {
    const built = build()
    await built.ledger.append(appendInput(), 'a')
    await built.ledger.append(appendInput({ billedCostNanoUsd: 1_000_000n }), 'b')
    const ndjson = (await collect(await built.service.export(FILTER, 'json'))).trim().split('\n')
    expect(ndjson).toHaveLength(2)
    const first = JSON.parse(ndjson[0]!) as Record<string, string>
    expect(first.billedCostNanoUsd).toBe('6250000')
  })

  /** A field containing a comma is CSV-quoted. */
  it('quotes CSV cells containing a comma', async () => {
    const built = build()
    await built.ledger.append(appendInput({ tags: ['a,b'] }), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    expect(csv).toContain('"a,b"')
  })

  /**
   * A cell containing a double-quote is RFC-4180-escaped by doubling the embedded quote
   * (a"b → "a""b"). Kills the StringLiteral mutation that replaces the `'""'` escape
   * replacement with `''` (which would delete embedded quotes, corrupting the CSV).
   */
  it('escapes embedded double-quotes by doubling them', async () => {
    const built = build()
    await built.ledger.append(appendInput({ tags: ['a"b'] }), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    // Original: a"b → "a""b"; mutant ('' replacement): a"b → "ab" (quote deleted, no doubling).
    expect(csv).toContain('a""b')
    expect(csv).not.toContain('"ab"')
  })

  /** An export exceeding maxExportRows throws. */
  it('enforces maxExportRows', async () => {
    const built = build({ maxExportRows: 1 })
    await built.ledger.append(appendInput(), 'a')
    await built.ledger.append(appendInput(), 'b')
    const error = await built.service.export(FILTER, 'csv').catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A non-USD currency adds fx-converted presentation columns. */
  it('adds fx-converted columns for a non-USD currency', async () => {
    const built = build({ currency: 'BRL', fx: () => 5_000_000_000n })
    await built.ledger.append(appendInput(), 'a')
    const csv = (await collect(await built.service.export(FILTER, 'csv'))).trim().split('\n')
    // All four fx header names must appear in the CSV header (kills SL mutations on each name in headers()):
    expect(csv[0]).toContain('billedCostConverted')
    expect(csv[0]).toContain('presentationCurrency')
    expect(csv[0]).toContain('rawCostConverted')
    expect(csv[0]).toContain('surchargeConverted')
    // 6_250_000 × 5_000_000_000 / 1_000_000_000 = 31_250_000
    expect(csv[1]).toContain('31250000')
    expect(csv[1]).toContain('BRL')
  })

  /** FX conversion: (nanoUsd × rate) ÷ NANO_PER_USD — exact value, not substring — kills ArithmeticOperator mutations. */
  it('applies the exact FX formula (multiply then divide)', async () => {
    const built = build({ currency: 'BRL', fx: () => 5_000_000_000n })
    await built.ledger.append(appendInput(), 'a')
    const lines = (await collect(await built.service.export(FILTER, 'json'))).trim().split('\n')
    const row = JSON.parse(lines[0]!) as Record<string, string>
    // 6_250_000n × 5_000_000_000n / 1_000_000_000n = 31_250_000 (exact)
    // Check all four converted JSON keys (kills SL mutations in rowOf — 'presentationCurrency', 'rawCostConverted', 'surchargeConverted', 'billedCostConverted'):
    expect(row.billedCostConverted).toBe('31250000')
    expect(row.rawCostConverted).toBe('31250000')
    expect(row.surchargeConverted).toBe('0')
    expect(row.presentationCurrency).toBe('BRL')
  })

  /** A plain cell with no comma, quote, or newline is NOT quoted in CSV — kills the Regex mutation. */
  it('does not quote plain cells', async () => {
    const built = build()
    await built.ledger.append(appendInput({ tags: [] }), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    const row = csv.trim().split('\n')[1]!
    // 'tenant-1' has no special chars — must not be wrapped in quotes
    expect(row).toContain('tenant-1')
    expect(row).not.toContain('"tenant-1"')
  })

  /** A USD currency emits no converted columns. */
  it('omits converted columns for USD', async () => {
    const built = build()
    await built.ledger.append(appendInput(), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    expect(csv).not.toContain('billedCostConverted')
  })

  /**
   * When currency is USD but an fx function is provided, the `&&` condition ensures
   * we do NOT convert (currency is already USD — no conversion needed).
   * Kills CE→true on `currency !== 'USD'` and StringLiteral `""` on 'USD':
   * both would cause FX conversion even for USD, adding unwanted converted columns.
   */
  it('omits converted columns for USD even when an fx function is provided', async () => {
    const built = build({ currency: 'USD', fx: () => 5_000_000_000n })
    await built.ledger.append(appendInput(), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    expect(csv).not.toContain('billedCostConverted')
    expect(csv).not.toContain('presentationCurrency')
  })

  /**
   * A non-USD currency WITHOUT an fx function must NOT emit converted columns: the
   * `converting` flag requires BOTH a non-USD currency AND a defined fx. This kills the
   * L136 ConditionalExpression `this.options.fx !== undefined → true`, which would set
   * `converting` true for BRL even with fx undefined, adding the fx header names while
   * `rowOf` (guarded by `this.options.fx === undefined`) emits no fx values. (The `→ false`
   * variant is already killed by 'adds fx-converted columns for a non-USD currency'.)
   */
  it('omits converted columns for a non-USD currency when no fx function is provided', async () => {
    const built = build({ currency: 'BRL' }) // non-USD, but no fx supplied
    await built.ledger.append(appendInput(), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    expect(csv).not.toContain('billedCostConverted')
    expect(csv).not.toContain('presentationCurrency')
  })

  /** The default no-op audit hook is used when none is wired. */
  it('runs without an audit hook', async () => {
    const service = new UsageReportService(new InMemoryLedgerStore(), new InMemoryPricingStore(), { currency: 'USD', reporting: { maxExportRows: 10 } })
    await expect(collect(await service.export(FILTER, 'json'))).resolves.toBe('')
  })
})

/**
 * Each optional filter dimension in `toLedgerFilter` is forwarded to the store. These
 * isolation tests ensure the conditional expression at each dimension is NOT replaced by
 * `false` (omitting the field) — a mutation that would cause the filter to match all records.
 */
describe('UsageReportService filter isolation', () => {
  const BASE = { tenantId: 'tenant-1', from: FROM, to: TO, groupBy: [] as ReportGroupBy[] }

  /** scope filter narrows by tenant:scope:id. */
  it('filters by scope', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ scope: { type: 'user', id: 'match' } }), 'a')
    await ledger.append(appendInput({ scope: { type: 'user', id: 'other' } }), 'b')
    const [summary] = await service.summarize({ ...BASE, scope: { type: 'user', id: 'match' } })
    expect(summary?.records).toBe(1)
  })

  /** beneficiary filter restricts to records with a matching beneficiary. */
  it('filters by beneficiary', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ beneficiary: { type: 'user', id: 'ben-1' } }), 'a')
    await ledger.append(appendInput(), 'b')
    const [summary] = await service.summarize({ ...BASE, beneficiary: { type: 'user', id: 'ben-1' } })
    expect(summary?.records).toBe(1)
  })

  /** feature filter matches on exact feature name. */
  it('filters by feature', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ feature: 'chat.reply' }), 'a')
    await ledger.append(appendInput({ feature: 'search.query' }), 'b')
    const [summary] = await service.summarize({ ...BASE, feature: 'chat.reply' })
    expect(summary?.records).toBe(1)
  })

  /** features array matches records whose feature is in the list. */
  it('filters by features array', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ feature: 'chat.reply' }), 'a')
    await ledger.append(appendInput({ feature: 'search.query' }), 'b')
    const [summary] = await service.summarize({ ...BASE, features: ['chat.reply'] })
    expect(summary?.records).toBe(1)
  })

  /** provider filter matches on exact provider id. */
  it('filters by provider', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ provider: 'openai' }), 'a')
    await ledger.append(appendInput({ provider: 'anthropic' }), 'b')
    const [summary] = await service.summarize({ ...BASE, provider: 'openai' })
    expect(summary?.records).toBe(1)
  })

  /** model filter matches on exact model name. */
  it('filters by model', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ model: 'gpt-5' }), 'a')
    await ledger.append(appendInput({ model: 'gpt-4o' }), 'b')
    const [summary] = await service.summarize({ ...BASE, model: 'gpt-5' })
    expect(summary?.records).toBe(1)
  })

  /** operation filter matches on exact operation kind. */
  it('filters by operation', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ operation: 'chat' }), 'a')
    await ledger.append(appendInput({ operation: 'responses' }), 'b')
    const [summary] = await service.summarize({ ...BASE, operation: 'chat' })
    expect(summary?.records).toBe(1)
  })

  /** serviceTier filter matches on exact tier. */
  it('filters by serviceTier', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ serviceTier: 'standard' }), 'a')
    await ledger.append(appendInput({ serviceTier: 'batch' }), 'b')
    const [summary] = await service.summarize({ ...BASE, serviceTier: 'standard' })
    expect(summary?.records).toBe(1)
  })

  /** tags filter requires the record to carry every listed tag. */
  it('filters by tags', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ tags: ['team-a'] }), 'a')
    await ledger.append(appendInput({ tags: ['team-b'] }), 'b')
    const [summary] = await service.summarize({ ...BASE, tags: ['team-a'] })
    expect(summary?.records).toBe(1)
  })

  /** isSystemCost filter restricts to the specified boolean flag. */
  it('filters by isSystemCost', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ isSystemCost: true }), 'a')
    await ledger.append(appendInput({ isSystemCost: false }), 'b')
    const [summary] = await service.summarize({ ...BASE, isSystemCost: true })
    expect(summary?.records).toBe(1)
  })

  /** systemCostCategory filter matches on exact category string. */
  it('filters by systemCostCategory', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ isSystemCost: true, systemCostCategory: 'retry' }), 'a')
    await ledger.append(appendInput({ isSystemCost: true, systemCostCategory: 'eval' }), 'b')
    const [summary] = await service.summarize({ ...BASE, systemCostCategory: 'retry' })
    expect(summary?.records).toBe(1)
  })

  /** enforcedOnly filter restricts to records where enforced === true. */
  it('filters by enforcedOnly', async () => {
    const { service, ledger } = build()
    await ledger.append(appendInput({ enforced: true }), 'a')
    await ledger.append(appendInput({ enforced: false }), 'b')
    const [summary] = await service.summarize({ ...BASE, enforcedOnly: true })
    expect(summary?.records).toBe(1)
  })
})
