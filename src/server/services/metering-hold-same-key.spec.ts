/**
 * A retry of a `record({ enforce: true })` call whose enforcement was refused is refused again, and a call that was
 * enforced is replayed without a second debit or consume. The ledger row of an enforced record exists only when the
 * wallet and the budget accepted it, so a stored row is the proof that the call was enforced.
 * @layer test
 */
import type { Budget, NormalizedUsage } from '../../shared'
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
import { LedgerIdempotencyConflict } from './ledger-idempotency-conflict'

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


/** The variant-A estimate for a 1000-in / 500-out gpt-5 chat call. */
const ESTIMATE_A: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }

const WALLET = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' } as const

/** The wallet balance in nano-USD. */
async function balance(built: Built): Promise<bigint> {
  return (await built.wallets!.getBalance(WALLET)).nanoUsd
}

/** A clock that moves on every read, so two attempts never carry the same instant. */
function advancing(): () => Date {
  let step = 0
  return () => new Date(Date.now() + (step += 7))
}

describe('hold() with one idempotency key racing itself', () => {
  it('returns one hold and reserves the wallet once for concurrent calls on one instance', async () => {
    const built = build({ wallets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    const ctx = context({ idempotencyKey: 'h-1' })

    const results = await Promise.allSettled([built.service.hold(ctx, ESTIMATE_A), built.service.hold(ctx, ESTIMATE_A), built.service.hold(ctx, ESTIMATE_A)])

    const holds = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    expect(holds).toHaveLength(3)
    expect(new Set(holds.map((h) => h.id)).size).toBe(1)
    expect(await balance(built)).toBe(10_000_000_000n - holds[0]!.estimatedCostNanoUsd)
  })

  it('does not credit the wallet twice when the winner released before the loser recovered', async () => {
    const built = build({ wallets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    const winner = await built.service.hold(context({ idempotencyKey: 'h-2' }), ESTIMATE_A)
    await built.service.release(winner, context(), 'released before the loser recovers')
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)

    await expect(built.service.hold(context({ idempotencyKey: 'h-2' }), ESTIMATE_A)).rejects.toThrow()

    expect(await balance(built)).toBe(10_000_000_000n)
  })

  it('keeps the winner reservation when a same-shape loser loses the append', async () => {
    const built = build({ wallets: true, budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const winner = await built.service.hold(context({ idempotencyKey: 'h-3' }), ESTIMATE_A)
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)

    await expect(built.service.hold(context({ idempotencyKey: 'h-3' }), ESTIMATE_A)).rejects.toThrow()

    expect(await balance(built)).toBe(10_000_000_000n - winner.estimatedCostNanoUsd)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(winner.estimatedCostNanoUsd)
  })

  it('charges once for a keyed hold whose append failed and is retried', async () => {
    const built = build({ wallets: true, budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    const ctx = context({ idempotencyKey: 'h-4' })

    await expect(built.service.hold(ctx, ESTIMATE_A)).rejects.toThrow('connection reset')
    const retried = await built.service.hold(ctx, ESTIMATE_A)

    expect(await balance(built)).toBe(10_000_000_000n - retried.estimatedCostNanoUsd)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(retried.estimatedCostNanoUsd)
  })

  it('refunds a hold without a key whose append failed', async () => {
    const built = build({ wallets: true, budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))

    await expect(built.service.hold(context(), ESTIMATE_A)).rejects.toThrow('connection reset')

    expect(await balance(built)).toBe(10_000_000_000n)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(0n)
  })

  it('keeps the reservation of a hold whose append committed before the error reached the caller, and replays it on retry', async () => {
    const built = build({ wallets: true, budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const append = built.ledgerStore.append.bind(built.ledgerStore)
    jest.spyOn(built.ledgerStore, 'append').mockImplementationOnce(async (...args) => {
      await append(...args)
      throw new Error('timed out after commit')
    })
    const ctx = context({ idempotencyKey: 'h-5' })

    await expect(built.service.hold(ctx, ESTIMATE_A)).rejects.toThrow('timed out after commit')
    const retried = await built.service.hold(ctx, ESTIMATE_A)

    expect(await balance(built)).toBe(10_000_000_000n - retried.estimatedCostNanoUsd)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(retried.estimatedCostNanoUsd)
  })

  /** The reservation recorded under a hold's key belongs to the stored row whether or not a wallet is bound. */
  it('keeps the budget reservation of a committed hold when no wallet is bound', async () => {
    const built = build({ budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const append = built.ledgerStore.append.bind(built.ledgerStore)
    jest.spyOn(built.ledgerStore, 'append').mockImplementationOnce(async (...args) => {
      await append(...args)
      throw new Error('timed out after commit')
    })
    const ctx = context({ idempotencyKey: 'h-b1' })

    await expect(built.service.hold(ctx, ESTIMATE_A)).rejects.toThrow('timed out after commit')
    const retried = await built.service.hold(ctx, ESTIMATE_A)

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(retried.estimatedCostNanoUsd)
    expect(status!.spent.count).toBe(1)
    // The reservation is the committed hold's: its release gives it back.
    await built.service.release(retried, context(), 'done')
    expect((await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' }))[0]!.spent.count).toBe(0)
  })

  it('gives back the budget reservation of a keyed hold whose append failed with no row, so a retry reserves again', async () => {
    const built = build({ budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    const ctx = context({ idempotencyKey: 'h-b2' })

    await expect(built.service.hold(ctx, ESTIMATE_A)).rejects.toThrow('connection reset')
    const [after] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(after!.spent.nanoUsd).toBe(0n)
    const retried = await built.service.hold(ctx, ESTIMATE_A)

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(retried.estimatedCostNanoUsd)
    expect(status!.spent.count).toBe(1)
  })

  /*
   * Invariant: what a failed hold appends is judged by the row the ledger holds. A hold without a key whose append
   * committed keeps its reservation (the reaper reclaims it); a row that is not this attempt's own, found after an error
   * that is not the key conflict, or after the conflict itself, leaves the attempt's own reservation to be given back.
   */
  const FIXED = new Date('2026-06-15T00:00:00.000Z')

  it('keeps the wallet and budget reservation of a hold without a key whose append committed before the error', async () => {
    const built = build({ wallets: true, budgets: true, clock: () => FIXED })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const append = built.ledgerStore.append.bind(built.ledgerStore)
    jest.spyOn(built.ledgerStore, 'append').mockImplementationOnce(async (...args) => {
      await append(...args)
      throw new Error('timed out after commit')
    })

    await expect(built.service.hold(context(), ESTIMATE_A)).rejects.toThrow('timed out after commit')

    expect(await balance(built)).toBeLessThan(10_000_000_000n)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.count).toBe(1)
  })

  it('refunds a hold without a key when the row found after the error carries another instant', async () => {
    const built = build({ wallets: true, budgets: true, clock: () => FIXED })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const other = await built.service.hold(context({ idempotencyKey: 'h-other' }), ESTIMATE_A)
    const stored = await built.ledgerStore.findById(other.id)
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce({ ...stored!, occurredAt: new Date(FIXED.getTime() + 1) })

    await expect(built.service.hold(context(), ESTIMATE_A)).rejects.toThrow('connection reset')

    expect(await balance(built)).toBe(10_000_000_000n - other.estimatedCostNanoUsd)
  })

  it('gives a hold back when the append lost the key conflict to a row that is not the same shape', async () => {
    const built = build({ wallets: true, budgets: true, clock: () => FIXED })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const other = await built.service.hold(context({ idempotencyKey: 'h-other' }), ESTIMATE_A)
    const stored = await built.ledgerStore.findById(other.id)
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new LedgerIdempotencyConflict('tenant-1', 'whatever'))
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce({ ...stored!, enforced: false })

    await expect(built.service.hold(context(), ESTIMATE_A)).rejects.toThrow()

    expect(await balance(built)).toBe(10_000_000_000n - other.estimatedCostNanoUsd)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(other.estimatedCostNanoUsd)
  })

  /** A late reservation that reactivates the key after the winner released it is given back when its append meets the released row. */
  it('gives back a late budget reservation when the winner already released the hold', async () => {
    const built = build({ budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const winner = await built.service.hold(context({ idempotencyKey: 'h-late' }), ESTIMATE_A)
    await built.service.release(winner, context(), 'released before the loser reserves')
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)

    await expect(built.service.hold(context({ idempotencyKey: 'h-late' }), ESTIMATE_A)).rejects.toThrow()

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(0n)
    expect(status!.spent.count).toBe(0)
  })

  /** The same rule for a hold: a reservation the loser applied stays when the winner's pending row stands. */
  it('leaves a reservation the loser applied in place when the winner hold of the same shape stands', async () => {
    const built = build({ budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const winner = await built.service.hold(context({ idempotencyKey: 'h-owned' }), ESTIMATE_A)
    await built.budgets!.release(context(), { nanoUsd: winner.estimatedCostNanoUsd, tokens: 1500, count: 1 }, undefined, 'reserve:h-owned')
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)

    await expect(built.service.hold(context({ idempotencyKey: 'h-owned' }), ESTIMATE_A)).rejects.toThrow()

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.count).toBe(1)
  })

  /*
   * A posted row found by a losing hold is a captured hold or a record, and nothing on it tells them apart. The loser drops
   * its own reference either way: against a captured hold it only replayed the winner's reservation, which the committed
   * reference keeps; against a record it was the sole holder of a reservation of its own and gives it back.
   */
  it.each([
    { name: 'a captured hold of the same payer', winner: 'captured', count: 1 },
    { name: 'a record of the same payer', winner: 'record', count: 1 },
  ])('counts the budget as $count when a losing hold with no wallet meets $name', async ({ winner, count }) => {
    const built = build({ budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    if (winner === 'captured') {
      const won = await built.service.hold(context({ idempotencyKey: 'h-8' }), ESTIMATE_A)
      await built.service.capture(won, context(), normalized())
    } else {
      await built.service.record({ usage: normalized(), context: context({ enforce: true, idempotencyKey: 'h-8' }) })
    }
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)

    await expect(built.service.hold(context({ idempotencyKey: 'h-8' }), ESTIMATE_A)).rejects.toThrow()

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.count).toBe(count)
  })

  /** A system-cost hold reserves nothing, so there is no budget reference to commit. */
  it('commits no budget references for a system-cost hold', async () => {
    const built = build({ budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const commit = jest.spyOn(built.budgets!, 'commit')

    await built.service.hold(context({ isSystemCost: true, systemCostCategory: 'retry' }), ESTIMATE_A)

    expect(commit).not.toHaveBeenCalled()
  })

  it('moves nothing and rethrows when the ledger cannot say whether the row was written', async () => {
    const built = build({ wallets: true, budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('still down'))

    await expect(built.service.hold(context({ idempotencyKey: 'h-6' }), ESTIMATE_A)).rejects.toThrow('connection reset')

    expect(await balance(built)).toBeLessThan(10_000_000_000n)
    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBeGreaterThan(0n)
  })

  /**
   * The ambiguity of a posted row resolves toward keeping the loser's debit, so the worst case is an overcharge and a
   * settled debit is never refunded: against a captured hold the loser's `hold:` debit replays the winner's and the
   * wallet does not move; against a `record()` row (a different wallet key) the loser keeps a debit of its own, one
   * reservation more than the winner's, and gets the conflict.
   */
  it.each([
    { name: 'a captured hold of the same payer', winner: 'captured', extra: 0n },
    { name: 'a record of the same payer', winner: 'record', extra: 6_250_000n },
  ])('keeps the debit of a losing hold that meets $name and never refunds a settled one', async ({ winner, extra }) => {
    const built = build({ wallets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    if (winner === 'captured') {
      const won = await built.service.hold(context({ idempotencyKey: 'h-7' }), ESTIMATE_A)
      await built.service.capture(won, context(), normalized())
    } else {
      await built.service.record({ usage: normalized(), context: context({ enforce: true, idempotencyKey: 'h-7' }) })
    }
    const before = await balance(built)
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)

    await expect(built.service.hold(context({ idempotencyKey: 'h-7' }), ESTIMATE_A)).rejects.toThrow()

    expect(await balance(built)).toBe(before - extra)
  })

  it('gives its budget back when the row found after a generic append error belongs to another attempt', async () => {
    const built = build({ wallets: true, budgets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    await upsertBudget(built, { limitNanoUsd: 1_000_000_000n })
    const winner = await built.service.hold(context({ idempotencyKey: 'h-8' }), ESTIMATE_A)
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    await expect(built.service.hold(context({ idempotencyKey: 'h-8' }), ESTIMATE_A)).rejects.toThrow('connection reset')

    const [status] = await built.budgets!.status('tenant-1', { type: 'user', id: 'u1' })
    expect(status!.spent.nanoUsd).toBe(winner.estimatedCostNanoUsd)
  })

  it('refunds the debit of a losing hold whose key was won by another payer', async () => {
    const built = build({ wallets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n, 'u1')
    await grant(built, 10_000_000_000n, 'u2')
    await built.service.hold(context({ idempotencyKey: 'h-9' }), ESTIMATE_A)
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)

    await expect(built.service.hold(context({ idempotencyKey: 'h-9', scope: { type: 'user', id: 'u2' } }), ESTIMATE_A)).rejects.toThrow()

    const u2 = await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u2' })
    expect(u2.nanoUsd).toBe(10_000_000_000n)
  })

  /** Holds that do not share a key do not wait for each other: only calls with one key are serialized. */
  it.each([
    { name: 'without a key', first: undefined, second: undefined },
    { name: 'with different keys', first: 'h-10', second: 'h-11' },
  ])('does not serialize holds $name', async ({ first, second }) => {
    const built = build({ wallets: true, clock: advancing() })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const debit = built.wallets!.debit.bind(built.wallets)
    jest.spyOn(built.wallets!, 'debit').mockImplementationOnce(async (...args) => {
      await gate
      return debit(...args)
    })
    const blocked = built.service.hold(context(first === undefined ? {} : { idempotencyKey: first }), ESTIMATE_A)

    const other = await built.service.hold(context(second === undefined ? {} : { idempotencyKey: second }), ESTIMATE_A)

    expect(other.id).toBeDefined()
    release()
    await blocked
  })

  it('compensates a losing hold of another payer even when the winner carries the same instant', async () => {
    const instant = new Date(Date.now() + 60_000)
    const built = build({ wallets: true, budgets: true, clock: () => instant })
    await seedGpt5(built.pricingStore)
    await grant(built, 10_000_000_000n, 'u1')
    await grant(built, 10_000_000_000n, 'u2')
    await built.service.hold(context({ idempotencyKey: 'h-12' }), ESTIMATE_A)
    jest.spyOn(built.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    jest.spyOn(built.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))

    await expect(built.service.hold(context({ idempotencyKey: 'h-12', scope: { type: 'user', id: 'u2' } }), ESTIMATE_A)).rejects.toThrow('connection reset')

    const u2 = await built.wallets!.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u2' })
    expect(u2.nanoUsd).toBe(10_000_000_000n)
  })
})
