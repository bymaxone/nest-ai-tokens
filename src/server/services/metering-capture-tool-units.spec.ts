/**
 * The tool units of a call are billed the same whether the call is recorded at once or held and captured: the units the provider
 * reported in the usage and the units the host supplied on the hold both count, and the host's value wins for a unit both name.
 * @layer test
 */
import type { NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { Hold, HoldEstimate, IContentStore, ITelemetrySink, MeteringContext } from '../interfaces'
import { ContentCapture } from './content-capture'
import { TelemetryEmitter } from '../telemetry/otel-emitter'
import { BudgetService } from './budget.service'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService, type MeteringEventHooks } from './metering.service'
import { PricingService } from './pricing.service'
import { WalletService } from './wallet.service'

/** A representative metering context; `over` replaces any field. */
function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', ...over }
}

/** Build a complete `NormalizedUsage` for already-normalized inputs. */
function normalized(over: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
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
    ...over,
  }
}


/** The event hooks as jest mocks. */
type MockEvents = { [K in keyof MeteringEventHooks]: jest.Mock }

/** The service-under-test plus its collaborators for assertions. */
interface Built {
  service: MeteringService
  ledgerStore: InMemoryLedgerStore
  pricingStore: InMemoryPricingStore
  walletStore: InMemoryWalletStore
  budgetStore: InMemoryBudgetStore
  wallets: WalletService | undefined
  budgets: BudgetService | undefined
  events: MockEvents
  now: () => Date
}

/** Build a MeteringService over in-memory stores; enable wallets/budgets on demand. */
function build(
  opts: {
    markup?: number
    strict?: boolean
    ratingMode?: 'rate-table' | 'provider-reported'
    wallets?: boolean
    budgets?: boolean
    overdraft?: bigint
    ttlSeconds?: number
    clock?: () => Date
    telemetry?: ITelemetrySink
    content?: IContentStore
  } = {},
): Built {
  const now = opts.clock ?? ((): Date => new Date())
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  const walletStore = new InMemoryWalletStore({ now })
  const budgetStore = new InMemoryBudgetStore({ now })
  const options = {
    ratingMode: opts.ratingMode ?? 'rate-table',
    markup: opts.markup ?? 1,
    ledger: { hashChain: false },
    pricing: { strict: opts.strict ?? true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: opts.ttlSeconds ?? 3_600, reaperIntervalSeconds: 300 },
    wallets: opts.wallets
      ? { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: opts.overdraft ?? 0n, burnOrder: 'expiry' }
      : { enabled: false },
    budgets: opts.budgets ? { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true } : { enabled: false },
  } as ResolvedAiTokensOptions
  const ledger = new LedgerService(ledgerStore, options)
  const wallets = opts.wallets ? new WalletService(walletStore, options.wallets as never) : undefined
  const budgets = opts.budgets ? new BudgetService(budgetStore, ledger, options.budgets as never, now) : undefined
  const events: MockEvents = {
    usageRecorded: jest.fn(() => Promise.resolve()),
    priceMissing: jest.fn(() => Promise.resolve()),
    holdReleased: jest.fn(() => Promise.resolve()),
    usageReversed: jest.fn(() => Promise.resolve()),
    audit: jest.fn(() => Promise.resolve()),
  }
  const telemetry = new TelemetryEmitter(opts.telemetry ?? null)
  const content = new ContentCapture(opts.content !== undefined ? { enabled: true, store: opts.content, ttlSeconds: 3_600 } : { enabled: false })
  const service = new MeteringService(ledger, new PricingService(options, pricingStore), new MarkupResolver(options), options, events, wallets, budgets, now, telemetry, content)
  return { service, ledgerStore, pricingStore, walletStore, budgetStore, wallets, budgets, events, now }
}

/** Seed a gpt-5 chat price with a rate of 10,000,000 nano-USD for a web search and 1,000,000 for a code run. */
async function seedWithToolRate(store: InMemoryPricingStore): Promise<void> {
  await store.upsertPrice({
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_250_000_000n,
    outputNanoUsdPerMillion: 10_000_000_000n,
    unitRates: { web_search_requests: 10_000_000n, code_run: 1_000_000n },
    effectiveFrom: new Date(0),
  })
}

