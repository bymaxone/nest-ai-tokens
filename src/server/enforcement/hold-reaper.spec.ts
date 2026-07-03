import type { NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { MeteringContext } from '../interfaces'
import { LedgerService } from '../services/ledger.service'
import { MarkupResolver } from '../services/markup.resolver'
import { MeteringService } from '../services/metering.service'
import { PricingService } from '../services/pricing.service'
import { WalletService } from '../services/wallet.service'
import { HoldReaper } from './hold-reaper'

/** A representative metering context. */
function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', ...over }
}

/** A variant-A estimate for a 1000-in / 500-out gpt-5 chat call. */
const ESTIMATE = { provider: 'openai' as const, model: 'gpt-5', operation: 'chat' as const, inputTokens: 1000, maxOutputTokens: 500 }

/** Build a metering stack sharing ONE ledger store across N reaper instances. */
function build(ttlSeconds = 60): {
  ledgerStore: InMemoryLedgerStore
  walletStore: InMemoryWalletStore
  service: MeteringService
  ledger: LedgerService
  options: ResolvedAiTokensOptions
  now: () => Date
  reaper: () => HoldReaper
} {
  const nowRef = { value: new Date(Date.now() + 3_600_000) }
  const now = (): Date => nowRef.value
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  const walletStore = new InMemoryWalletStore({ now })
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds, reaperIntervalSeconds: 1 },
    wallets: { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    budgets: { enabled: false },
  } as ResolvedAiTokensOptions
  const ledger = new LedgerService(ledgerStore, options)
  const pricing = new PricingService(options, pricingStore)
  const wallets = new WalletService(walletStore, options.wallets as never)
  const service = new MeteringService(ledger, pricing, new MarkupResolver(options), options, undefined, wallets, undefined, now)
  void pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  return { ledgerStore, walletStore, service, ledger, options, now, reaper: (): HoldReaper => new HoldReaper(ledger, service, options, now) }
}

/** Grant the default user wallet. */
async function grant(wallets: WalletService, amountNanoUsd: bigint): Promise<void> {
  await wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd, idempotencyKey: 'g1', reason: 'seed' })
}

describe('HoldReaper', () => {
  /** The interval starts on bootstrap and clears on shutdown (no open handles). */
  it('starts on bootstrap and clears on shutdown', () => {
    jest.useFakeTimers()
    try {
      const built = build()
      const reaper = built.reaper()
      const sweep = jest.spyOn(reaper, 'sweep').mockResolvedValue()
      reaper.onApplicationBootstrap()
      jest.advanceTimersByTime(3_000)
      expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(2)
      reaper.onApplicationShutdown()
      const after = sweep.mock.calls.length
      jest.advanceTimersByTime(5_000)
      expect(sweep.mock.calls.length).toBe(after)
    } finally {
      jest.clearAllTimers()
      jest.useRealTimers()
    }
  })

  /** A shutdown with no running timer is a safe no-op. */
  it('is a safe no-op when shut down before bootstrap', () => {
    expect(() => build().reaper().onApplicationShutdown()).not.toThrow()
  })

  /** An expired hold is swept once, restoring the wallet; capture afterwards is 410. */
  it('reclaims an expired hold and restores the wallet', async () => {
    const built = build(60)
    const walletRef = { tenantId: 'tenant-1', ownerType: 'user' as const, ownerId: 'u1' }
    const wallets = new WalletService(built.walletStore, built.options.wallets as never)
    await grant(wallets, 100_000_000n)
    const hold = await built.service.hold(context(), ESTIMATE)
    expect((await wallets.getBalance(walletRef)).nanoUsd).toBe(93_750_000n)
    const later = new Date(built.now().getTime() + 3_600_000)
    const reaper = new HoldReaper(built.ledger, built.service, built.options, () => later)
    await reaper.sweep()
    expect((await wallets.getBalance(walletRef)).nanoUsd).toBe(100_000_000n)
    const usage: NormalizedUsage = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
    const captureError = await built.service.capture(hold, usage).catch((e: unknown) => e)
    expect((captureError as { getResponse: () => { error: { code: string } } }).getResponse().error.code).toBe('AI_TOKENS_HOLD_EXPIRED')
  })

  /** Two reaper instances racing on one store reclaim each expired hold exactly once. */
  it('reclaims exactly once when two reapers race', async () => {
    const built = build(60)
    const wallets = new WalletService(built.walletStore, built.options.wallets as never)
    await grant(wallets, 100_000_000n)
    await built.service.hold(context({ idempotencyKey: 'h1' }), ESTIMATE)
    const later = new Date(built.now().getTime() + 3_600_000)
    const restoreSpy = jest.spyOn(built.service, 'restoreReleasedHold')
    const one = new HoldReaper(built.ledger, built.service, built.options, () => later)
    const two = new HoldReaper(built.ledger, built.service, built.options, () => later)
    await Promise.all([one.sweep(), two.sweep()])
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect((await wallets.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** With no injected clock, the reaper sweeps against the real wall clock. */
  it('defaults its clock to the wall clock', async () => {
    const built = build(3_600)
    const reaper = new HoldReaper(built.ledger, built.service, built.options)
    await expect(reaper.sweep()).resolves.toBeUndefined()
  })

  /** A non-expired pending hold is left untouched. */
  it('leaves non-expired holds untouched', async () => {
    const built = build(3_600)
    const wallets = new WalletService(built.walletStore, built.options.wallets as never)
    await grant(wallets, 100_000_000n)
    await built.service.hold(context(), ESTIMATE)
    await built.reaper().sweep()
    expect((await wallets.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
    expect(built.ledgerStore.all().filter((r) => r.status === 'pending')).toHaveLength(1)
  })

  /** A failure on one hold is logged and never aborts the batch. */
  it('isolates a per-hold failure', async () => {
    const built = build(60)
    const wallets = new WalletService(built.walletStore, built.options.wallets as never)
    await grant(wallets, 100_000_000n)
    await built.service.hold(context({ idempotencyKey: 'a' }), ESTIMATE)
    await built.service.hold(context({ idempotencyKey: 'b' }), ESTIMATE)
    const later = new Date(built.now().getTime() + 3_600_000)
    jest.spyOn(built.service, 'restoreReleasedHold').mockRejectedValueOnce(new Error('restore down')).mockResolvedValue()
    const reaper = new HoldReaper(built.ledger, built.service, built.options, () => later)
    await reaper.sweep()
    // The batch continued: exactly one hold remains released-but-unrestored is acceptable; both were transitioned.
    expect(built.ledgerStore.all().filter((r) => r.status === 'released')).toHaveLength(2)
  })
})
