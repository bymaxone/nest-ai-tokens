/**
 * What a provider's usage bills, in nano-USD, through `record()` with the real preset of the provider: a token that a provider counts in
 * its total and also in one of its categories is billed once, at the rate of the category.
 * @layer test
 */
import { normalizeVercelAiSdkUsage, type AiTokensErrorResponse } from '../../shared'
import type { AiTokensException } from '../errors'
import { providerPresets } from '../config/provider-presets'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { IContentStore, ITelemetrySink, MeteringContext } from '../interfaces'
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

/** Seed gpt-4o-audio: 1,000 nano-USD per input token, 10,000 per output token and 80,000 per audio output token. */
async function seedAudio(store: InMemoryPricingStore): Promise<void> {
  await store.upsertPrice({
    provider: 'openai',
    model: 'gpt-4o-audio',
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_000_000_000n,
    outputNanoUsdPerMillion: 10_000_000_000n,
    audioOutNanoUsdPerMillion: 80_000_000_000n,
    effectiveFrom: new Date(0),
  })
}

describe('a token that is counted twice by a provider is billed once', () => {
  /** 100 input and 50 output tokens, 20 of them audio: 100 x 1,000 + 30 x 10,000 + 20 x 80,000 = 2,000,000 nano-USD. */
  it('bills the audio completion tokens of OpenAI chat at the audio rate only', async () => {
    const built = build()
    await seedAudio(built.pricingStore)
    const record = await built.service.record({
      usage: { model: 'gpt-4o-audio', usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { audio_tokens: 20 } } },
      preset: providerPresets.openaiChat,
      context: context(),
    })
    expect(record.billedCostNanoUsd).toBe(2_000_000n)
  })

  /** The same call through the Responses API: 100 input and 50 output tokens, 20 of them audio. */
  it('bills the audio output tokens of OpenAI Responses at the audio rate only', async () => {
    const built = build()
    await seedAudio(built.pricingStore)
    const record = await built.service.record({
      usage: { model: 'gpt-4o-audio', usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { audio_tokens: 20 } } },
      preset: providerPresets.openaiResponses,
      context: context(),
    })
    expect(record.billedCostNanoUsd).toBe(2_000_000n)
  })

  /** The AI SDK of v6 reports its 20 reasoning tokens at the root and in the details: 100 input, 50 output of which 20 are reasoning, billed at 1,000 per input token, 10,000 per output token and 20,000 per reasoning token: 100,000 + 30 x 10,000 + 20 x 20,000 = 800,000 nano-USD. */
  it('bills the reasoning tokens that the AI SDK reports twice once', async () => {
    const built = build()
    await built.pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_000_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, reasoningNanoUsdPerMillion: 20_000_000_000n, effectiveFrom: new Date(0) })
    const record = await built.service.record({
      usage: { model: 'gpt-5', usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 20, outputTokenDetails: { reasoningTokens: 20 } } },
      normalizer: (raw) => ({ ...normalizeVercelAiSdkUsage(raw), provider: 'openai' }),
      context: context(),
    })
    expect(record.billedCostNanoUsd).toBe(800_000n)
  })

  /** 500 tokens written to the cache, named only by the total beside an empty split: 100 x 1,000 + 50 x 10,000 + 500 x 5,000 = 3,100,000 nano-USD. */
  it('bills the cache write of Anthropic named by its total beside an empty split', async () => {
    const built = build()
    await built.pricingStore.upsertPrice({ provider: 'anthropic', model: 'claude', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_000_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, cacheWrite5mNanoUsdPerMillion: 5_000_000_000n, cacheWrite1hNanoUsdPerMillion: 8_000_000_000n, effectiveFrom: new Date(0) })
    const record = await built.service.record({
      usage: { model: 'claude', usage: { input_tokens: 100, output_tokens: 50, cache_creation: {}, cache_creation_input_tokens: 500 } },
      preset: providerPresets.anthropic,
      context: context(),
    })
    expect(record.billedCostNanoUsd).toBe(3_100_000n)
  })

  /** The same 500 tokens named by the total beside an empty list of entries on Bedrock. */
  it('bills the cache write of Bedrock named by its total beside an empty list of entries', async () => {
    const built = build()
    await built.pricingStore.upsertPrice({ provider: 'bedrock', model: 'claude', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_000_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, cacheWrite5mNanoUsdPerMillion: 5_000_000_000n, cacheWrite1hNanoUsdPerMillion: 8_000_000_000n, effectiveFrom: new Date(0) })
    const record = await built.service.record({
      usage: { model: 'claude', usage: { inputTokens: 100, outputTokens: 50, cacheDetails: [], cacheWriteInputTokens: 500 } },
      preset: providerPresets.bedrock,
      context: context(),
    })
    expect(record.billedCostNanoUsd).toBe(3_100_000n)
  })

  /** A call of more tokens than a ledger row stores is refused before the wallet is debited; 2,147,483,647 is the most a row holds. */
  it('refuses a call over 2,147,483,647 tokens before it debits, and accepts one of exactly that many', async () => {
    const built = build({ wallets: true, strict: false })
    const ref = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' } as const
    await built.wallets!.grant(ref, { amountNanoUsd: 10_000_000_000_000n, idempotencyKey: 'grant-1', reason: 'seed' })
    const before = await built.wallets!.getBalance(ref)
    const usage = (inputTokens: number): unknown => ({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 })
    const error = await built.service.record({ usage: usage(2_147_483_648), context: context({ enforce: true }) }).catch((e: unknown) => e)
    expect(((error as AiTokensException).getResponse() as AiTokensErrorResponse).error).toMatchObject({ code: 'AI_TOKENS_USAGE_MALFORMED', details: { reason: 'the tokens of a usage add up to more than a ledger row stores (2147483647)' } })
    expect((await built.wallets!.getBalance(ref)).nanoUsd).toBe(before.nanoUsd)
    expect(await built.ledgerStore.query({ tenantId: 'tenant-1' })).toEqual([])
    const stored = await built.service.record({ usage: usage(2_147_483_647), context: context({ enforce: true }) })
    expect(stored.totalTokens).toBe(2_147_483_647)
  })
})
