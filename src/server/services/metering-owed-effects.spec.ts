/**
 * @fileoverview Specs of the effects-owed marker and the owed-effects sweep: a transition that commits and whose
 * effects then fail leaves the marker with what the sweep needs, the sweep finishes the wallet and budget legs exactly
 * once, a second pass and two sweepers at once change nothing more, the effects carry the row's own tenant, and the
 * inline path clears the marker. Every outcome is compared with a run in which nothing failed.
 * @layer test
 */
import { Logger } from '@nestjs/common'
import type { Budget, NormalizedUsage } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { Hold, HoldEstimate, MeteringContext } from '../interfaces'
import { ContentCapture } from './content-capture'
import { TelemetryEmitter } from '../telemetry/otel-emitter'
import { BudgetService } from './budget.service'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService, type MeteringEventHooks } from './metering.service'
import { PricingService } from './pricing.service'
import { WalletService } from './wallet.service'

/** A metering context for one tenant and payer; `over` replaces any field. */
function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', ...over }
}

/** A complete normalized usage of the given input tokens. */
function usage(inputTokens = 400, outputTokens = 100): NormalizedUsage {
  return {
    provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens, outputTokens,
    cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0,
    audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0,
  }
}

/** The estimate every hold of this spec reserves. */
const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }

/** The event hooks as jest mocks. */
type MockEvents = { [K in keyof MeteringEventHooks]: jest.Mock }

/** The service under test and its collaborators. */
interface Built {
  service: MeteringService
  ledger: LedgerService
  ledgerStore: InMemoryLedgerStore
  wallets: WalletService
  budgets: BudgetService
  events: MockEvents
}

/** Build a metering service over in-memory stores with a wallet and budgets for two tenants. */
async function build(withoutMarkerCalls = false): Promise<Built> {
  const now = (): Date => new Date()
  const ledgerStore = new InMemoryLedgerStore()
  if (withoutMarkerCalls) for (const name of ['findEffectsOwed', 'findEffectsOwedFor', 'clearEffectsOwed']) Object.defineProperty(ledgerStore, name, { value: undefined })
  const pricingStore = new InMemoryPricingStore()
  const options = {
    ratingMode: 'rate-table', markup: 1, ledger: { hashChain: false },
    pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    settlement: { enabled: true, graceSeconds: 300 },
    wallets: { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    budgets: { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true },
  } as unknown as ResolvedAiTokensOptions
  const ledger = new LedgerService(ledgerStore, options)
  const wallets = new WalletService(new InMemoryWalletStore({ now }), options.wallets as never)
  const budgets = new BudgetService(new InMemoryBudgetStore({ now }), ledger, options.budgets as never, now)
  const events: MockEvents = {
    usageRecorded: jest.fn(() => Promise.resolve()), priceMissing: jest.fn(() => Promise.resolve()),
    holdReleased: jest.fn(() => Promise.resolve()), usageReversed: jest.fn(() => Promise.resolve()), settleFailed: jest.fn(() => Promise.resolve()),
    audit: jest.fn(() => Promise.resolve()),
  }
  const service = new MeteringService(ledger, new PricingService(options, pricingStore), new MarkupResolver(options), options, events, wallets, budgets, now, new TelemetryEmitter(null), new ContentCapture({ enabled: false }))
  await pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  for (const tenantId of ['tenant-1', 'tenant-2']) {
    await wallets.grant({ tenantId, ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 10_000_000_000n, idempotencyKey: `grant-${tenantId}`, reason: 'seed' })
    await budgets.upsertBudget({ tenantId, scope: { type: 'tenant', id: tenantId }, window: 'month', limitNanoUsd: 5_000_000_000n } as Partial<Budget> as never)
  }
  return { service, ledger, ledgerStore, wallets, budgets, events }
}

/** The wallet balance and the budget spend of one tenant, as plain values to compare. */
async function stateOf(built: Built, tenantId: string): Promise<{ wallet: bigint; spent: bigint; tokens: number; count: number }> {
  const wallet = await built.wallets.reconcile({ tenantId, ownerType: 'user', ownerId: 'u1' })
  const [status] = await built.budgets.status(tenantId, { type: 'user', id: 'u1' })
  return { wallet: wallet.nanoUsd, spent: status?.spent.nanoUsd ?? -1n, tokens: status?.spent.tokens ?? -1, count: status?.spent.count ?? -1 }
}

/** Sweep every owed row older than a cutoff in the future, the way the reaper does, and return how many it settled. */
async function sweep(built: Built, only?: (tenantId: string) => boolean): Promise<number> {
  const owed = await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 100)
  let settled = 0
  for (const item of owed) {
    if (only !== undefined && !only(item.record.tenantId)) continue
    await built.service.settleOwedEffects(item)
    settled += 1
  }
  return settled
}

