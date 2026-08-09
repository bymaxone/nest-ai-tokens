import fc from 'fast-check'
import { Logger } from '@nestjs/common'
import type { AiTokensErrorResponse, Budget, NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { Hold, HoldEstimate, IContentStore, IMarkupPolicy, ITelemetrySink, ITokenizer, MeteringContext } from '../interfaces'
import { ContentCapture } from './content-capture'
import { providerPresets } from '../config/provider-presets'
import { StreamUsageCollector } from '../streaming/stream-usage-collector'
import { TelemetryEmitter } from '../telemetry/otel-emitter'
import { AiTokensException } from '../errors'
import { BudgetService } from './budget.service'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService, type MeteringEventHooks } from './metering.service'
import { PricingService } from './pricing.service'
import { WalletService } from './wallet.service'

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

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

/** A complete normalized usage with one required field removed, returned opaquely. */
function withoutField(field: keyof NormalizedUsage): unknown {
  return Object.fromEntries(Object.entries(normalized()).filter(([key]) => key !== field))
}

/** A complete normalized usage with one field replaced by a wrong-typed value. */
function withField(field: string, value: unknown): unknown {
  return { ...normalized(), [field]: value }
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

/** Seed a gpt-5 chat price ($1.25/M input, $10/M output). */
async function seedGpt5(store: InMemoryPricingStore, model = 'gpt-5'): Promise<void> {
  await store.upsertPrice({
    provider: 'openai',
    model,
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_250_000_000n,
    outputNanoUsdPerMillion: 10_000_000_000n,
    effectiveFrom: new Date(0),
  })
}

/** Grant a wallet for the default user scope. */
async function grant(built: Built, amountNanoUsd: bigint, ownerId = 'u1'): Promise<void> {
  await built.wallets?.grant(
    { tenantId: 'tenant-1', ownerType: 'user', ownerId },
    { amountNanoUsd, idempotencyKey: `grant-${ownerId}-${amountNanoUsd.toString()}`, reason: 'seed' },
  )
}

/** Upsert a tenant-wide budget with the given limits. */
function upsertBudget(built: Built, over: Partial<Budget> = {}): Promise<Budget> {
  return (built.budgets!).upsertBudget({
    tenantId: 'tenant-1',
    scope: { type: 'tenant', id: 'tenant-1' },
    window: 'month',
    limitNanoUsd: 1_000_000_000n,
    ...over,
  })
}

/** The variant-A estimate for a 1000-in / 500-out gpt-5 chat call. */
const ESTIMATE_A: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }

/** Build a MeteringService whose markup is a host policy sensitive to the scope id / feature it receives. */
function buildPolicyService(policy: IMarkupPolicy): { service: MeteringService; pricingStore: InMemoryPricingStore } {
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
  } as ResolvedAiTokensOptions
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  const ledger = new LedgerService(ledgerStore, options)
  const pricing = new PricingService(options, pricingStore)
  const markup = new MarkupResolver({ markup: policy })
  const service = new MeteringService(ledger, pricing, markup, options)
  return { service, pricingStore }
}

