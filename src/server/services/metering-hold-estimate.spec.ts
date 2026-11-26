/**
 * A hold is refused before it reserves anything when its estimate is more than a ledger row stores, and a hold replayed under the key of
 * another hold with different tool units is a conflict, as a record replayed with different units is: the second call never silently gets
 * the first one's units.
 * @layer server
 */
import type { AiTokensErrorResponse } from '../../shared'
import { providerPresets } from '../config/provider-presets'
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
    usageReversed: jest.fn(() => Promise.resolve()), settleFailed: jest.fn(() => Promise.resolve()),
    audit: jest.fn(() => Promise.resolve()),
  }
  const telemetry = new TelemetryEmitter(opts.telemetry ?? null)
  const content = new ContentCapture(opts.content !== undefined ? { enabled: true, store: opts.content, ttlSeconds: 3_600 } : { enabled: false })
  const service = new MeteringService(ledger, new PricingService(options, pricingStore), new MarkupResolver(options), options, events, wallets, budgets, now, telemetry, content)
  return { service, ledgerStore, pricingStore, walletStore, budgetStore, wallets, budgets, events, now }
}



async function seed(store: InMemoryPricingStore): Promise<void> {
  await store.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_000_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, unitRates: { web_search_requests: 10_000_000n }, effectiveFrom: new Date(0) })
}

const WALLET = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' } as const
const rated = (inputTokens: number, maxOutputTokens: number): HoldEstimate => ({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens, maxOutputTokens })

async function world(): Promise<Built> {
  const built = build({ wallets: true, strict: true })
  await seed(built.pricingStore)
  await built.wallets!.grant(WALLET, { amountNanoUsd: 100_000_000_000_000n, idempotencyKey: 'grant-1', reason: 'seed' })
  return built
}

/** The code and reason of the typed refusal a call raises, or `undefined` when it does not refuse. */
async function refusal(run: () => Promise<unknown>): Promise<{ code: string; reason: string | undefined; details: Record<string, unknown> | undefined } | undefined> {
  try {
    await run()
  } catch (error) {
    const { error: body } = (error as AiTokensException).getResponse() as AiTokensErrorResponse
    return { code: body.code, reason: body.details?.reason as string | undefined, details: body.details }
  }
  return undefined
}

describe('the estimate of a hold', () => {
  const REASON = 'the tokens of a hold estimate add up to more than a ledger row stores (2147483647)'

  /** A hold whose estimate no ledger row can store is refused before the wallet is charged, and writes no row. */
  it.each([
    ['an input estimate', rated(2_147_483_648, 0)],
    ['an output estimate', rated(0, 2_147_483_648)],
    ['the two together', rated(1_500_000_000, 1_500_000_000)],
    ['a tokens estimate', { tokens: 2_147_483_648 }],
  ])('refuses %s over 2,147,483,647 before it reserves', async (_name, estimate) => {
    const built = await world()
    const before = (await built.wallets!.getBalance(WALLET)).nanoUsd
    const outcome = await refusal(() => built.service.hold(context({ preset: providerPresets.openaiChat, baseModel: 'gpt-5' }), estimate))
    expect(outcome).toMatchObject({ code: 'AI_TOKENS_INVALID_CONFIG', reason: REASON })
    expect((await built.wallets!.getBalance(WALLET)).nanoUsd).toBe(before)
    expect(await built.ledgerStore.query({ tenantId: 'tenant-1' })).toEqual([])
  })

  /** The most a row stores is held. */
  it('holds an estimate of exactly 2,147,483,647 tokens', async () => {
    const built = await world()
    const hold = await built.service.hold(context(), rated(2_147_483_647, 0))
    expect(hold.estimatedTokens).toBe(2_147_483_647)
  })
})

