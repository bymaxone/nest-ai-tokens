/**
 * `capture()` and `release()` act only for the caller they are given: the stored hold must belong to the caller's tenant
 * and payer scope, the tenant and scope on the `Hold` object are not read, a caller of the wrong shape is refused
 * before the store, and the input tokens of an aborted stream come from the stored hold.
 * @layer test
 */
import type { AiTokensErrorResponse, NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { Hold, HoldEstimate, IContentStore, ITelemetrySink, MeteringContext } from '../interfaces'
import type { AiTokensException } from '../errors'
import { StreamUsageCollector } from '../streaming/stream-usage-collector'
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


/** The variant-A estimate for a 1000-in / 500-out gpt-5 chat call. */
const ESTIMATE_A: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }


const OTHER_TENANT = context({ tenantId: 'tenant-2' })
const OTHER_PAYER = context({ scope: { type: 'user', id: 'u2' } })

/** The code and message a rejection carries, or `undefined` when the promise resolved. */
async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string } | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return { code: ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code, message: (error as Error).message }
  }
}

async function pendingHold(): Promise<{ built: Built; hold: Hold }> {
  const built = build({ wallets: true })
  await seedGpt5(built.pricingStore)
  await grant(built, 10_000_000_000n)
  return { built, hold: await built.service.hold(context(), ESTIMATE_A) }
}

describe('capture() and release() act only for the caller of the hold', () => {
  /** A `Hold` object is a bearer value: presenting it as another tenant or another payer finds nothing, exactly like an unknown id. */
  it.each([
    { name: 'another tenant', caller: OTHER_TENANT },
    { name: 'another payer of the same tenant', caller: OTHER_PAYER },
  ])('answers $name as an unknown hold, for capture and for release, and leaves the hold pending', async ({ caller }) => {
    const { built, hold } = await pendingHold()
    const stranger = { ...hold, tenantId: caller.tenantId, scope: caller.scope }
    const unknown = { ...hold, id: 'unknown-hold' }
    const before = await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })

    const captured = await rejection(built.service.capture(stranger, caller, normalized()))
    const released = await rejection(built.service.release(stranger, caller, 'x'))
    const capturedUnknown = await rejection(built.service.capture(unknown, caller, normalized()))

    expect(captured?.code).toBe('AI_TOKENS_HOLD_NOT_FOUND')
    expect(released?.code).toBe('AI_TOKENS_HOLD_NOT_FOUND')
    expect(captured).toEqual(capturedUnknown)
    expect((await built.ledgerStore.findById(hold.id))?.status).toBe('pending')
    expect(await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).toEqual(before)
  })

  /** The caller decides, so a Hold object with other claims still settles for its real owner. */
  it('settles for the owner whatever tenant and scope the Hold object carries', async () => {
    const { built, hold } = await pendingHold()

    const record = await built.service.capture({ ...hold, tenantId: 'x', scope: { type: 'user', id: 'x' } }, context(), normalized())

    expect(record.status).toBe('posted')
  })

  /** An aborted stream's input falls back to the stored hold's total, not to a figure the caller can set. */
  it('takes the input tokens of an aborted stream from the stored hold, not from hold.estimatedTokens', async () => {
    const { built, hold } = await pendingHold()
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: { countTokens: () => 10 } })

    const record = await built.service.capture({ ...hold, estimatedTokens: 5_000_000 }, context(), collector)

    expect(record.inputTokens).toBe(hold.estimatedTokens)
    expect(record.inputTokens).toBeLessThan(5_000_000)
  })

  /** A call written against the earlier shapes, or from plain JavaScript, is a configuration error before any read. */
  it.each([
    { name: 'a usage object in the caller position', caller: normalized() },
    { name: 'undefined', caller: undefined },
    { name: 'a caller with an empty tenant', caller: { tenantId: '', scope: { type: 'user', id: 'u1' } } },
    { name: 'a caller whose tenant is a number', caller: { tenantId: 7, scope: { type: 'user', id: 'u1' } } },
    { name: 'a caller without a scope', caller: { tenantId: 'tenant-1' } },
    { name: 'a caller with a null scope', caller: { tenantId: 'tenant-1', scope: null } },
    { name: 'a caller with a scope without an id', caller: { tenantId: 'tenant-1', scope: { type: 'user' } } },
    { name: 'a string (the reason of the earlier release shape)', caller: 'handler threw' },
  ])('refuses $name as the caller before the store is read', async ({ caller }) => {
    const { built, hold } = await pendingHold()
    const read = jest.spyOn(built.ledgerStore, 'findById')

    const captured = await rejection(built.service.capture(hold, caller as never, normalized()))
    const released = await rejection(built.service.release(hold, caller as never, 'x'))

    expect(captured?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(captured?.message).toContain('capture(hold, caller, usage): the second argument must be the caller { tenantId, scope } (since 1.1.15)')
    expect(released?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(released?.message).toContain('release(hold, caller, reason): the second argument must be the caller { tenantId, scope } (since 1.1.15)')
    expect(read).not.toHaveBeenCalled()
    expect((await built.ledgerStore.findById(hold.id))?.status).toBe('pending')
  })
})