/** Hold in a tenant and return the hold with the caller that owns it. */
async function holdIn(built: Built, tenantId = 'tenant-1'): Promise<{ hold: Hold; caller: { tenantId: string; scope: { type: 'user'; id: string } } }> {
  const hold = await built.service.hold(context({ tenantId }), ESTIMATE)
  return { hold, caller: { tenantId, scope: { type: 'user', id: 'u1' } } }
}

describe('the effects-owed marker and the owed-effects sweep', () => {
  /** A capture whose effects fail after the transition keeps the marker with the reserved values; the sweep settles once. */
  it('settles a capture whose effects failed, exactly once', async () => {
    const control = await build()
    const { hold: heldControl, caller } = await holdIn(control)
    await control.service.capture(heldControl, caller, usage())

    const built = await build()
    const { hold } = await holdIn(built)
    jest.spyOn(built.wallets, 'settleAdjustment').mockRejectedValueOnce(new Error('wallet down'))
    await expect(built.service.capture(hold, caller, usage())).rejects.toThrow('wallet down')

    const owed = await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)
    expect(owed).toHaveLength(1)
    expect(owed[0]?.reservedBilledNanoUsd).toBeGreaterThan(owed[0]?.record.billedCostNanoUsd ?? 0n)
    expect(owed[0]?.reservedTokens).toBe(1500)

    expect(await sweep(built)).toBe(1)
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await sweep(built)).toBe(0)
    expect(await sweep(built)).toBe(0)
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
  })

  /**
   * The documented limit of a store without the marker calls: a capture whose wallet leg fails after the transition
   * leaves the record posted at its actual cost while the wallet keeps the hold's reserved debit, a repeated capture
   * returns the posted record without moving the leg, and nothing is owed that a sweep could find.
   */
  it('leaves the capture unapplied on a store without the marker calls, and a repeated capture does not apply it', async () => {
    const control = await build()
    const { hold: heldControl, caller } = await holdIn(control)
    await control.service.capture(heldControl, caller, usage())

    const built = await build(true)
    const { hold } = await holdIn(built)
    const reservedWallet = (await stateOf(built, 'tenant-1')).wallet
    jest.spyOn(built.wallets, 'settleAdjustment').mockRejectedValueOnce(new Error('wallet down'))
    await expect(built.service.capture(hold, caller, usage())).rejects.toThrow('wallet down')

    const posted = await built.service.capture(hold, caller, usage())
    expect(posted.status).toBe('posted')
    expect((await stateOf(built, 'tenant-1')).wallet).toBe(reservedWallet)
    expect(reservedWallet).toBeLessThan((await stateOf(control, 'tenant-1')).wallet)
    expect(await sweep(built)).toBe(0)
  })

  /** A release whose effects fail after the transition is finished by the sweep. */
  it('settles a release whose effects failed, exactly once', async () => {
    const control = await build()
    const { hold: heldControl, caller } = await holdIn(control)
    await control.service.release(heldControl, caller, 'done')

    const built = await build()
    const { hold } = await holdIn(built)
    jest.spyOn(built.wallets, 'refund').mockRejectedValueOnce(new Error('wallet down'))
    await expect(built.service.release(hold, caller, 'done')).rejects.toThrow('wallet down')
    expect(await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)).toHaveLength(1)

    expect(await sweep(built)).toBe(1)
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await sweep(built)).toBe(0)
  })

  /** A reversal whose refund fails stays marked on the compensating row, and the sweep completes it. */
    it('keeps a failed reversal refund marked and completes it in the sweep', async () => {
    const control = await build()
    const recordedControl = await control.service.record({ usage: usage(), context: context({ enforce: true, idempotencyKey: 'k' }) })
    await control.service.reverse(recordedControl.id, 'oops')

    const built = await build()
    const recorded = await built.service.record({ usage: usage(), context: context({ enforce: true, idempotencyKey: 'k' }) })
    jest.spyOn(built.wallets, 'refund').mockRejectedValueOnce(new Error('wallet down'))
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const compensating = await built.service.reverse(recorded.id, 'oops')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a leg of a reversal failed; its effects are left to the settlement sweep'))
    warn.mockRestore()
    const owed = await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)
    expect(owed.map((item) => item.record.id)).toEqual([compensating.id])
    expect(owed[0]?.record.reversesRecordId).toBe(recorded.id)

    expect(await sweep(built)).toBe(1)
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await sweep(built)).toBe(0)
  })

  /** A crash between the compensating append and the annotation of the original: the sweep finishes the annotation too. */
  it('finishes the annotation of the original when the crash came before it', async () => {
    const control = await build()
    const recordedControl = await control.service.record({ usage: usage(), context: context({ enforce: true, idempotencyKey: 'k' }) })
    await control.service.reverse(recordedControl.id, 'oops')

    const built = await build()
    const recorded = await built.service.record({ usage: usage(), context: context({ enforce: true, idempotencyKey: 'k' }) })
    jest.spyOn(built.ledger, 'transition').mockRejectedValueOnce(new Error('connection lost'))
    await expect(built.service.reverse(recorded.id, 'oops')).rejects.toThrow('connection lost')
    expect((await built.ledger.findById(recorded.id))?.status).toBe('posted')

    expect(await sweep(built)).toBe(1)
    const original = await built.ledger.findById(recorded.id)
    expect(original?.status).toBe('reversed')
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
  })

  /** The inline path pays one extra statement and leaves no marker behind. */
  it('clears the marker on the inline path of a capture, a release and a reversal', async () => {
    const built = await build()
    const first = await holdIn(built)
    await built.service.capture(first.hold, first.caller, usage())
    const second = await holdIn(built)
    await built.service.release(second.hold, second.caller, 'done')
    const recorded = await built.service.record({ usage: usage(), context: context({ enforce: true, idempotencyKey: 'k' }) })
    await built.service.reverse(recorded.id, 'oops')
    expect(await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)).toEqual([])
  })

  /** Sweeping one tenant's owed row moves nothing of another tenant's wallet, budget or references. */
  it('runs every effect with the row\'s own tenant', async () => {
    const built = await build()
    const one = await holdIn(built, 'tenant-1')
    const two = await holdIn(built, 'tenant-2')
    jest.spyOn(built.wallets, 'settleAdjustment').mockRejectedValue(new Error('wallet down'))
    await expect(built.service.capture(one.hold, one.caller, usage())).rejects.toThrow()
    await expect(built.service.capture(two.hold, two.caller, usage())).rejects.toThrow()
    jest.restoreAllMocks()
    const otherBefore = await stateOf(built, 'tenant-2')

    expect(await sweep(built, (tenantId) => tenantId === 'tenant-1')).toBe(1)
    expect(await stateOf(built, 'tenant-2')).toEqual(otherBefore)
    expect((await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)).map((item) => item.record.tenantId)).toEqual(['tenant-2'])
  })

  /** Two sweepers over the same owed rows, holding no lock between them, move each leg once. */
  it('lets two sweepers run at once without moving anything twice', async () => {
    const control = await build()
    const { hold: heldControl, caller } = await holdIn(control)
    await control.service.capture(heldControl, caller, usage())

    const built = await build()
    const { hold } = await holdIn(built)
    jest.spyOn(built.wallets, 'settleAdjustment').mockRejectedValueOnce(new Error('wallet down'))
    await expect(built.service.capture(hold, caller, usage())).rejects.toThrow()

    await Promise.all([sweep(built), sweep(built)])
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await sweep(built)).toBe(0)
  })

  /** The sweep re-emits the event a transition owes, at least once. */
  it('emits the event the transition owed', async () => {
    const built = await build()
    const { hold, caller } = await holdIn(built)
    jest.spyOn(built.wallets, 'refund').mockRejectedValueOnce(new Error('wallet down'))
    await expect(built.service.release(hold, caller, 'done')).rejects.toThrow()
    built.events.holdReleased.mockClear()
    await sweep(built)
    expect(built.events.holdReleased).toHaveBeenCalledTimes(1)
  })

  /** A marker that cannot be cleared inline does not fail the call: the keyed legs ran, and the sweep repeats them for nothing. */
  it('does not fail a capture whose marker could not be cleared', async () => {
    const built = await build()
    const { hold, caller } = await holdIn(built)
    jest.spyOn(built.ledger, 'clearEffectsOwed').mockRejectedValueOnce(new Error('connection lost'))
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      await expect(built.service.capture(hold, caller, usage())).resolves.toMatchObject({ status: 'posted' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to clear the effects-owed marker'))
    } finally {
      warn.mockRestore()
    }
    const before = await stateOf(built, 'tenant-1')
    expect(await sweep(built)).toBe(1)
    expect(await stateOf(built, 'tenant-1')).toEqual(before)
  })

  /**
   * Invariant: the capture legs of a hold are owed until they run, whatever happens to the row meanwhile. A captured hold
   * whose wallet leg failed and that is then reversed has its reserved-minus-actual difference settled by the reversal,
   * so the wallet and the budget end as in a run in which nothing failed and nothing is left owed.
   */
  it('settles the capture legs of a hold that was reversed before the sweep ran', async () => {
    const control = await build()
    const { hold: heldControl, caller } = await holdIn(control)
    const capturedControl = await control.service.capture(heldControl, caller, usage())
    await control.service.reverse(capturedControl.id, 'oops')

    const built = await build()
    const { hold } = await holdIn(built)
    jest.spyOn(built.wallets, 'settleAdjustment').mockRejectedValueOnce(new Error('wallet down'))
    await expect(built.service.capture(hold, caller, usage())).rejects.toThrow('wallet down')
    await built.service.reverse(hold.id, 'oops')
    expect((await built.ledger.findById(hold.id))?.status).toBe('reversed')

    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await sweep(built)).toBe(0)
  })

  /** The actuals of this capture exceed what the hold reserved, in cost and in tokens, so a reversal that subtracts them first is clamped at zero. */
  const BIGGER = (): NormalizedUsage => usage(3_000, 1_500)

  /** One run: an optional other spend, a hold, a capture whose budget adjustment fails or not, then the reversal as the case says. */
  async function reversedRun(options: { otherSpend: boolean; captureFails: boolean; settleAgainFails?: boolean }): Promise<{ built: Built; id: string }> {
    const built = await build()
    if (options.otherSpend) await built.service.record({ usage: usage(), context: context({ enforce: true, idempotencyKey: 'other' }) })
    const { hold, caller } = await holdIn(built)
    if (options.captureFails) jest.spyOn(built.budgets, 'adjust').mockRejectedValueOnce(new Error('budget down'))
    if (options.captureFails) await expect(built.service.capture(hold, caller, BIGGER())).rejects.toThrow('budget down')
    else await built.service.capture(hold, caller, BIGGER())
    if (options.settleAgainFails === true) jest.spyOn(built.budgets, 'adjust').mockRejectedValueOnce(new Error('budget down again'))
    await built.service.reverse(hold.id, 'oops')
    return { built, id: hold.id }
  }

  /**
   * Invariant: a reversal settles the original's outstanding capture legs before it reverses, so the window never goes
   * below what the call added and the clamp at zero cannot eat the reversal. Reserve 100, actuals 200 (cost and tokens),
   * the capture's budget adjustment fails, the hold is reversed inline: the window returns to its pre-call value.
   */
  it('settles the outstanding capture legs before the inline reversal, in cost and in tokens', async () => {
    const control = (await reversedRun({ otherSpend: false, captureFails: false })).built
    const { built } = await reversedRun({ otherSpend: false, captureFails: true })
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await stateOf(built, 'tenant-1')).toMatchObject({ spent: 0n, tokens: 0, count: 0 })
    expect(await sweep(built)).toBe(0)
  })

  /** The same invariant when the reversal's settle of the original fails too, so both rows stay owed and the sweep must order them itself, compensating row first. */
  it('settles the original\'s capture legs before the reversal legs in the sweep, whichever row it reaches first', async () => {
    const control = (await reversedRun({ otherSpend: false, captureFails: false })).built
    const { built, id } = await reversedRun({ otherSpend: false, captureFails: true, settleAgainFails: true })
    const owed = await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)
    expect(owed.map((item) => item.record.id)).toContain(id)
    expect(owed).toHaveLength(2)
    const compensatingFirst = [...owed].sort((a) => (a.record.reversesRecordId === undefined ? 1 : -1))
    for (const item of compensatingFirst) await built.service.settleOwedEffects(item)
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await stateOf(built, 'tenant-1')).toMatchObject({ spent: 0n, tokens: 0, count: 0 })
    expect(await sweep(built)).toBe(0)
  })

  /** With other spend in the window the clamp never bites, so the order did not matter; the result is the same as the control. */
  it('ends as the control when the window holds other spend', async () => {
    const control = (await reversedRun({ otherSpend: true, captureFails: false })).built
    const { built } = await reversedRun({ otherSpend: true, captureFails: true })
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await sweep(built)).toBe(0)
  })

  /**
   * Invariant: the sweep completes a reversal with the payload the inline path already sent, so a refund that succeeded
   * inline is replayed and not refused as a conflict. The refund of a reversal carries the caller's reason, and a wallet
   * replay matches on it; a reversal whose refund succeeded and whose budget release failed is finished by the sweep.
   */
  it('completes a reversal whose refund already succeeded, with the reason the caller gave', async () => {
    const control = await build()
    const recordedControl = await control.service.record({ usage: usage(), context: context({ enforce: true, idempotencyKey: 'k' }) })
    await control.service.reverse(recordedControl.id, 'customer-dispute')

    const built = await build()
    const recorded = await built.service.record({ usage: usage(), context: context({ enforce: true, idempotencyKey: 'k' }) })
    jest.spyOn(built.budgets, 'adjust').mockRejectedValueOnce(new Error('budget down'))
    const compensating = await built.service.reverse(recorded.id, 'customer-dispute')
    const [owed] = await built.ledger.findEffectsOwed(new Date(Date.now() + 60_000), 10)
    expect(owed?.record.id).toBe(compensating.id)

    expect(await sweep(built)).toBe(1)
    expect(await stateOf(built, 'tenant-1')).toEqual(await stateOf(control, 'tenant-1'))
    expect(await sweep(built)).toBe(0)
  })
})