describe('MeteringService.record', () => {
  /** Raw usage + preset → a correct posted, observe-only record. */
  it('records raw usage via a preset with markup applied', async () => {
    const built = build({ markup: 4 })
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({
      usage: { model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 500 } },
      preset: providerPresets.openaiChat,
      context: context({ idempotencyKey: 'k1' }),
    })
    expect(record.status).toBe('posted')
    expect(record.enforced).toBe(false)
    expect(record.rawCostNanoUsd).toBe(6_250_000n)
    expect(record.billedCostNanoUsd).toBe(25_000_000n)
    expect(built.events.usageRecorded).toHaveBeenCalledWith(record)
  })

  /** An already-normalized usage is accepted with no preset; the currency, priceMissing flag, and no-op price-missing hook are pinned. */
  it('accepts an already-normalized usage without a preset', async () => {
    const built = build()
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({ usage: normalized({ serviceTier: 'standard' }), context: context() })
    expect(record.rawCostNanoUsd).toBe(6_250_000n)
    // A posted record always carries USD (kills the currency StringLiteral mutation).
    expect(record.currency).toBe('USD')
    // A found rate-table price sets priceMissing false (kills the BooleanLiteral mutation on the rate-table branch)...
    expect(record.priceMissing).toBe(false)
    // ...and MUST NOT fire the price-missing hook (kills the `if (rating.priceMissing)` → true ConditionalExpression mutation).
    expect(built.events.priceMissing).not.toHaveBeenCalled()
  })

  // A caller-supplied occurredAt is a lever on both the price version and the budget
  // window, so it is clamped to a window around the server clock. `strict: false`
  // keeps pricing out of the way — only the stamped occurredAt is under test.
  describe('occurredAt clamping', () => {
    const FIXED_NOW = new Date('2026-06-15T12:00:00.000Z')
    const clock = (): Date => FIXED_NOW
    const SKEW_MS = 5 * 60 * 1000

    it('clamps a back-dated occurredAt to the earliest allowed instant', async () => {
      const built = build({ strict: false, clock })
      const backdated = new Date(FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000)
      const record = await built.service.record({
        usage: normalized(),
        context: context(),
        occurredAt: backdated,
      })
      expect(record.occurredAt.getTime()).toBe(FIXED_NOW.getTime() - SKEW_MS)
    })

    it('clamps a future occurredAt to the latest allowed instant', async () => {
      const built = build({ strict: false, clock })
      const future = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000)
      const record = await built.service.record({
        usage: normalized(),
        context: context(),
        occurredAt: future,
      })
      expect(record.occurredAt.getTime()).toBe(FIXED_NOW.getTime() + SKEW_MS)
    })

    it('preserves an occurredAt within the allowed window', async () => {
      const built = build({ strict: false, clock })
      const within = new Date(FIXED_NOW.getTime() - 60 * 1000)
      const record = await built.service.record({
        usage: normalized(),
        context: context(),
        occurredAt: within,
      })
      expect(record.occurredAt.getTime()).toBe(within.getTime())
    })

    it('falls back to the server clock when occurredAt is absent', async () => {
      const built = build({ strict: false, clock })
      const record = await built.service.record({ usage: normalized(), context: context() })
      expect(record.occurredAt.getTime()).toBe(FIXED_NOW.getTime())
    })

    it('falls back to the server clock when occurredAt is an invalid Date', async () => {
      const built = build({ strict: false, clock })
      const record = await built.service.record({
        usage: normalized(),
        context: context(),
        occurredAt: new Date(Number.NaN),
      })
      expect(record.occurredAt.getTime()).toBe(FIXED_NOW.getTime())
    })
  })

  /** Un-normalizable input is rejected as UNKNOWN_PROVIDER. */
  it.each([null, 'nope', { prompt_tokens: 1 }, { provider: 'x' }, { provider: 'x', inputTokens: 1 }])(
    'rejects un-normalizable input %p as UNKNOWN_PROVIDER',
    async (usage) => {
      const error = await build().service.record({ usage, context: context() }).catch((e: unknown) => e)
      expect(codeOf(error)).toBe('AI_TOKENS_UNKNOWN_PROVIDER')
    },
  )

  /** An object missing any required NormalizedUsage field is not accepted as normalized. */
  it.each([
    ['provider', withoutField('provider')],
    ['model', withoutField('model')],
    ['operation', withoutField('operation')],
    ['inputTokens', withoutField('inputTokens')],
    ['imageOutTokens', withoutField('imageOutTokens')],
  ])('rejects a normalized usage missing %s', async (_field, usage) => {
    const error = await build().service.record({ usage, context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_UNKNOWN_PROVIDER')
  })

  /** An object mistyping a required field is rejected. */
  it.each([
    ['operation not in the catalog', withField('operation', 'not-an-operation')],
    ['inputTokens not a number', withField('inputTokens', '1000')],
    ['outputTokens NaN', withField('outputTokens', Number.NaN)],
    ['cacheReadTokens Infinity', withField('cacheReadTokens', Number.POSITIVE_INFINITY)],
  ])('rejects a normalized usage with %s', async (_case, usage) => {
    const error = await build().service.record({ usage, context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_UNKNOWN_PROVIDER')
  })

  /** When no tags are provided, the record's tags defaults to [] — kills ArrayDeclaration mutation. */
  it('defaults tags to an empty array when context has no tags', async () => {
    const built = build()
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({ usage: normalized(), context: context() }) // no tags
    expect(record.tags).toEqual([])
  })

  /** All attribution fields land on the record. */
  it('persists every attribution field', async () => {
    const built = build()
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({
      usage: normalized(),
      context: context({
        beneficiary: { type: 'user', id: 'client-1' },
        requestedBy: 'actor-1',
        tags: ['team:research'],
        extraUnits: { web_search_requests: 2 },
        correlationId: 'corr-1',
        isSystemCost: true,
        systemCostCategory: 'retry',
      }),
    })
    expect(record.beneficiary).toEqual({ type: 'user', id: 'client-1' })
    expect(record.requestedBy).toBe('actor-1')
    expect(record.tags).toEqual(['team:research'])
    expect(record.extraUnits).toEqual({ web_search_requests: 2 })
    expect(record.isSystemCost).toBe(true)
    expect(record.systemCostCategory).toBe('retry')
    // A supplied correlationId must land on the record — kills the EqualityOperator (!== → ===) and
    // ObjectLiteral ({...} → {}) mutations on the correlationId spread, both of which drop it when defined.
    expect(record.correlationId).toBe('corr-1')
  })

  /** A non-strict rate miss records zero cost + priceMissing + fires the hook. */
  it('records a price-missing row and fires the price-missing hook', async () => {
    const built = build({ strict: false })
    const record = await built.service.record({ usage: normalized({ model: 'unseeded' }), context: context() })
    expect(record.priceMissing).toBe(true)
    expect(record.rawCostNanoUsd).toBe(0n)
    expect(built.events.priceMissing).toHaveBeenCalledWith(record)
  })

  /** Strict mode propagates PRICE_NOT_FOUND on a miss. */
  it('propagates PRICE_NOT_FOUND in strict mode', async () => {
    const error = await build({ strict: true }).service.record({ usage: normalized({ model: 'unseeded' }), context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_PRICE_NOT_FOUND')
  })

  /** Provider-reported mode uses the reported cost and applies markup. */
  it('rates in provider-reported mode with markup', async () => {
    const built = build({ markup: 4, ratingMode: 'provider-reported' })
    const record = await built.service.record({
      usage: normalized({ provider: 'openrouter', providerReportedCostNanoUsd: 5_000_000n }),
      context: context(),
    })
    expect(record.rawCostNanoUsd).toBe(5_000_000n)
    expect(record.billedCostNanoUsd).toBe(20_000_000n)
    // Provider-reported rating is never price-missing — kills the BooleanLiteral mutation on that branch.
    expect(record.priceMissing).toBe(false)
    expect(built.events.priceMissing).not.toHaveBeenCalled()
  })

  /** Provider-reported mode without a reported cost is malformed. */
  it('rejects provider-reported mode without a reported cost', async () => {
    const error = await build({ ratingMode: 'provider-reported' }).service.record({ usage: normalized(), context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** A context ratingMode overrides the module default. */
  it('lets the context override the rating mode', async () => {
    const record = await build({ markup: 2, ratingMode: 'rate-table' }).service.record({
      usage: normalized({ providerReportedCostNanoUsd: 3_000_000n }),
      context: context({ ratingMode: 'provider-reported' }),
    })
    expect(record.billedCostNanoUsd).toBe(6_000_000n)
  })

  /** baseModel resolves the price and lands as requestedModel. */
  it('resolves the price via baseModel and records requestedModel', async () => {
    const built = build()
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({ usage: normalized({ model: 'my-deployment' }), context: context({ baseModel: 'gpt-5' }) })
    expect(record.requestedModel).toBe('gpt-5')
    expect(record.rawCostNanoUsd).toBe(6_250_000n)
  })

  /** enforce: true without wallets/budgets is rejected. */
  it('rejects enforce: true without wallets/budgets', async () => {
    const error = await build().service.record({ usage: normalized(), context: context({ enforce: true }) }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** enforce: true debits the wallet and consumes the budget after the ledger write. */
  it('enforces post-hoc: debits the wallet and consumes the budget', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitNanoUsd: 100_000_000n, limitTokens: 100_000, limitCount: 100 })
    const record = await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    expect(record.enforced).toBe(true)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent.count).toBe(1)
    expect(budget?.spent.nanoUsd).toBe(6_250_000n)
  })

  /** Post-hoc enforcement can throw AFTER the ledger persisted the record (documented trade-off). */
  it('persists the record then throws when post-hoc credit is insufficient', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 1_000_000n)
    const error = await built.service.record({ usage: normalized(), context: context({ enforce: true, idempotencyKey: 'ek' }) }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')
    expect(await built.ledgerStore.findByIdempotencyKey('tenant-1', 'ek')).not.toBeNull()
  })

  /** isSystemCost enforce never touches the wallet or budget. */
  it('skips wallet/budget for an isSystemCost enforced record', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built)
    await built.service.record({ usage: normalized(), context: context({ enforce: true, isSystemCost: true }) })
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** A normalizer that throws a plain error becomes USAGE_MALFORMED. */
  it('wraps a plain normalizer failure as USAGE_MALFORMED', async () => {
    const normalizer = (): NormalizedUsage => {
      throw new Error('cannot read usage')
    }
    const error = await build().service.record({ usage: {}, normalizer, context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** With no injected hooks, the default no-op hooks run for both events. */
  it('uses no-op event hooks by default', async () => {
    const built = build({ strict: false })
    await seedGpt5(built.pricingStore)
    const service = new MeteringService(
      new LedgerService(built.ledgerStore, { ratingMode: 'rate-table', markup: 1, ledger: { hashChain: false }, pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} } } as ResolvedAiTokensOptions),
      new PricingService({ ratingMode: 'rate-table', markup: 1, pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} } } as ResolvedAiTokensOptions, built.pricingStore),
      new MarkupResolver({ markup: 1 }),
      { ratingMode: 'rate-table' },
    )
    expect((await service.record({ usage: normalized(), context: context() })).status).toBe('posted')
    expect((await service.record({ usage: normalized({ model: 'unseeded' }), context: context() })).priceMissing).toBe(true)
  })

  /** A normalizer that throws a typed error is rethrown unchanged. */
  it('rethrows a typed normalizer error', async () => {
    const normalizer = (): NormalizedUsage => {
      throw new AiTokensException('AI_TOKENS_STORE_ERROR')
    }
    const error = await build().service.record({ usage: {}, normalizer, context: context() }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_STORE_ERROR')
  })
})

describe('MeteringService.estimateCost', () => {
  /** Estimates the raw and billed cost with zero side effects. */
  it('estimates raw and billed cost without side effects', async () => {
    const built = build({ markup: 4 })
    await seedGpt5(built.pricingStore)
    const estimate = await built.service.estimateCost({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500, scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' })
    expect(estimate.rawCostNanoUsd).toBe(6_250_000n)
    expect(estimate.billedCostNanoUsd).toBe(25_000_000n)
    expect(built.ledgerStore.all()).toHaveLength(0)
  })

  /** A non-strict rate miss estimates zero. */
  it('estimates zero on a non-strict rate miss', async () => {
    const estimate = await build({ strict: false }).service.estimateCost({ provider: 'openai', model: 'unseeded', operation: 'chat', inputTokens: 10, maxOutputTokens: 10 })
    expect(estimate.rawCostNanoUsd).toBe(0n)
  })

  /** With no scope, the neutral ESTIMATE_SCOPE carries an EMPTY id — a markup policy sees `''`, not a placeholder string. */
  it('resolves markup against the empty neutral scope id when no scope is given', async () => {
    const seen: string[] = []
    const policy: IMarkupPolicy = { resolve: (ctx): number => (seen.push(ctx.scope.id), ctx.scope.id === '' ? 2 : 5) }
    const { service, pricingStore } = buildPolicyService(policy)
    await seedGpt5(pricingStore)
    const estimate = await service.estimateCost({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 })
    // ESTIMATE_SCOPE.id === '' → policy multiplier 2 → 6_250_000 × 2. Mutating '' to any other literal → ×5.
    expect(seen).toContain('')
    expect(estimate.billedCostNanoUsd).toBe(12_500_000n)
  })

  /** A supplied feature reaches the markup policy on the estimate path; omitting the spread would drop it to undefined. */
  it('forwards a provided feature to the markup policy when estimating', async () => {
    const seen: (string | undefined)[] = []
    const policy: IMarkupPolicy = { resolve: (ctx): number => (seen.push(ctx.feature), ctx.feature === 'chat.reply' ? 2 : 5) }
    const { service, pricingStore } = buildPolicyService(policy)
    await seedGpt5(pricingStore)
    const estimate = await service.estimateCost({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500, scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' })
    // feature 'chat.reply' reaches the policy → ×2 → 12_500_000n. EqualityOperator (=== undefined) or ObjectLiteral ({}) → feature dropped → undefined → ×5.
    expect(seen).toContain('chat.reply')
    expect(estimate.billedCostNanoUsd).toBe(12_500_000n)
  })
})

describe('MeteringService.hold', () => {
  /** Variant A rates against the estimate's model and reserves wallet + budget. */
  it('reserves wallet and budget for a { provider, model } estimate', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const hold = await built.service.hold(context(), ESTIMATE_A)
    expect(hold.estimatedCostNanoUsd).toBe(6_250_000n)
    expect(hold.estimatedTokens).toBe(1500)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent).toEqual({ nanoUsd: 6_250_000n, tokens: 1500, count: 1 })
    const pending = built.ledgerStore.all()[0]
    expect(pending?.status).toBe('pending')
    expect(pending?.enforced).toBe(true)
    // A pending hold row is always USD and never price-missing — kills the currency StringLiteral and the priceMissing BooleanLiteral mutations in appendPending.
    expect(pending?.currency).toBe('USD')
    expect(pending?.priceMissing).toBe(false)
  })

  /** Variant B ({ tokens }) requires a preset and rates against baseModel's input rate. */
  it('rates a { tokens } estimate at the preset model input rate', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat, baseModel: 'gpt-5' }), { tokens: 2000 })
    expect(hold.estimatedTokens).toBe(2000)
    expect(hold.estimatedCostNanoUsd).toBe(2_500_000n)
  })

  /** Variant B without a preset is INVALID_CONFIG. */
  it('rejects a { tokens } estimate without a preset', async () => {
    const error = await build().service.hold(context(), { tokens: 100 }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** Variant B without a baseModel reserves quota only ($0 cost estimate). */
  it('reserves quota only for a { tokens } estimate without a baseModel', async () => {
    const built = build({ budgets: true })
    await upsertBudget(built, { limitTokens: 100_000 })
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat }), { tokens: 500 })
    expect(hold.estimatedCostNanoUsd).toBe(0n)
    expect(hold.estimatedTokens).toBe(500)
  })

  /** Variant C ({ amountNanoUsd }) is pre-rated raw and marked up. */
  it('marks up a pre-rated { amountNanoUsd } estimate', async () => {
    const built = build({ markup: 2, wallets: true })
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat }), { amountNanoUsd: 4_000_000n })
    expect(hold.estimatedCostNanoUsd).toBe(8_000_000n)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(92_000_000n)
  })

  /** A JSON round-trip of a Hold preserves capture-ability. */
  it('produces a plain, JSON-serializable Hold', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const roundTripped = JSON.parse(JSON.stringify({ ...hold, estimatedCostNanoUsd: hold.estimatedCostNanoUsd.toString() })) as Record<string, unknown>
    expect(roundTripped.id).toBe(hold.id)
    const captured = await built.service.capture({ ...hold }, normalized())
    expect(captured.status).toBe('posted')
  })

  /** An isSystemCost hold skips wallet/budget/counter entirely. */
  it('skips wallet/budget for an isSystemCost hold', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built)
    const hold = await built.service.hold(context({ isSystemCost: true, systemCostCategory: 'retry' }), ESTIMATE_A)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
    const pending = await built.ledgerStore.findById(hold.id)
    expect(pending?.enforced).toBe(false)
    expect(pending?.systemCostCategory).toBe('retry')
    await built.service.release(hold, 'system release')
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** An isSystemCost hold whose pending insert fails skips compensation and rethrows. */
  it('does not compensate an isSystemCost hold on a failed insert', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('insert down'))
    await expect(built.service.hold(context({ isSystemCost: true }), ESTIMATE_A)).rejects.toThrow('insert down')
    // isSystemCost never reserved, so it must not compensate. The `if (!isSystemCost)` guard → true (CE) would
    // wrongly refund the wallet, inflating the balance above the granted amount.
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** A wallet shortfall compensates the budget consumption and throws. */
  it('compensates the budget when the wallet debit fails', async () => {
    const built = build({ wallets: true, budgets: true, overdraft: 0n })
    await seedGpt5(built.pricingStore)
    await grant(built, 1_000_000n)
    await upsertBudget(built, { limitNanoUsd: 100_000_000n })
    const error = await built.service.hold(context(), ESTIMATE_A).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent.nanoUsd).toBe(0n)
  })

  /** A budget shortfall throws before any wallet debit. */
  it('throws a budget error without debiting the wallet on a quota shortfall', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitTokens: 100 })
    const error = await built.service.hold(context(), ESTIMATE_A).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_QUOTA_EXCEEDED')
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** A repeated hold with the same idempotency key returns the same hold without re-reserving. */
  it('is idempotent on a repeated idempotency key', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const first = await built.service.hold(context({ idempotencyKey: 'h1' }), ESTIMATE_A)
    const second = await built.service.hold(context({ idempotencyKey: 'h1' }), ESTIMATE_A)
    expect(second.id).toBe(first.id)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
  })

  /** A pending-insert failure compensates the reservation. */
  it('compensates the reservation when the pending insert fails', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitNanoUsd: 100_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('store down'))
    await expect(built.service.hold(context(), ESTIMATE_A)).rejects.toThrow('store down')
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent.nanoUsd).toBe(0n)
  })

  /** Two independent holds for one feature reserve separately. */
  it('composes two independent holds', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await built.service.hold(context(), ESTIMATE_A)
    await built.service.hold(context(), ESTIMATE_A)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(87_500_000n)
    expect(built.ledgerStore.all().filter((r) => r.status === 'pending')).toHaveLength(2)
  })
})

