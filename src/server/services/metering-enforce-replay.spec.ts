/**
 * A retry of a `record({ enforce: true })` call whose enforcement was refused is refused again, and a call that was
 * enforced is replayed without a second debit or consume. The ledger row of an enforced record exists only when the
 * wallet and the budget accepted it, so a stored row is the proof that the call was enforced.
 * @layer test
 */
import type { AiTokensErrorResponse, Budget, NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { IContentStore, ITelemetrySink, MeteringContext } from '../interfaces'
import { ContentCapture } from './content-capture'
import { TelemetryEmitter } from '../telemetry/otel-emitter'
import type { AiTokensException } from '../errors'
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


const WALLET = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' } as const

/** The wallet balance in nano-USD. */
async function balance(built: Built): Promise<bigint> {
  return (await built.wallets!.getBalance(WALLET)).nanoUsd
}

/** The error code a rejected promise carries, or `'ok'` when it resolved. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return codeOf(error)
  }
}

describe('record({ enforce: true }) retries', () => {
  it('refuses a retry of a call the wallet refused, and keeps no row for it', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 1n)
    const input = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-1' }) }

    expect(await outcome(built.service.record(input))).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')
    expect(await outcome(built.service.record(input))).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')

    expect(await balance(built)).toBe(1n)
    expect(await built.ledgerStore.findByIdempotencyKey('tenant-1', 'k-1')).toBeNull()
  })

  it('accepts the retry once the wallet is funded, and debits once however often it is replayed', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 1n)
    const input = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-2' }) }
    expect(await outcome(built.service.record(input))).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')

    await grant(built, 10_000_000_000n, 'u1')
    const first = await built.service.record(input)
    const replay = await built.service.record(input)
    const again = await built.service.record(input)

    expect([replay.id, again.id]).toEqual([first.id, first.id])
    expect(first.enforced).toBe(true)
    expect(await balance(built)).toBe(1n + 10_000_000_000n - first.billedCostNanoUsd)
  })

  it('refuses a retry of a call the budget refused, and keeps no row for it', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1n })
    const input = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-3' }) }

    expect(await outcome(built.service.record(input))).toBe('AI_TOKENS_BUDGET_EXCEEDED')
    expect(await outcome(built.service.record(input))).toBe('AI_TOKENS_BUDGET_EXCEEDED')
    expect(await built.ledgerStore.findByIdempotencyKey('tenant-1', 'k-3')).toBeNull()
  })

  it('consumes the budget once when an accepted call is retried', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const input = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-4' }) }

    const first = await built.service.record(input)
    await built.service.record(input)
    await built.service.record(input)

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(first.billedCostNanoUsd)
  })

  it('charges the wallet once when a keyed call whose ledger append failed is retried', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    const input = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-5' }) }

    await expect(built.service.record(input)).rejects.toThrow('connection reset')
    const [released] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(released!.spent.nanoUsd).toBe(0n)

    const retried = await built.service.record(input)

    expect(await balance(built)).toBe(10_000_000_000n - retried.billedCostNanoUsd)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(retried.billedCostNanoUsd)
  })

  it('refunds the wallet and releases the budget when a call without a key fails to append', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))

    await expect(built.service.record({ usage: normalized(), context: context({ enforce: true }) })).rejects.toThrow('connection reset')

    expect(await balance(built)).toBe(10_000_000_000n)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(0n)
  })

  it('keeps the charge of a call whose ledger append committed before the error reached the caller, and replays it on retry', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const append = built.ledgerStore.append.bind(built.ledgerStore)
    jest.spyOn(built.ledgerStore, 'append').mockImplementationOnce(async (...args) => {
      await append(...args)
      throw new Error('timed out after commit')
    })
    const input = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-9' }) }

    await expect(built.service.record(input)).rejects.toThrow('timed out after commit')
    const retried = await built.service.record(input)

    expect(retried.enforced).toBe(true)
    expect(await balance(built)).toBe(10_000_000_000n - retried.billedCostNanoUsd)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(retried.billedCostNanoUsd)
  })

  it('gives its budget consumption back when the row found after a generic append error belongs to another attempt', async () => {
    const built = build({ wallets: true, budgets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const input = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-11' }) }
    const winner = await built.service.record(input)
    // The loser misses the winner's row at the replay lookup, then its own append fails for a reason that is not the key.
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    await expect(built.service.record(input)).rejects.toThrow('connection reset')

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(winner.billedCostNanoUsd)
    expect(await balance(built)).toBe(10_000_000_000n - winner.billedCostNanoUsd)
  })

  it('refunds the wallet debit of a losing attempt that debited another payer wallet under the same key', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n, 'u1')
    await grant(built, 10_000_000_000n, 'u2')
    const winner = await built.service.record({ usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-12' }) })
    // The loser pays from another wallet, misses the winner's row at the replay lookup and loses the append.
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    const loser = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-12', scope: { type: 'user', id: 'u2' } }) }

    await expect(built.service.record(loser)).rejects.toThrow()

    const u2 = await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u2' })
    expect(u2.nanoUsd).toBe(10_000_000_000n)
    expect(await balance(built)).toBe(10_000_000_000n - winner.billedCostNanoUsd)
  })

  it('moves nothing and rethrows the original error when the ledger cannot say whether the row was written', async () => {
    const built = build({ budgets: true })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('still down'))

    await expect(built.service.record({ usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-10' }) })).rejects.toThrow('connection reset')

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBeGreaterThan(0n)
  })

  it('rethrows a ledger failure of a call that was not enforced, and moves nothing', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))

    await expect(built.service.record({ usage: normalized(), context: context({ idempotencyKey: 'k-6' }) })).rejects.toThrow('connection reset')

    expect(await balance(built)).toBe(10_000_000_000n)
  })

  it('keeps the wallet debit of the attempt that appended when two attempts with the same key race', async () => {
    const built = build({ wallets: true })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    const input = { usage: normalized(), context: context({ enforce: true, idempotencyKey: 'k-7' }) }
    const winner = await built.service.record(input)
    // The loser passes the replay lookup before the winner's row exists, then meets it at the append.
    const lookup = jest.spyOn(built.ledgerStore, 'findByIdempotencyKey')
    lookup.mockResolvedValueOnce(null)

    const loser = await built.service.record(input)

    expect(loser.id).toBe(winner.id)
    expect(await balance(built)).toBe(10_000_000_000n - winner.billedCostNanoUsd)
  })
})
