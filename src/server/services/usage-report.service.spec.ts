import type { Readable } from 'node:stream'
import type { AiTokensErrorResponse, UsageSummary } from '../../shared'
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

  /** A record with a null priceVersionId contributes zero cache savings. */
  it('contributes zero savings for a price-missing record', async () => {
    const built = build()
    await built.ledger.append(appendInput({ priceVersionId: null, cacheReadTokens: 1_000_000, priceMissing: true }), 'a')
    const [summary] = await built.service.summarize({ ...FILTER, groupBy: [] })
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
    expect(csv[0]).toContain('billedCostConverted')
    expect(csv[0]).toContain('presentationCurrency')
    // 6_250_000 × 5_000_000_000 / 1_000_000_000 = 31_250_000
    expect(csv[1]).toContain('31250000')
    expect(csv[1]).toContain('BRL')
  })

  /** A USD currency emits no converted columns. */
  it('omits converted columns for USD', async () => {
    const built = build()
    await built.ledger.append(appendInput(), 'a')
    const csv = await collect(await built.service.export(FILTER, 'csv'))
    expect(csv).not.toContain('billedCostConverted')
  })

  /** The default no-op audit hook is used when none is wired. */
  it('runs without an audit hook', async () => {
    const service = new UsageReportService(new InMemoryLedgerStore(), new InMemoryPricingStore(), { currency: 'USD', reporting: { maxExportRows: 10 } })
    await expect(collect(await service.export(FILTER, 'json'))).resolves.toBe('')
  })
})