describe('MeteringService.capture', () => {
  /** Capture equal to the estimate leaves the net reservation unchanged. */
  it('settles a capture equal to the estimate', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const record = await built.service.capture(hold, normalized())
    expect(record.status).toBe('posted')
    expect(record.billedCostNanoUsd).toBe(6_250_000n)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent).toEqual({ nanoUsd: 6_250_000n, tokens: 1500, count: 1 })
  })

  /** Capture below the estimate refunds the wallet and releases the budget delta. */
  it('refunds the wallet when actuals are below the estimate', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.capture(hold, normalized({ inputTokens: 500, outputTokens: 250 }))
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(96_875_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent).toEqual({ nanoUsd: 3_125_000n, tokens: 750, count: 1 })
  })

  /** Capture above the estimate tops up the wallet debit and the budget window. */
  it('tops up when actuals exceed the estimate', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.capture(hold, normalized({ inputTokens: 2000, outputTokens: 1000 }))
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(87_500_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent).toEqual({ nanoUsd: 12_500_000n, tokens: 3000, count: 1 })
  })

  /** Double capture returns the same posted record without doubling side effects. */
  it('is idempotent on a repeated capture', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const first = await built.service.capture(hold, normalized())
    const second = await built.service.capture(hold, normalized())
    expect(second.id).toBe(first.id)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
  })

  /** A repeat capture short-circuits at the status guard and NEVER reads the second usage (even malformed). */
  it('returns the settled record on a repeat capture without reading the second usage', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const first = await built.service.capture(hold, normalized())
    // With the `status !== 'pending'` guard → false (CE), the repeat would fall through and throw on this malformed usage.
    const second = await built.service.capture(hold, { not: 'usage' })
    expect(second.id).toBe(first.id)
    expect(second.status).toBe('posted')
  })

  /** Capture after release is a 409 conflict. */
  it('rejects capture after release with HOLD_ALREADY_SETTLED', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.release(hold, 'abort')
    const error = await built.service.capture(hold, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_ALREADY_SETTLED')
  })

  /** hold.expiresAt must be createdAt + ttlSeconds × 1000ms (not ÷ 1000ms) — kills ArithmeticOperator × vs ÷ mutation. */
  it('sets hold expiresAt to ttlSeconds × 1000 ms after creation — not ÷ 1000', async () => {
    const ttlSeconds = 60
    const built = build({ wallets: true, ttlSeconds })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const beforeMs = Date.now()
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const afterMs = Date.now()
    const expectedMin = beforeMs + ttlSeconds * 1_000
    const expectedMax = afterMs + ttlSeconds * 1_000
    // With * mutation: expiresAt ≈ now + 60000ms (≥ 59 s in the future)
    // With / mutation: expiresAt ≈ now + 0.06ms (far less than 59 s)
    expect(hold.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin)
    expect(hold.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax)
  })

  /** Capture of an expired-then-reclaimed hold is a 410. */
  it('rejects capture of an expired released hold with HOLD_EXPIRED', async () => {
    let clock = new Date(Date.now() + 3_600_000)
    const built = build({ wallets: true, ttlSeconds: 60, clock: () => clock })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    clock = new Date(clock.getTime() + 3_600_000)
    await built.service.release(hold, 'expired')
    const error = await built.service.capture(hold, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_EXPIRED')
  })

  /** A released hold captured WITHIN its TTL is a 409, not a 410 — pins ttlSeconds × 1000 (not ÷ 1000). */
  it('reports an unexpired released hold as already-settled, not expired', async () => {
    // Freeze the injected clock an hour ahead of real time so the wallet grant (whose effectiveAt is stamped from
    // the real clock) is always already-effective — otherwise the hold's conditionalDebit flakes under load.
    let clock = new Date(Date.now() + 3_600_000)
    const built = build({ wallets: true, ttlSeconds: 60, clock: () => clock })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const record = await built.ledgerStore.findById(hold.id)
    await built.service.release(hold, 'abort')
    // Inject a clock 30 s past the record's real createdAt — inside the 60 s TTL. With `× 1000` the hold has NOT
    // expired (expiry = createdAt + 60_000 ms); a `÷ 1000` mutation collapses the TTL to ~0.06 ms → false expiry.
    clock = new Date(record!.createdAt.getTime() + 30_000)
    const error = await built.service.capture(hold, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_ALREADY_SETTLED')
  })

  /** A reversed hold record is already-settled (409), never routed through the released-branch expiry check. */
  it('treats a reversed hold record as already-settled rather than expired', async () => {
    // Freeze the injected clock an hour ahead of real time so the wallet grant (whose effectiveAt is stamped from
    // the real clock) is always already-effective — otherwise the hold's conditionalDebit flakes under load.
    let clock = new Date(Date.now() + 3_600_000)
    const built = build({ wallets: true, ttlSeconds: 60, clock: () => clock })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.capture(hold, normalized())
    const record = await built.ledgerStore.findById(hold.id)
    await built.service.reverse(hold.id, 'refund') // posted → reversed
    // Move the injected clock far past the (real-clock) TTL. A 'released' record would read as expired here;
    // a 'reversed' one must NOT enter that branch. The `status === 'released'` → true (CE) mutation would
    // reclassify this as HOLD_EXPIRED.
    clock = new Date(record!.createdAt.getTime() + 3_600_000)
    const error = await built.service.capture(hold, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_ALREADY_SETTLED')
  })

  /** A hold from another tenant captured under the caller's tenant is 404. */
  it('rejects a cross-tenant hold with HOLD_NOT_FOUND', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const error = await built.service.capture({ ...hold, tenantId: 'other' }, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_NOT_FOUND')
  })

  /** A missing hold id is 404. */
  it('rejects an unknown hold id with HOLD_NOT_FOUND', async () => {
    const built = build()
    const hold: Hold = { id: 'missing', tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, estimatedTokens: 0, estimatedCostNanoUsd: 0n, expiresAt: new Date() }
    const error = await built.service.capture(hold, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_NOT_FOUND')
  })

  /** Malformed capture usage is 422. */
  it('rejects malformed capture usage', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const error = await built.service.capture(hold, { not: 'usage' }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** Markup is re-resolved at capture against actuals; priceVersionId is set from occurredAt. */
  it('re-resolves markup at capture and sets priceVersionId', async () => {
    const built = build({ markup: 3, wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const record = await built.service.capture(hold, normalized({ inputTokens: 1000, outputTokens: 500 }))
    expect(record.markupMultiplier).toBe(3)
    expect(record.billedCostNanoUsd).toBe(18_750_000n)
    expect(record.priceVersionId).not.toBeNull()
  })
})

describe('MeteringService.release', () => {
  /** Release restores wallet and budget in full and emits hold.released. */
  it('restores wallet and budget in full', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.release(hold, 'user aborted')
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent).toEqual({ nanoUsd: 0n, tokens: 0, count: 0 })
    expect(built.events.holdReleased).toHaveBeenCalledWith(expect.objectContaining({ id: hold.id }), 'user aborted', false)
  })

  /** Releasing twice restores only once. */
  it('restores only once when released twice', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.release(hold, 'a')
    await built.service.release(hold, 'b')
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
    expect(built.events.holdReleased).toHaveBeenCalledTimes(1)
  })

  /** Release after capture is a no-op warning and never bills. */
  it('is a no-op warning after capture', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.capture(hold, normalized())
    // The posted-hold branch fires a warn and returns; the `record.status === 'posted'` → false (CE)
    // mutation would skip that branch (no warn), so we assert the warn is emitted.
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await built.service.release(hold, 'late')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
    expect(built.events.holdReleased).not.toHaveBeenCalled()
  })

  /** Release of a cross-tenant hold is 404. */
  it('rejects a cross-tenant hold', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const error = await built.service.release({ ...hold, scope: { type: 'user', id: 'other' } }, 'x').catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_NOT_FOUND')
  })

  /** A hold whose scope id matches but whose scope TYPE differs is a 404 — pins the scope-type comparison. */
  it('rejects a same-id different-type scope hold', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A) // scope { type: 'user', id: 'u1' }
    // Same id 'u1', different type 'key': sameScope must be false. The `a.type === b.type` → true (CE) mutation
    // would ignore the type mismatch and let the release proceed instead of throwing.
    const error = await built.service.release({ ...hold, scope: { type: 'key', id: 'u1' } }, 'x').catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_NOT_FOUND')
  })

  /** A repeat release of an already-released hold does NOT re-issue a ledger transition (the `!== 'pending'` guard returns early). */
  it('does not re-transition an already-released hold on a repeat release', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.release(hold, 'first')
    const transitionSpy = jest.spyOn(built.ledgerStore, 'transition')
    // With the `record.status !== 'pending'` guard → false (CE), the second release would fall through and call
    // transition(pending → released) again on the already-released record.
    await built.service.release(hold, 'second')
    expect(transitionSpy).not.toHaveBeenCalled()
  })
})

