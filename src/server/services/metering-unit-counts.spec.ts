import type { AiTokensErrorResponse } from '../../shared'
import type { AiTokensException } from '../errors'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { HoldEstimate, IContentStore, ITelemetrySink, MeteringContext } from '../interfaces'
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


/** gpt-5 with a rate of 10,000,000 nano-USD for a web search and none for a code run. */
async function seed(store: InMemoryPricingStore): Promise<void> {
  await store.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_000_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, unitRates: { web_search_requests: 10_000_000n }, effectiveFrom: new Date(0) })
}

const WALLET = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' } as const
const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }
const CALLER = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' } } as const
const REASON = (unit: string): string => `context.extraUnits.${unit} must be a whole number from 0 to the largest safe integer`

/** A world with a wallet of 10,000,000,000,000 nano-USD and the price above. */
async function world(over: { strict?: boolean } = {}): Promise<Built> {
  const built = build({ wallets: true, strict: over.strict ?? true })
  await seed(built.pricingStore)
  await built.wallets!.grant(WALLET, { amountNanoUsd: 10_000_000_000_000n, idempotencyKey: 'grant-1', reason: 'seed' })
  return built
}

const usage = (serverToolUse?: Record<string, number>): Record<string, unknown> => ({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0, ...(serverToolUse === undefined ? {} : { serverToolUse }) })

/** The code and reason of the typed refusal a call raises, or `undefined` when it does not refuse. */
async function refusal(run: () => Promise<unknown>): Promise<{ code: string; reason: string | undefined } | undefined> {
  try {
    await run()
  } catch (error) {
    const { error: body } = (error as AiTokensException).getResponse() as AiTokensErrorResponse
    return { code: body.code, reason: body.details?.reason as string | undefined }
  }
  return undefined
}

describe('the tool units a host puts on a call are counts', () => {
  const BAD: readonly [string, unknown][] = [
    ['a negative', -5],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '3'],
    ['2**53', 2 ** 53],
  ]

  /** Every bad count is refused with the malformed-usage error naming the unit, before a debit, and writes no row. */
  it.each(BAD)('refuses %s on record() and on hold(), and touches neither the wallet nor the ledger', async (_name, count) => {
    const built = await world()
    const before = (await built.wallets!.getBalance(WALLET)).nanoUsd
    const ctx = context({ extraUnits: { web_search_requests: count as number }, enforce: true })
    expect(await refusal(() => built.service.record({ usage: usage(), context: ctx }))).toEqual({ code: 'AI_TOKENS_USAGE_MALFORMED', reason: REASON('web_search_requests') })
    expect(await refusal(() => built.service.hold(ctx, ESTIMATE))).toEqual({ code: 'AI_TOKENS_USAGE_MALFORMED', reason: REASON('web_search_requests') })
    expect((await built.wallets!.getBalance(WALLET)).nanoUsd).toBe(before)
    expect(await built.ledgerStore.query({ tenantId: 'tenant-1' })).toEqual([])
  })

  /** A map that is no object is refused as a malformed argument. */
  it('refuses extra units that are not an object', async () => {
    const built = await world()
    expect(await refusal(() => built.service.record({ usage: usage(), context: context({ extraUnits: 5 as never }) }))).toEqual({ code: 'AI_TOKENS_INVALID_CONFIG', reason: 'context.extraUnits must be an object' })
  })

  /** Units a stored hold carries that cannot be billed are refused on capture, before the hold settles, and the wallet is untouched. */
  it('refuses a capture whose merged units hold a negative count, and leaves the hold pending', async () => {
    const built = await world()
    const hold = await built.service.hold(context({ extraUnits: { web_search_requests: 3 } }), ESTIMATE)
    const stored = await built.ledgerStore.findById(hold.id)
    ;(stored as { extraUnits?: Record<string, number> }).extraUnits = { web_search_requests: -5 }
    const before = (await built.wallets!.getBalance(WALLET)).nanoUsd
    const outcome = await refusal(() => built.service.capture(hold, CALLER, usage({ web_search_requests: 7 })))
    expect(outcome?.code).toBe('AI_TOKENS_USAGE_MALFORMED')
    expect((await built.ledgerStore.findById(hold.id))?.status).toBe('pending')
    expect((await built.wallets!.getBalance(WALLET)).nanoUsd).toBe(before)
  })

  /** The host is the billing caller: its count replaces the provider's for a unit both name, so a host that passes 0 bills 0 for that unit. */
  it('bills 0 for a unit the host sets to 0, whatever the provider reported', async () => {
    const built = await world({ strict: false })
    const record = await built.service.record({ usage: usage({ web_search_requests: 7 }), context: context({ extraUnits: { web_search_requests: 0 } }) })
    expect(record.surchargeNanoUsd).toBe(0n)
    const other = await built.service.record({ usage: usage({ web_search_requests: 7 }), context: context({}), })
    expect(other.surchargeNanoUsd).toBe(70_000_000n)
  })
})

describe('a tool unit the price lists no rate for is a missing price', () => {
  /** In strict mode it is refused before any debit, as an unpriced model is: a call is never billed for less than it used without saying so. */
  it('refuses it on record() and on capture() in strict mode, and touches neither the wallet nor the ledger', async () => {
    const built = await world()
    const before = (await built.wallets!.getBalance(WALLET)).nanoUsd
    const outcome = await refusal(() => built.service.record({ usage: usage({ code_run: 2 }), context: context({ enforce: true }) }))
    expect(outcome).toEqual({ code: 'AI_TOKENS_PRICE_NOT_FOUND', reason: 'the price lists no rate for the tool unit code_run' })
    expect(await built.ledgerStore.query({ tenantId: 'tenant-1' })).toEqual([])
    const hold = await built.service.hold(context(), ESTIMATE)
    const heldBalance = (await built.wallets!.getBalance(WALLET)).nanoUsd
    expect(await refusal(() => built.service.capture(hold, CALLER, usage({ code_run: 2 })))).toEqual({ code: 'AI_TOKENS_PRICE_NOT_FOUND', reason: 'the price lists no rate for the tool unit code_run' })
    expect((await built.ledgerStore.findById(hold.id))?.status).toBe('pending')
    expect((await built.wallets!.getBalance(WALLET)).nanoUsd).toBe(heldBalance)
    expect(before - heldBalance).toBeGreaterThan(0n)
  })

  /** Without strict mode the call is billed for what has a price, the record says its price is missing and the event is raised. */
  it('bills the priced part and flags the missing price in non-strict mode, on record() and on capture()', async () => {
    const built = await world({ strict: false })
    const recorded = await built.service.record({ usage: usage({ web_search_requests: 7, code_run: 2 }), context: context() })
    expect(recorded.priceMissing).toBe(true)
    expect(recorded.surchargeNanoUsd).toBe(70_000_000n)
    expect(built.events.priceMissing).toHaveBeenCalledTimes(1)
    const hold = await built.service.hold(context(), ESTIMATE)
    const captured = await built.service.capture(hold, CALLER, usage({ web_search_requests: 7, code_run: 2 }))
    expect(captured.priceMissing).toBe(true)
    expect(captured.surchargeNanoUsd).toBe(70_000_000n)
  })

  /** A unit of count 0 needs no rate. */
  it('needs no rate for a unit of 0', async () => {
    const built = await world()
    const record = await built.service.record({ usage: usage({ code_run: 0 }), context: context() })
    expect(record.priceMissing).toBe(false)
  })
})
