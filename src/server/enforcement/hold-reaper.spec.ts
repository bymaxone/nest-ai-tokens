import { Logger } from '@nestjs/common'
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

  /**
   * Shutdown before bootstrap must NOT call clearInterval (the timer is still undefined).
   * Kills ConditionalExpression→true on the `this.timer !== undefined` guard, which would
   * unconditionally invoke clearInterval(undefined) even when no interval was ever started.
   */
  it('does not call clearInterval when no timer is running', () => {
    const clearSpy = jest.spyOn(globalThis, 'clearInterval')
    const before = clearSpy.mock.calls.length
    build().reaper().onApplicationShutdown()
    expect(clearSpy.mock.calls.length).toBe(before)
    clearSpy.mockRestore()
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
    // The reaper always flags the release as `expired = true` — kills BooleanLiteral→false on the third argument:
    expect(restoreSpy).toHaveBeenCalledWith(expect.anything(), 'expired', true)
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
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const reaper = new HoldReaper(built.ledger, built.service, built.options, () => later)
    await reaper.sweep()
    // The failed hold was logged — kills BlockStatement→{} which would empty the catch and skip the warning:
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to reap expired hold'))
    warnSpy.mockRestore()
    // The batch continued: exactly one hold remains released-but-unrestored is acceptable; both were transitioned.
    expect(built.ledgerStore.all().filter((r) => r.status === 'released')).toHaveLength(2)
  })

  /**
   * A rejected expired-hold scan (e.g. a dropped database connection) is logged under its
   * stable key and ends the sweep without throwing; the next sweep runs normally.
   */
  it('logs a failed expired-hold scan and recovers on the next sweep', async () => {
    const built = build(60)
    const walletRef = { tenantId: 'tenant-1', ownerType: 'user' as const, ownerId: 'u1' }
    const wallets = new WalletService(built.walletStore, built.options.wallets as never)
    await grant(wallets, 100_000_000n)
    await built.service.hold(context(), ESTIMATE)
    const later = new Date(built.now().getTime() + 3_600_000)
    const dropped = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' })
    jest.spyOn(built.ledger, 'findExpiredHolds').mockRejectedValueOnce(dropped)
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const reaper = new HoldReaper(built.ledger, built.service, built.options, () => later)
    try {
      await expect(reaper.sweep()).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith('ai_tokens.hold_reaper.scan_failed name=Error message="Connection terminated unexpectedly" code=ECONNRESET')
      expect((await wallets.getBalance(walletRef)).nanoUsd).toBe(93_750_000n)
      await reaper.sweep()
      expect((await wallets.getBalance(walletRef)).nanoUsd).toBe(100_000_000n)
    } finally {
      warnSpy.mockRestore()
    }
  })

  /** The log line carries a numeric `code`, omits an absent one, and never dumps a non-`Error` value. */
  it.each([
    [Object.assign(new TypeError('bad'), { code: 57 }), 'ai_tokens.hold_reaper.scan_failed name=TypeError message="bad" code=57'],
    [Object.assign(new Error('bad'), { code: { host: 'db' } }), 'ai_tokens.hold_reaper.scan_failed name=Error message="bad"'],
    [new Error('bad'), 'ai_tokens.hold_reaper.scan_failed name=Error message="bad"'],
    [{ password: 'secret' }, 'ai_tokens.hold_reaper.scan_failed non-Error rejection'],
  ])('summarises a scan rejection safely (%#)', async (rejection, expected) => {
    const built = build(60)
    jest.spyOn(built.ledger, 'findExpiredHolds').mockRejectedValueOnce(rejection)
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      await expect(built.reaper().sweep()).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expected)
    } finally {
      warnSpy.mockRestore()
    }
  })

  /** No rejection out of a timer-driven sweep can escape as an unhandled rejection. */
  it('contains a rejected sweep inside the timer callback', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    jest.useFakeTimers()
    const reaper = build().reaper()
    try {
      jest.spyOn(reaper, 'sweep').mockRejectedValue(new Error('clock exploded'))
      reaper.onApplicationBootstrap()
      await jest.advanceTimersByTimeAsync(1_000)
      expect(warnSpy).toHaveBeenCalledWith('ai_tokens.hold_reaper.sweep_failed name=Error message="clock exploded"')
    } finally {
      reaper.onApplicationShutdown()
      jest.useRealTimers()
      await new Promise((resolve) => setImmediate(resolve))
      process.off('unhandledRejection', unhandled)
      warnSpy.mockRestore()
    }
    expect(unhandled).not.toHaveBeenCalled()
  })
})