describe('MeteringService.meter', () => {
  /** The happy path returns the result and settled usage. */
  it('holds, runs, and captures', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const { result, usage } = await built.service.meter(() => Promise.resolve({ usage: normalized() }), context({ preset: providerPresets.openaiChat }), (r) => r.usage, ESTIMATE_A)
    expect(result.usage.provider).toBe('openai')
    expect(usage.status).toBe('posted')
  })

  /** A throwing function releases the hold and rethrows. */
  it('releases the hold when the function throws', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const boom = new Error('llm failed')
    await expect(built.service.meter(() => Promise.reject(boom), context(), (r: { usage: unknown }) => r.usage, ESTIMATE_A)).rejects.toBe(boom)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
    // The release carries the fixed 'metered function threw' reason — kills the StringLiteral → "" mutation.
    expect(built.events.holdReleased).toHaveBeenCalledWith(expect.anything(), 'metered function threw', false)
  })

  /** A capture failure releases the hold and rethrows (no stranded reservation). */
  it('releases the hold when capture fails', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const error = await built.service.meter(() => Promise.resolve({ not: 'usable' }), context(), (r) => r, ESTIMATE_A).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
    // The cleanup release carries the fixed 'capture failed' reason — kills the StringLiteral → "" mutation.
    expect(built.events.holdReleased).toHaveBeenCalledWith(expect.anything(), 'capture failed', false)
  })

  /** A release failure during capture cleanup is swallowed; the original error propagates. */
  it('propagates the capture error even when the cleanup release fails', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    jest.spyOn(built.service, 'release').mockRejectedValue(new Error('release down'))
    const error = await built.service.meter(() => Promise.resolve({ not: 'usable' }), context(), (r) => r, ESTIMATE_A).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** Without an estimate, meter runs record({ enforce: true }). */
  it('enforces post-hoc without an estimate', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const { usage } = await built.service.meter(() => Promise.resolve({ usage: normalized() }), context(), (r) => r.usage)
    expect(usage.enforced).toBe(true)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
  })
})