const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }

/** The billed cost of the same call recorded at once, and held then captured. */
async function billed(usage: NormalizedUsage, extraUnits?: Record<string, number>): Promise<{ recorded: bigint; captured: bigint }> {
  const built = build()
  await seedWithToolRate(built.pricingStore)
  const ctx = context(extraUnits === undefined ? {} : { extraUnits })
  const recorded = await built.service.record({ usage, context: ctx })
  const hold: Hold = await built.service.hold(ctx, ESTIMATE)
  const captured = await built.service.capture(hold, { tenantId: ctx.tenantId, scope: ctx.scope }, usage)
  return { recorded: recorded.billedCostNanoUsd, captured: captured.billedCostNanoUsd }
}

describe('the tool units of a captured hold are billed as record() bills them', () => {
  /** A web search the provider reported in the usage is billed on capture: 7 searches at 10,000,000 each is 70,000,000 nano-USD. */
  it('bills the server tool use of the usage', async () => {
    const usage = normalized({ serverToolUse: { web_search_requests: 7 } })
    const { recorded, captured } = await billed(usage)
    expect(captured).toBe(recorded)
    expect(captured - (await billed(normalized())).captured).toBe(70_000_000n)
  })

  /** The hold keeps the units of the host, and the captured record names the units it billed, so a report and a reversal read what was charged. */
  it('stores the units on the pending hold and names the billed units on the captured record', async () => {
    const built = build()
    await seedWithToolRate(built.pricingStore)
    const ctx = context({ extraUnits: { web_search_requests: 3 } })
    const hold = await built.service.hold(ctx, ESTIMATE)
    expect((await built.ledgerStore.findById(hold.id))?.extraUnits).toEqual({ web_search_requests: 3 })
    const captured = await built.service.capture(hold, { tenantId: ctx.tenantId, scope: ctx.scope }, normalized({ serverToolUse: { code_run: 2 } }))
    expect(captured.extraUnits).toEqual({ code_run: 2, web_search_requests: 3 })
    expect((await built.ledgerStore.findById(hold.id))?.extraUnits).toEqual({ code_run: 2, web_search_requests: 3 })
  })

  /** A call with no tool units keeps no units on the record: the key is absent, whether the host gave none or an empty map. */
  it.each([['none', undefined], ['an empty map', {}]] as const)('keeps no units key on a hold or a capture whose host gave %s', async (_name, units) => {
    const built = build()
    await seedWithToolRate(built.pricingStore)
    const ctx = context(units === undefined ? {} : { extraUnits: units })
    const hold = await built.service.hold(ctx, ESTIMATE)
    const pending = await built.ledgerStore.findById(hold.id)
    expect(pending).not.toBeNull()
    expect('extraUnits' in pending!).toBe(false)
    const captured = await built.service.capture(hold, { tenantId: ctx.tenantId, scope: ctx.scope }, normalized())
    expect('extraUnits' in captured).toBe(false)
  })

  /** Units the host put on the hold are billed on capture, as they are on record(). */
  it('bills the extra units of the hold', async () => {
    const { recorded, captured } = await billed(normalized(), { web_search_requests: 3 })
    expect(captured).toBe(recorded)
    expect(captured - (await billed(normalized())).captured).toBe(30_000_000n)
  })

  /** A unit both name is billed once, with the host's count, as record() does; units that differ add up. */
  it('bills the units of both, and the host\'s count for a unit both name', async () => {
    const usage = normalized({ serverToolUse: { web_search_requests: 7, code_run: 2 } })
    const { recorded, captured } = await billed(usage, { web_search_requests: 3 })
    expect(captured).toBe(recorded)
    // 3 searches of the host at 10,000,000 and 2 code runs of the provider at 1,000,000: a capture that dropped the provider's units would bill 30,000,000.
    expect(captured - (await billed(normalized())).captured).toBe(32_000_000n)
  })
})
