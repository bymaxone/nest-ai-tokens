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
    const captureError = await built.service.capture(hold, context(), usage).catch((e: unknown) => e)
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

  /**
   * The settlement sweep rides on the same tick: a release whose wallet refund failed leaves the marker, and the sweep
   * finishes it once the marker is older than the grace.
   */
  describe('the settlement sweep', () => {
    /** A hold released by its caller whose refund failed, as the owed row the sweep finds. */
    async function owedRelease(built: ReturnType<typeof build>, wallets: WalletService): Promise<void> {
      await grant(wallets, 10_000_000_000n)
      const hold = await built.service.hold(context(), ESTIMATE)
      jest.spyOn(wallets, 'refund').mockRejectedValueOnce(new Error('wallet down'))
      await expect(built.service.release(hold, { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' } }, 'done')).rejects.toThrow('wallet down')
    }

    /** Rebuild the wallet service the stack uses, so a spy reaches the refund the service calls. */
    function walletsOf(built: ReturnType<typeof build>): WalletService {
      return (built.service as unknown as { wallets: WalletService }).wallets
    }

    /** A marker older than the grace is finished by the sweep, and one younger than the grace is left alone. */
    it('settles an owed row older than the grace and leaves a younger one', async () => {
      const built = build()
      await owedRelease(built, walletsOf(built))
      built.options.settlement = { enabled: true, graceSeconds: 7_200, retentionSeconds: 604_800 }
      await built.reaper().sweep()
      expect(await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)).toHaveLength(1)
      built.options.settlement = { enabled: true, graceSeconds: 300, retentionSeconds: 604_800 }
      await built.reaper().sweep()
      expect(await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)).toHaveLength(0)
      const wallet = await walletsOf(built).reconcile({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })
      expect(wallet.nanoUsd).toBe(10_000_000_000n)
    })

    /** A disabled sweep never scans. */
    it('does not scan when the sweep is disabled', async () => {
      const built = build()
      built.options.settlement = { enabled: false, graceSeconds: 300, retentionSeconds: 604_800 }
      const scan = jest.spyOn(built.ledger, 'findEffectsOwed')
      await built.reaper().sweep()
      expect(scan).not.toHaveBeenCalled()
    })

    /** Rows that fail on every tick produce one summary line per tick, with the count and never an amount. */
    it('logs one summary per tick for rows that keep failing, not one line per row', async () => {
      const built = build()
      const wallets = walletsOf(built)
      await owedRelease(built, wallets)
      await owedRelease(built, wallets)
      jest.spyOn(built.service, 'settleOwedEffects').mockRejectedValue(new Error('wallet down 1000000000'))
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      try {
        await built.reaper().sweep()
        await built.reaper().sweep()
        const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('settlement_sweep_failed'))
        expect(lines).toHaveLength(2)
        const [oldest] = await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)
        expect(lines[0]).toBe(`ai_tokens.hold_reaper.settlement_sweep_failed count=2 first=${oldest?.record.id ?? ''}`)
        expect(lines[0]).not.toContain('1000000000')
      } finally {
        warn.mockRestore()
      }
    })

    /** A scan of the owed rows that fails is logged under the scan key and ends the tick without throwing. */
    it('logs a failed scan of the owed rows and ends the tick', async () => {
      const built = build()
      jest.spyOn(built.ledger, 'findEffectsOwed').mockRejectedValue(new Error('database down'))
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      try {
        await expect(built.reaper().sweep()).resolves.toBeUndefined()
        expect(warn).toHaveBeenCalledWith('ai_tokens.hold_reaper.scan_failed name=Error message="database down"')
      } finally {
        warn.mockRestore()
      }
    })

    /** A tick whose rows all settle logs nothing about the sweep. */
    it('logs nothing when every owed row settles', async () => {
      const built = build()
      await owedRelease(built, walletsOf(built))
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      try {
        await built.reaper().sweep()
        expect(warn.mock.calls.filter(([line]) => String(line).includes('settlement_sweep_failed'))).toHaveLength(0)
      } finally {
        warn.mockRestore()
      }
    })

    /** A store that keeps no marker leaves the sweep inactive, and the reaper says so once at boot. */
    it('says once at boot that the sweep is inactive for a store without the marker', () => {
      const built = build()
      ;(built.ledgerStore as { findEffectsOwed?: unknown }).findEffectsOwed = undefined
      const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      jest.useFakeTimers()
      const reaper = built.reaper()
      try {
        reaper.onApplicationBootstrap()
        jest.advanceTimersByTime(5_000)
        expect(log.mock.calls.filter(([line]) => String(line).includes('settlement_sweep_inactive'))).toHaveLength(1)
      } finally {
        reaper.onApplicationShutdown()
        jest.useRealTimers()
        log.mockRestore()
      }
    })

    /** Nothing is said at boot when the store keeps the marker, or when the sweep is switched off. */
    it('says nothing at boot when the store keeps the marker or the sweep is disabled', () => {
      const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      jest.useFakeTimers()
      try {
        const kept = build()
        const keptReaper = kept.reaper()
        keptReaper.onApplicationBootstrap()
        keptReaper.onApplicationShutdown()
        const off = build()
        ;(off.ledgerStore as { findEffectsOwed?: unknown }).findEffectsOwed = undefined
        off.options.settlement = { enabled: false, graceSeconds: 300, retentionSeconds: 604_800 }
        const offReaper = off.reaper()
        offReaper.onApplicationBootstrap()
        offReaper.onApplicationShutdown()
        expect(log.mock.calls.filter(([line]) => String(line).includes('settlement_sweep_inactive'))).toHaveLength(0)
      } finally {
        jest.useRealTimers()
        log.mockRestore()
      }
    })

    /** The reaper's own release carries the marker too, so a refund that fails on an expired hold is finished by the next tick. */
    it('finishes an expired hold whose refund failed', async () => {
      const built = build(60)
      const wallets = walletsOf(built)
      await grant(wallets, 10_000_000_000n)
      await built.service.hold(context(), ESTIMATE)
      jest.spyOn(wallets, 'refund').mockRejectedValueOnce(new Error('wallet down'))
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      try {
        built.options.settlement = { enabled: true, graceSeconds: 7_200, retentionSeconds: 604_800 }
        await built.reaper().sweep()
        expect((await wallets.reconcile({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).not.toBe(10_000_000_000n)
        built.options.settlement = { enabled: true, graceSeconds: 300, retentionSeconds: 604_800 }
        await built.reaper().sweep()
        expect((await wallets.reconcile({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(10_000_000_000n)
      } finally {
        warn.mockRestore()
      }
    })
  })

  /** The budget-reference sweep rides on the same tick, after the owed effects, and the settlement switch turns it off with them. */
  describe('the budget-reference sweep', () => {
    function withSweeper(enabled: boolean): { sweep: jest.Mock; run: () => Promise<void> } {
      const built = build()
      const sweep = jest.fn().mockResolvedValue(undefined)
      built.options.settlement = { enabled, graceSeconds: 300, retentionSeconds: 604_800 }
      const reaper = new HoldReaper(built.ledger, built.service, built.options, built.now, { sweep } as never)
      return { sweep, run: (): Promise<void> => reaper.sweep() }
    }

    it('runs once per tick when the settlement sweep is enabled', async () => {
      const { sweep, run } = withSweeper(true)
      await run()
      await run()
      expect(sweep).toHaveBeenCalledTimes(2)
    })

    it('does not run when the settlement sweep is disabled', async () => {
      const { sweep, run } = withSweeper(false)
      await run()
      expect(sweep).not.toHaveBeenCalled()
    })

    it('is optional: a reaper built without one sweeps as before', async () => {
      await expect(build().reaper().sweep()).resolves.toBeUndefined()
    })
  })

  /** The orphan-debit sweep is the last step of the tick, switched off with the rest of the settlement sweep. */
  describe('the orphan-debit sweep', () => {
    function withOrphans(
      enabled: boolean,
      supported = true,
    ): { sweep: jest.Mock; boot: () => void; run: () => Promise<void> } {
      const built = build()
      const sweep = jest.fn().mockResolvedValue(undefined)
      built.options.settlement = { enabled, graceSeconds: 300, retentionSeconds: 604_800 }
      const reaper = new HoldReaper(
        built.ledger,
        built.service,
        built.options,
        built.now,
        undefined,
        { sweep, supported } as never,
      )
      return {
        sweep,
        boot: (): void => reaper.onApplicationBootstrap(),
        run: (): Promise<void> => reaper.sweep(),
      }
    }

    it('runs once per tick when the settlement sweep is enabled, and not when it is disabled', async () => {
      const on = withOrphans(true)
      await on.run()
      await on.run()
      expect(on.sweep).toHaveBeenCalledTimes(2)
      const off = withOrphans(false)
      await off.run()
      expect(off.sweep).not.toHaveBeenCalled()
    })

    it('says once at boot that the sweep is inactive for a wallet store that cannot list debits, and nothing when it can', () => {
      jest.useFakeTimers()
      const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const lines = (): string[] => log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('orphan_debit_sweep_inactive'))
      try {
        withOrphans(true, true).boot()
        expect(lines()).toEqual([])
        withOrphans(true, false).boot()
        expect(lines()).toEqual(['ai_tokens.hold_reaper.orphan_debit_sweep_inactive the wallet store lists no debits across wallets'])
      } finally {
        jest.clearAllTimers()
        jest.useRealTimers()
        log.mockRestore()
      }
    })
  })
})