describe('MeteringService.reverse', () => {
  /** Reversing an enforced record restores wallet + all three budget dimensions. */
  it('restores wallet and budget for an enforced record', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const record = await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    await built.service.reverse(record.id, 'refund')
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent).toEqual({ nanoUsd: 0n, tokens: 0, count: 0 })
    expect(built.events.usageReversed).toHaveBeenCalled()
    expect(built.events.audit).toHaveBeenCalledWith('ai_tokens.usage.reversed', expect.objectContaining({ reason: 'refund' }))
  })

  /** Reversing a non-enforced record touches only the ledger. */
  it('reverses a non-enforced record without wallet effects', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const record = await built.service.record({ usage: normalized(), context: context() })
    const compensating = await built.service.reverse(record.id, 'admin')
    expect(compensating.billedCostNanoUsd).toBe(-6_250_000n)
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** A second reverse of the same record is a conflict. */
  it('rejects a double reverse', async () => {
    const built = build()
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({ usage: normalized(), context: context() })
    await built.service.reverse(record.id, 'once')
    const error = await built.service.reverse(record.id, 'twice').catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
  })
})

describe('MeteringService.getStatus', () => {
  /** Reflects wallet + budgets with access granted. */
  it('reports wallet balance and budgets', async () => {
    const built = build({ wallets: true, budgets: true, overdraft: 5_000_000n })
    await grant(built, 50_000_000n)
    await upsertBudget(built, { limitNanoUsd: 100_000_000n })
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    expect(status.hasAccess).toBe(true)
    expect(status.wallet?.balanceNanoUsd).toBe(50_000_000n)
    expect(status.wallet?.overdraftRemainingNanoUsd).toBe(5_000_000n)
    expect(status.budgets).toHaveLength(1)
  })

  /** A depleted wallet blocks access with blockedBy: 'wallet'. */
  it('blocks on an empty wallet', async () => {
    const built = build({ wallets: true })
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    expect(status.hasAccess).toBe(false)
    expect(status.blockedBy).toBe('wallet')
  })

  /** An exhausted hard budget blocks access with blockedBy: 'budget'. */
  it('blocks on an exhausted hard budget', async () => {
    const built = build({ wallets: true, budgets: true })
    await grant(built, 50_000_000n)
    await upsertBudget(built, { limitCount: 1 })
    await seedGpt5(built.pricingStore)
    await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    expect(status.hasAccess).toBe(false)
    expect(status.blockedBy).toBe('budget')
  })

  /** The wallet section is absent when wallets are disabled. */
  it('omits the wallet section when wallets are disabled', async () => {
    const built = build({ budgets: true })
    await upsertBudget(built)
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    expect(status.wallet).toBeUndefined()
    expect(status.hasAccess).toBe(true)
  })

  /** A 'key' scope reports budgets only (keys spend their owner's wallet). */
  it('omits the wallet section for a key scope', async () => {
    const built = build({ wallets: true })
    const status = await built.service.getStatus('tenant-1', { type: 'key', id: 'k1' })
    expect(status.wallet).toBeUndefined()
  })

  /** With remaining overdraft the wallet is not blocked — kills balance+overdraft vs balance-overdraft ArithOp mutation. */
  it('allows access when balance is zero but overdraft is available', async () => {
    const built = build({ wallets: true, overdraft: 5_000_000n })
    // Grant exactly what we spend so balance = 0 after debit, but overdraft = 5M still available.
    await grant(built, 10_000_000n)
    await built.wallets!.debit({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, {
      amountNanoUsd: 10_000_000n,
      idempotencyKey: 'spend-all',
      reason: 'deplete-grant',
    })
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    // balance = 0, overdraftRemaining = 5M; balance + overdraftRemaining = 5M > 0 → not blocked.
    // With the - mutation: 0 - 5M = -5M <= 0 → wrongly blocked.
    expect(status.hasAccess).toBe(true)
    expect(status.wallet?.balanceNanoUsd).toBe(0n)
    expect(status.wallet?.overdraftRemainingNanoUsd).toBe(5_000_000n)
  })

  /** budgets.some (not .every) is used — blocks when ONE budget exhausted out of two. */
  it('blocks when at least one hard budget is exhausted even if another has headroom', async () => {
    const built = build({ wallets: true, budgets: true })
    await grant(built, 100_000_000n)
    await seedGpt5(built.pricingStore)
    // First budget: count limit 1 (will be exhausted after one record)
    await built.budgets!.upsertBudget({ tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, window: 'month', limitCount: 1 })
    // Second budget: very high cost limit (still has headroom)
    await built.budgets!.upsertBudget({ tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, window: 'month', limitNanoUsd: 1_000_000_000_000n })
    await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    // some(): true because first budget is exhausted; every() would be false (second still has headroom)
    expect(status.hasAccess).toBe(false)
    expect(status.blockedBy).toBe('budget')
  })

  /** An EXHAUSTED soft (allow) budget never hard-blocks — the `policy !== 'block'` early return must stand. */
  it('does not block on an exhausted soft budget', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { policy: 'allow', limitCount: 1 })
    await built.service.record({ usage: normalized(), context: context({ enforce: true }) }) // spent.count → 1 (== limit)
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    // Original: `policy !== 'block'` → return false (allow never hard-blocks). CE → false skips it and, seeing
    // spent.count 1 >= limit 1, would wrongly report a hard block.
    expect(status.hasAccess).toBe(true)
  })

  /** A block budget with TOKEN headroom is not hard-exhausted — pins the `spent.tokens >= limit.tokens` check. */
  it('does not hard-block a block budget that still has token headroom', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitTokens: 100_000 })
    await built.service.record({ usage: normalized(), context: context({ enforce: true }) }) // 1500 tokens ≪ 100_000
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    // Original: 1500 >= 100_000 is false → not exhausted. The token-clause → true (CE) would wrongly hard-block.
    expect(status.hasAccess).toBe(true)
  })

  /** A block budget with COUNT headroom is not hard-exhausted — pins the `spent.count >= limit.count` check. */
  it('does not hard-block a block budget that still has count headroom', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitCount: 100 })
    await built.service.record({ usage: normalized(), context: context({ enforce: true }) }) // count 1 ≪ 100
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    // Original: 1 >= 100 is false → not exhausted. The count-clause → true (CE) would wrongly hard-block.
    expect(status.hasAccess).toBe(true)
  })
})

