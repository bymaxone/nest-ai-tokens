/**
 * The seeded price snapshot prices a call that carries web searches under strict mode, for every seeded model whose provider's own pricing
 * page states a fee for the tool, and says by name why each other seeded model has no rate: a model of the snapshot is in exactly one of the
 * two lists below, so adding a model to the snapshot forces the decision. A call with searches on a model without a rate is refused under
 * strict mode before anything is debited, as a call on an unpriced model is.
 * @layer prices
 */
import { MODEL_PRICES_SEED } from './model-prices.seed'
import type { AiTokensErrorResponse } from '../shared'
import type { AiTokensException } from '../server/errors'
import { InMemoryLedgerStore } from '../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../test/fakes/in-memory-budget-store'
import type { ResolvedAiTokensOptions } from '../server/config'
import type { IContentStore, ITelemetrySink } from '../server/interfaces'
import { ContentCapture } from '../server/services/content-capture'
import { TelemetryEmitter } from '../server/telemetry/otel-emitter'
import { BudgetService } from '../server/services/budget.service'
import { LedgerService } from '../server/services/ledger.service'
import { MarkupResolver } from '../server/services/markup.resolver'
import { MeteringService, type MeteringEventHooks } from '../server/services/metering.service'
import { PricingService } from '../server/services/pricing.service'
import { WalletService } from '../server/services/wallet.service'

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



/** One seeded row, by the four names that identify it. */
const keyOf = (row: { provider: string; model: string; serviceTier: string; operation: string }): string => `${row.provider}/${row.model}/${row.serviceTier}/${row.operation}`

/** The seeded rows that carry a web search rate, with the nano-USD a search costs. */
const RATED: Readonly<Record<string, bigint>> = {
  'openai/gpt-5/standard/chat': 10_000_000n,
  'openai/gpt-5-mini/standard/chat': 10_000_000n,
  'anthropic/claude-opus-4/standard/chat': 10_000_000n,
  'anthropic/claude-sonnet-4/standard/chat': 10_000_000n,
  'anthropic/claude-sonnet-4/batch/chat': 10_000_000n,
  'anthropic/claude-haiku-4/standard/chat': 10_000_000n,
  'xai/grok-4/standard/chat': 5_000_000n,
}

/** The seeded rows without one, each with why: a host that bills searches on them supplies the rate with `upsertPrice`. */
const UNRATED: Readonly<Record<string, string>> = {
  'openai/gpt-5/batch/chat': 'the pricing page shows no Batch price for tools',
  'openai/text-embedding-3-small/standard/embeddings': 'an embedding model takes no tools',
  'openai/text-embedding-3-large/standard/embeddings': 'an embedding model takes no tools',
  'gemini/gemini-2.5-pro/standard/chat': 'Grounding with Google Search is charged per grounded prompt or per query, and the unit of the 2.5 models is not stated plainly',
  'gemini/gemini-2.5-flash/standard/chat': 'Grounding with Google Search is charged per grounded prompt or per query, and the unit of the 2.5 models is not stated plainly',
  'mistral/mistral-large-latest/standard/chat': 'the pricing page states no web search API fee',
  'mistral/mistral-medium-latest/standard/chat': 'the pricing page states no web search API fee',
  'mistral/mistral-small-latest/standard/chat': 'the pricing page states no web search API fee',
  'deepseek/deepseek-chat/standard/chat': 'no search tool fee is published for the API',
  'groq/llama-3.3-70b-versatile/standard/chat': 'no built-in search tool fee is published for the model',
}

const WALLET = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' } as const

/** A world over the seeded snapshot in strict mode, with a funded wallet. */
async function seeded(): Promise<Built> {
  const built = build({ wallets: true, strict: true })
  for (const row of MODEL_PRICES_SEED) await built.pricingStore.upsertPrice({ ...row, effectiveFrom: new Date(0) })
  await built.wallets!.grant(WALLET, { amountNanoUsd: 10_000_000_000_000n, idempotencyKey: 'grant-1', reason: 'seed' })
  return built
}

/** A usage of the row's model with 1,000 input and 500 output tokens and `searches` web searches. */
const usageOf = (row: { provider: string; model: string; operation: string }, searches: number): Record<string, unknown> => ({ provider: row.provider, model: row.model, operation: row.operation, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0, ...(searches > 0 ? { serverToolUse: { web_search_requests: searches } } : {}) })

/** The code a refusal carries, or `undefined` when the call is accepted. */
async function refusalCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
  } catch (error) {
    return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
  }
  return undefined
}

describe('the seeded snapshot and the web searches of a call', () => {
  /** A model of the snapshot is rated or has its reason, never both and never neither. */
  it('lists every seeded row once, as rated or as unrated with its reason, and nothing else', () => {
    const seeded = MODEL_PRICES_SEED.map(keyOf).sort()
    expect([...Object.keys(RATED), ...Object.keys(UNRATED)].sort()).toEqual(seeded)
    for (const row of MODEL_PRICES_SEED) {
      expect(row.unitRates?.web_search_requests).toBe(RATED[keyOf(row)])
    }
  })

  const unratedChat = MODEL_PRICES_SEED.filter((row) => RATED[keyOf(row)] === undefined && row.operation === 'chat')

  /** Under strict mode a call with 7 searches on a rated model is billed its tokens and 7 searches at the rate, not refused. */
  it.each(Object.keys(RATED))('prices a call with web searches on %s under strict mode', async (key) => {
    const row = MODEL_PRICES_SEED.find((candidate) => keyOf(candidate) === key)!
    const built = await seeded()
    const context = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', serviceTier: row.serviceTier } as const
    const tokensOnly = await built.service.record({ usage: usageOf(row, 0), context: { ...context, idempotencyKey: 'a' } })
    const searched = await built.service.record({ usage: usageOf(row, 7), context: { ...context, idempotencyKey: 'b' } })
    expect(searched.priceMissing).toBe(false)
    expect(searched.billedCostNanoUsd - tokensOnly.billedCostNanoUsd).toBe(7n * RATED[key]!)
  })

  /** Under strict mode a call with searches on a model with no rate is refused before anything is debited. */
  it('refuses a call with web searches on each unrated chat model under strict mode, before any debit', async () => {
    expect(unratedChat.length).toBeGreaterThan(0)
    for (const row of unratedChat) {
      const built = await seeded()
      const before = (await built.wallets!.getBalance(WALLET)).nanoUsd
      const context = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', serviceTier: row.serviceTier, enforce: true } as const
      expect(await refusalCode(() => built.service.record({ usage: usageOf(row, 7), context }))).toBe('AI_TOKENS_PRICE_NOT_FOUND')
      expect((await built.wallets!.getBalance(WALLET)).nanoUsd).toBe(before)
    }
  })
})