describe('a hold replayed under the same idempotency key', () => {
  const ctx = (extraUnits?: Record<string, number>): MeteringContext => context({ idempotencyKey: 'hold-key-1', ...(extraUnits === undefined ? {} : { extraUnits }) })

  /** The same units, or none and none, is the same request and returns the first hold. */
  it('returns the first hold when the units are the same, in any order, or an empty map stands for none', async () => {
    const built = await world()
    const first = await built.service.hold(ctx({ web_search_requests: 3, code_run: 1 }), rated(1000, 500))
    expect((await built.service.hold(ctx({ code_run: 1, web_search_requests: 3 }), rated(1000, 500))).id).toBe(first.id)
    const none = await built.service.hold(context({ idempotencyKey: 'hold-key-2' }), rated(1000, 500))
    expect((await built.service.hold(context({ idempotencyKey: 'hold-key-2', extraUnits: {} }), rated(1000, 500))).id).toBe(none.id)
  })

  /** A hold that is no longer pending holds the units it was billed for, so a late retry of the original call finds its hold, not a conflict. */
  it('returns the hold of a late retry after it was captured or released, whatever units the settlement stored', async () => {
    const built = await world()
    const caller = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' } } as const
    const captured = await built.service.hold(ctx(undefined), rated(1000, 500))
    await built.service.capture(captured, caller, { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0, serverToolUse: { web_search_requests: 2 } })
    expect((await built.service.hold(ctx(undefined), rated(1000, 500))).id).toBe(captured.id)
    const released = await built.service.hold(context({ idempotencyKey: 'hold-key-3', extraUnits: { web_search_requests: 3 } }), rated(1000, 500))
    await built.service.release(released, caller, 'not needed')
    expect((await built.service.hold(context({ idempotencyKey: 'hold-key-3', extraUnits: { web_search_requests: 3 } }), rated(1000, 500))).id).toBe(released.id)
  })

  /** The units are compared while the hold is pending only: once it is captured or released a replay returns it whatever units it names, and bills nothing. */
  it('returns a captured or released hold for a replay that names other units, and bills nothing for them', async () => {
    const built = await world()
    const caller = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' } } as const
    const captured = await built.service.hold(ctx({ web_search_requests: 3 }), rated(1000, 500))
    const settled = await built.service.capture(captured, caller, { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 })
    const balance = (await built.wallets!.getBalance(WALLET)).nanoUsd
    expect((await built.service.hold(ctx({ web_search_requests: 9, code_run: 4 }), rated(1000, 500))).id).toBe(captured.id)
    expect((await built.wallets!.getBalance(WALLET)).nanoUsd).toBe(balance)
    const released = await built.service.hold(context({ idempotencyKey: 'hold-key-4', extraUnits: { web_search_requests: 3 } }), rated(1000, 500))
    await built.service.release(released, caller, 'not needed')
    const afterRelease = (await built.wallets!.getBalance(WALLET)).nanoUsd
    expect((await built.service.hold(context({ idempotencyKey: 'hold-key-4', extraUnits: { code_run: 7 } }), rated(1000, 500))).id).toBe(released.id)
    expect((await built.wallets!.getBalance(WALLET)).nanoUsd).toBe(afterRelease)
    expect(settled.extraUnits).toEqual({ web_search_requests: 3 })
  })

  /** Two names that collate as equal but are different keys are still one map in any order. */
  it('treats the same units as the same in any insertion order, including names that collate as equal', async () => {
    const built = await world()
    const composed = '\u00e9'
    const decomposed = 'e\u0301'
    const first = await built.service.hold(ctx({ [composed]: 1, [decomposed]: 2 }), rated(1000, 500))
    expect((await built.service.hold(ctx({ [decomposed]: 2, [composed]: 1 }), rated(1000, 500))).id).toBe(first.id)
  })

  /** Different units are a conflict, never a silent replay of the first: a corrected retry would bill the stale units. */
  it.each([
    ['other counts', { web_search_requests: 3 }, { web_search_requests: 4 }],
    ['an added unit', { web_search_requests: 3 }, { web_search_requests: 3, code_run: 1 }],
    ['a removed unit', { web_search_requests: 3, code_run: 1 }, { web_search_requests: 3 }],
    ['units where there were none', undefined, { web_search_requests: 3 }],
    ['none where there were units', { web_search_requests: 3 }, undefined],
    ['a unit renamed to another with the same count', { web_search_requests: 3 }, { code_run: 3 }],
  ])('raises the idempotency conflict for %s', async (_name, first, second) => {
    const built = await world()
    const held = await built.service.hold(ctx(first), rated(1000, 500))
    const balance = (await built.wallets!.getBalance(WALLET)).nanoUsd
    const outcome = await refusal(() => built.service.hold(ctx(second), rated(1000, 500)))
    expect(outcome).toMatchObject({ code: 'AI_TOKENS_IDEMPOTENCY_CONFLICT', details: { tenantId: 'tenant-1', idempotencyKey: 'hold-key-1' } })
    expect((await built.wallets!.getBalance(WALLET)).nanoUsd).toBe(balance)
    expect((await built.ledgerStore.findById(held.id))?.extraUnits).toEqual(first)
  })
})