describe('MeteringService coverage edges', () => {
  /** A preset normalizer that throws a plain error becomes USAGE_MALFORMED at capture. */
  it('wraps a throwing capture normalizer as USAGE_MALFORMED', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const preset = { provider: 'openai' as const, ratingMode: 'rate-table' as const, normalizer: (): NormalizedUsage => { throw new Error('boom') } }
    const error = await built.service.capture(hold, {}, preset).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** A preset normalizer that throws a typed error is rethrown unchanged at capture. */
  it('rethrows a typed capture normalizer error', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const preset = { provider: 'openai' as const, ratingMode: 'rate-table' as const, normalizer: (): NormalizedUsage => { throw new AiTokensException('AI_TOKENS_STORE_ERROR') } }
    const error = await built.service.capture(hold, {}, preset).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_STORE_ERROR')
  })

  /** A capture that loses the settle race (transition null) re-checks the reloaded record. */
  it('re-checks a hold that lost the settle race', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    jest.spyOn(built.ledgerStore, 'transition').mockResolvedValueOnce(null)
    const error = await built.service.capture(hold, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_ALREADY_SETTLED')
  })

  /** A capture whose record vanishes mid-settle fails HOLD_NOT_FOUND. */
  it('fails HOLD_NOT_FOUND when the record vanishes mid-settle', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    const pending = await built.ledgerStore.findById(hold.id)
    jest.spyOn(built.ledgerStore, 'transition').mockResolvedValueOnce(null)
    jest.spyOn(built.ledgerStore, 'findById').mockResolvedValueOnce(pending).mockResolvedValueOnce(null)
    const error = await built.service.capture(hold, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_NOT_FOUND')
  })

  /** Rollback failures during hold compensation are logged, never masking the insert error. */
  it('logs rollback failures during hold compensation', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitNanoUsd: 100_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('insert down'))
    jest.spyOn(built.wallets!, 'refund').mockRejectedValueOnce(new Error('refund down'))
    jest.spyOn(built.budgets!, 'release').mockRejectedValueOnce(new Error('release down'))
    await expect(built.service.hold(context(), ESTIMATE_A)).rejects.toThrow('insert down')
  })

  /** Reversal store failures are logged; the reversal still completes. */
  it('logs partial store failures during reversal', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const record = await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    jest.spyOn(built.wallets!, 'refund').mockRejectedValueOnce(new Error('refund down'))
    jest.spyOn(built.budgets!, 'release').mockRejectedValueOnce(new Error('release down'))
    const compensating = await built.service.reverse(record.id, 'refund')
    expect(compensating.reversesRecordId).toBe(record.id)
  })

  /** The default no-op hooks run for release and reverse. */
  it('uses no-op hooks for release and reverse', async () => {
    const ledgerStore = new InMemoryLedgerStore()
    const pricingStore = new InMemoryPricingStore()
    await seedGpt5(pricingStore)
    const options = { ratingMode: 'rate-table', markup: 1, ledger: { hashChain: false }, pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} }, holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 } } as ResolvedAiTokensOptions
    const service = new MeteringService(new LedgerService(ledgerStore, options), new PricingService(options, pricingStore), new MarkupResolver(options), options)
    const hold = await service.hold(context(), ESTIMATE_A)
    await service.release(hold, 'noop')
    const record = await service.record({ usage: normalized(), context: context() })
    const compensating = await service.reverse(record.id, 'noop')
    expect(compensating.reversesRecordId).toBe(record.id)
  })
})

describe('MeteringService estimate variants', () => {
  /** Variant A resolves the price via context.baseModel. */
  it('rates a { provider, model } estimate via baseModel', async () => {
    const built = build()
    await seedGpt5(built.pricingStore)
    const hold = await built.service.hold(context({ baseModel: 'gpt-5' }), { provider: 'openai', model: 'my-deploy', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 })
    expect(hold.estimatedCostNanoUsd).toBe(6_250_000n)
  })

  /** Variant A with an estimate serviceTier and a non-strict miss reserves $0. */
  it('reserves $0 for a { provider, model } estimate on a non-strict miss', async () => {
    const built = build({ strict: false })
    const hold = await built.service.hold(context(), { provider: 'openai', model: 'unseeded', operation: 'chat', serviceTier: 'flex', inputTokens: 10, maxOutputTokens: 10 })
    expect(hold.estimatedCostNanoUsd).toBe(0n)
  })

  /** Variant C without a preset records a placeholder provider. */
  it('accepts a { amountNanoUsd } estimate without a preset', async () => {
    const built = build({ markup: 2 })
    const hold = await built.service.hold(context({ serviceTier: 'flex' }), { amountNanoUsd: 1_000n })
    expect(hold.estimatedCostNanoUsd).toBe(2_000n)
    expect((await built.ledgerStore.findById(hold.id))?.provider).toBe('unspecified')
  })

  /** Variant B with a baseModel but a non-strict price miss reserves $0. */
  it('reserves $0 for a { tokens } estimate on a non-strict baseModel miss', async () => {
    const built = build({ strict: false })
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat, baseModel: 'unseeded' }), { tokens: 100 })
    expect(hold.estimatedCostNanoUsd).toBe(0n)
  })
})

describe('MeteringService additional edges', () => {
  /** A release that loses the void race (transition null) is a silent no-op. */
  it('no-ops a release that lost the void race', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    jest.spyOn(built.ledgerStore, 'transition').mockResolvedValueOnce(null)
    await built.service.release(hold, 'raced')
    expect(built.events.holdReleased).not.toHaveBeenCalled()
  })

  /** meter without an estimate forwards the context preset to record. */
  it('forwards the preset on the post-hoc meter path', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const { usage } = await built.service.meter(
      () => Promise.resolve({ model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
      context({ preset: providerPresets.openaiChat }),
      (r) => r,
    )
    expect(usage.enforced).toBe(true)
    expect(usage.inputTokens).toBe(1000)
  })

  /** Reverse tolerates the original vanishing after the compensating record is written. */
  it('reverses using the compensating record when the original vanishes', async () => {
    const built = build()
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({ usage: normalized(), context: context() })
    const original = await built.ledgerStore.findById(record.id)
    jest.spyOn(built.ledgerStore, 'findById').mockResolvedValueOnce(original).mockResolvedValueOnce(null)
    const compensating = await built.service.reverse(record.id, 'gone')
    expect(built.events.usageReversed).toHaveBeenCalledWith(compensating, compensating.id, 'gone')
  })

  /** A record-only setup with no holds option still holds, releases, and rejects a stale capture. */
  it('uses the default hold TTL when no holds option is configured', async () => {
    const ledgerStore = new InMemoryLedgerStore()
    const pricingStore = new InMemoryPricingStore()
    await seedGpt5(pricingStore)
    const options = { ratingMode: 'rate-table', markup: 1, ledger: { hashChain: false }, pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} } } as ResolvedAiTokensOptions
    const service = new MeteringService(new LedgerService(ledgerStore, options), new PricingService(options, pricingStore), new MarkupResolver(options), options)
    const hold = await service.hold(context(), ESTIMATE_A)
    expect(hold.expiresAt.getTime()).toBeGreaterThan(Date.now())
    await service.release(hold, 'x')
    const error = await service.capture(hold, normalized()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_ALREADY_SETTLED')
  })

  /** A 'key' payer scope skips the wallet leg but still reserves the budget. */
  it('skips the wallet for a key-scope hold', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const hold = await built.service.hold(context({ scope: { type: 'key', id: 'k1' } }), ESTIMATE_A)
    expect(hold.estimatedCostNanoUsd).toBe(6_250_000n)
    const budget = (await (built.budgets!).status('tenant-1', { type: 'key', id: 'k1' }))[0]
    expect(budget?.spent.count).toBe(1)
  })

  /** A $0 hold (variant C amount 0) never touches the wallet on reserve or release. */
  it('never debits the wallet for a $0 hold', async () => {
    const built = build({ wallets: true })
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat }), { amountNanoUsd: 0n })
    await built.service.release(hold, 'x')
    expect((await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** getStatus treats a soft (allow) budget as never hard-blocking. */
  it('does not block on a soft budget', async () => {
    const built = build({ budgets: true })
    await upsertBudget(built, { policy: 'allow', limitCount: 1 })
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    expect(status.hasAccess).toBe(true)
  })

  /** getStatus blocks on a cost-exhausted hard budget. */
  it('blocks on a cost-exhausted hard budget', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 6_250_000n })
    await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    expect(status.blockedBy).toBe('budget')
  })

  /** getStatus blocks on a token-exhausted hard budget. */
  it('blocks on a token-exhausted hard budget', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitTokens: 1500 })
    await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    expect(status.blockedBy).toBe('budget')
  })

  /** getStatus floors a below-overdraft wallet remainder at zero. */
  it('floors an over-drafted wallet remainder at zero', async () => {
    const built = build({ wallets: true, overdraft: 1_000_000n })
    await grant(built, 1_000n)
    built.walletStore.forceBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, -5_000_000n)
    const status = await built.service.getStatus('tenant-1', { type: 'user', id: 'u1' })
    expect(status.wallet?.overdraftRemainingNanoUsd).toBe(0n)
  })

  /** compensateHold with wallets-only unwinds the wallet debit. */
  it('compensates a wallet-only hold on a failed insert', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('insert down'))
    await expect(built.service.hold(context(), ESTIMATE_A)).rejects.toThrow('insert down')
    expect((await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** Reversing a wallet-only enforced record refunds without a budget release. */
  it('reverses a wallet-only enforced record', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const record = await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    await built.service.reverse(record.id, 'refund')
    expect((await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** Post-hoc enforcement rolls the budget back when the wallet debit fails. */
  it('rolls the budget back on a post-hoc wallet shortfall', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 1_000_000n)
    await upsertBudget(built, { limitNanoUsd: 100_000_000n, limitTokens: 100_000, limitCount: 100 })
    const error = await built.service.record({ usage: normalized(), context: context({ enforce: true }) }).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')
    const budget = (await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent.nanoUsd).toBe(0n)
  })

  /** A budget-only capture adjusts the window with no wallet leg. */
  it('captures with budgets only', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.capture(hold, normalized({ inputTokens: 500, outputTokens: 250 }))
    const budget = (await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent.nanoUsd).toBe(3_125_000n)
  })

  /** A wallet-only hold whose debit fails rethrows without a budget release. */
  it('rethrows a wallet-only hold shortfall', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 1_000_000n)
    const error = await built.service.hold(context(), ESTIMATE_A).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')
  })

  /** A budget-only hold whose insert fails releases the budget with no wallet leg. */
  it('compensates a budget-only hold on a failed insert', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 100_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('insert down'))
    await expect(built.service.hold(context(), ESTIMATE_A)).rejects.toThrow('insert down')
    const budget = (await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent.nanoUsd).toBe(0n)
  })

  /** Capturing an isSystemCost hold settles the ledger without any wallet/budget move. */
  it('captures an isSystemCost hold without money movement', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await upsertBudget(built)
    const hold = await built.service.hold(context({ isSystemCost: true }), ESTIMATE_A)
    const record = await built.service.capture(hold, normalized())
    expect(record.isSystemCost).toBe(true)
    expect((await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** Reversing a budget-only enforced record releases the budget with no wallet leg. */
  it('reverses a budget-only enforced record', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitTokens: 100_000, limitCount: 100 })
    const record = await built.service.record({ usage: normalized(), context: context({ enforce: true }) })
    await built.service.reverse(record.id, 'refund')
    const budget = (await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' }))[0]
    expect(budget?.spent).toEqual({ nanoUsd: 0n, tokens: 0, count: 0 })
  })

  /** A wallet-only capture below the estimate refunds without a budget adjust. */
  it('captures below the estimate with wallets only', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.capture(hold, normalized({ inputTokens: 500, outputTokens: 250 }))
    expect((await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(96_875_000n)
  })
})

describe('MeteringService.capture — streaming collector', () => {
  const wordTokenizer: ITokenizer = { countTokens: ({ text }): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length) }

  /** An aborted stream settles via the tokenizer, taking input tokens from the hold estimate. */
  it('captures an aborted stream using the hold estimate for input', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat }), ESTIMATE_A)
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.push({ choices: [{ delta: { content: 'one two three' } }] })
    const record = await built.service.capture(hold, collector, providerPresets.openaiChat)
    expect(record.status).toBe('posted')
    expect(record.inputTokens).toBe(1500) // hold.estimatedTokens (variant A total) — the §5.6 input fallback
    expect(record.outputTokens).toBe(3)
  })

  /** A stream with provider-final usage settles on the reported actuals. */
  it('captures a stream with provider-final usage', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat }), ESTIMATE_A)
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', preset: providerPresets.openaiChat })
    collector.push({ model: 'gpt-5', choices: [], usage: { prompt_tokens: 800, completion_tokens: 400 } })
    const record = await built.service.capture(hold, collector)
    expect(record.inputTokens).toBe(800)
    expect(record.outputTokens).toBe(400)
  })

  /** A NON-fallback stream that reports zero prompt tokens keeps input at 0 — the estimate fallback must NOT trigger. */
  it('keeps zero input tokens when a non-fallback stream reports zero prompt tokens', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat }), ESTIMATE_A) // estimatedTokens 1500
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', preset: providerPresets.openaiChat })
    collector.push({ model: 'gpt-5', choices: [], usage: { prompt_tokens: 0, completion_tokens: 400 } })
    const record = await built.service.capture(hold, collector)
    // usedFallback is false, so `usedFallback && inputTokens === 0` is false. The LogicalOperator (&& → ||) and the
    // `usedFallback` → true (CE) mutations would flip the guard and overwrite input with the 1500-token estimate.
    expect(record.inputTokens).toBe(0)
    expect(record.outputTokens).toBe(400)
  })

  /** A fallback stream that DID count prompt tokens keeps that count — the estimate must not override a non-zero input. */
  it('keeps the fallback prompt-token count over the hold estimate when input tokens are non-zero', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context({ preset: providerPresets.openaiChat }), ESTIMATE_A) // estimatedTokens 1500
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.setPromptTokens(700)
    collector.push({ choices: [{ delta: { content: 'one two three' } }] })
    const record = await built.service.capture(hold, collector, providerPresets.openaiChat)
    // usedFallback is true but finalized.inputTokens is 700 (≠ 0), so the guard stays false. The `inputTokens === 0`
    // → true (CE) mutation would overwrite the real 700 count with the 1500-token estimate.
    expect(record.inputTokens).toBe(700)
    expect(record.outputTokens).toBe(3)
  })
})

describe('MeteringService telemetry (§14.1)', () => {
  /** record() emits gen_ai.* usage through the sink. */
  it('records usage telemetry on record()', async () => {
    const sink: ITelemetrySink = { recordUsage: jest.fn(), recordDuration: jest.fn() }
    const built = build({ telemetry: sink })
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({ usage: normalized(), context: context() })
    expect(sink.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ 'gen_ai.provider.name': 'openai', 'gen_ai.usage.input_tokens': 1000 }), record)
  })

  /** capture() emits usage telemetry for the settled record. */
  it('records usage telemetry on capture()', async () => {
    const sink: ITelemetrySink = { recordUsage: jest.fn() }
    const built = build({ telemetry: sink, wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.capture(hold, normalized())
    expect(sink.recordUsage).toHaveBeenCalledTimes(1)
  })

  /** meter() records the operation duration when the sink supports it. */
  it('records duration on meter()', async () => {
    const sink: ITelemetrySink = { recordUsage: jest.fn(), recordDuration: jest.fn() }
    const built = build({ telemetry: sink, wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await built.service.meter(() => Promise.resolve({ usage: normalized() }), context(), (r) => r.usage, ESTIMATE_A)
    expect(sink.recordDuration).toHaveBeenCalledWith(expect.objectContaining({ 'gen_ai.operation.name': 'chat' }), expect.any(Number))
    // duration = now() - startedAt: the real clock gives a small positive value (~1ms).
    // The ArithmeticOperator mutation (now() + startedAt) would produce ≈ 3.5×10¹² — far above 1000.
    const [[, duration]] = (sink.recordDuration as jest.Mock<unknown[], unknown[]>).mock.calls as [[unknown, number]]
    expect(duration).toBeGreaterThanOrEqual(0)
    expect(duration).toBeLessThan(1_000)
  })

  /** meter() without an estimate still records duration. */
  it('records duration on the post-hoc meter path', async () => {
    const sink: ITelemetrySink = { recordUsage: jest.fn(), recordDuration: jest.fn() }
    const built = build({ telemetry: sink, wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    await built.service.meter(() => Promise.resolve({ usage: normalized() }), context(), (r) => r.usage)
    // The ArithmeticOperator mutation (now() + startedAt) would produce ≈ 3.5×10¹² — far above 1000.
    const [[, duration]] = (sink.recordDuration as jest.Mock<unknown[], unknown[]>).mock.calls as [[unknown, number]]
    expect(duration).toBeGreaterThanOrEqual(0)
    expect(duration).toBeLessThan(1_000)
  })
})

describe('MeteringService content sidecar (§14.2)', () => {
  /** With content configured, record() forwards masked text to the sidecar and the ledger stays text-free. */
  it('captures record content into the sidecar', async () => {
    const puts: { role: string; text: string }[] = []
    const store: IContentStore = { put: (i) => (puts.push({ role: i.role, text: i.text }), Promise.resolve()), purge: () => Promise.resolve(0) }
    const built = build({ content: store })
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({ usage: normalized(), context: context(), content: { prompt: 'question', completion: 'answer' } })
    expect(puts).toEqual([{ role: 'prompt', text: 'question' }, { role: 'completion', text: 'answer' }])
    expect(JSON.stringify(record, (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain('question')
  })

  /** With the sidecar disabled, content is silently dropped and the ledger stays text-free. */
  it('drops content when the sidecar is disabled', async () => {
    const built = build()
    await seedGpt5(built.pricingStore)
    const record = await built.service.record({ usage: normalized(), context: context(), content: { prompt: 'secret' } })
    expect(record.status).toBe('posted')
    expect(JSON.stringify(record, (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain('secret')
  })

  /** capture() forwards content to the sidecar. */
  it('captures capture content into the sidecar', async () => {
    const puts: string[] = []
    const store: IContentStore = { put: (i) => (puts.push(i.role), Promise.resolve()), purge: () => Promise.resolve(0) }
    const built = build({ content: store, wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE_A)
    await built.service.capture(hold, normalized(), undefined, { completion: 'streamed reply' })
    expect(puts).toEqual(['completion'])
  })
})

describe('MeteringService hold→capture money invariant', () => {
  /** For any estimate/actual, the final wallet balance and budget window equal the ACTUAL cost. */
  it('settles wallet and budget to the exact actual across random estimate/actual pairs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 0n, max: 50_000_000n }), fc.bigInt({ min: 0n, max: 50_000_000n }), async (estimate, actual) => {
        const built = build({ wallets: true, budgets: true, ratingMode: 'provider-reported' })
        await grant(built, 1_000_000_000n)
        await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
        const hold = await built.service.hold(context({ preset: providerPresets.openrouter }), { amountNanoUsd: estimate })
        const usage = normalized({ provider: 'openrouter', inputTokens: 0, outputTokens: 0, providerReportedCostNanoUsd: actual })
        await built.service.capture(hold, usage, providerPresets.openrouter)
        const balance = (await (built.wallets!).getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd
        const window = (await (built.budgets!).status('tenant-1', { type: 'user', id: 'u1' }))[0]
        expect(balance).toBe(1_000_000_000n - actual)
        expect(window?.spent.nanoUsd).toBe(actual)
      }),
      { numRuns: 40 },
    )
  })
})
