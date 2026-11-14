/**
 * @fileoverview Specs of the settlement of one owed row at its edges: the values a capture keeps and their fallback, a
 * reversal whose original is gone, already annotated or not enforced, and a row of a kind that owes no effect.
 * @layer server
 */
import type { UsageRecord } from '../../shared'
import type { OwedEffects } from '../interfaces'
import { settleOwed, type OwedEffectsDeps } from './owed-effects'

/** A usage record with the given overrides. */
function row(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1', tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'posted', billedCostNanoUsd: 10n, totalTokens: 7,
    enforced: true, isSystemCost: false, ...over,
  } as UsageRecord
}

/** The collaborators as jest mocks, with the deps they build. */
interface Mocks {
  deps: OwedEffectsDeps
  ledger: { findById: jest.Mock; transition: jest.Mock; clearEffectsOwed: jest.Mock }
  effects: { settleCapture: jest.Mock; restoreHold: jest.Mock; reverseEffects: jest.Mock }
  events: { usageRecorded: jest.Mock; holdReleased: jest.Mock; usageReversed: jest.Mock }
}

/** Build the mocks; `original` is what the lookup of a reversal's original returns. */
function deps(original: UsageRecord | null = null): Mocks {
  const ledger = { findById: jest.fn(() => Promise.resolve(original)), transition: jest.fn(() => Promise.resolve(null)), clearEffectsOwed: jest.fn(() => Promise.resolve(true)) }
  const effects = { settleCapture: jest.fn(() => Promise.resolve()), restoreHold: jest.fn(() => Promise.resolve()), reverseEffects: jest.fn(() => Promise.resolve()) }
  const events = { usageRecorded: jest.fn(() => Promise.resolve()), holdReleased: jest.fn(() => Promise.resolve()), usageReversed: jest.fn(() => Promise.resolve()) }
  return { deps: { ledger, effects, events } as unknown as OwedEffectsDeps, ledger, effects, events }
}

describe('settleOwed', () => {
  /** A capture settles the difference between what the hold reserved and the actuals, then emits and clears. */
  it('settles a capture from the reserved values the marker kept', async () => {
    const d = deps()
    const owed: OwedEffects = { record: row(), reservedBilledNanoUsd: 25n, reservedTokens: 15 }
    await settleOwed(d.deps, owed)
    expect(d.effects.settleCapture).toHaveBeenCalledWith(owed.record, 25n, 15, 10n, 7)
    expect(d.events.usageRecorded).toHaveBeenCalledWith(owed.record)
    expect(d.ledger.clearEffectsOwed).toHaveBeenCalledWith('r1')
  })

  /** A marker without reserved values settles against the row's own amounts, which moves nothing. */
  it('falls back to the amounts of the row when the marker kept no reserved values', async () => {
    const d = deps()
    await settleOwed(d.deps, { record: row() })
    expect(d.effects.settleCapture).toHaveBeenCalledWith(expect.anything(), 10n, 7, 10n, 7)
  })

  /** A released hold gives its reservation back, emits the release and clears. */
  it('restores a released hold', async () => {
    const d = deps()
    await settleOwed(d.deps, { record: row({ status: 'released' }) })
    expect(d.effects.restoreHold).toHaveBeenCalledTimes(1)
    expect(d.events.holdReleased).toHaveBeenCalledTimes(1)
    expect(d.effects.settleCapture).not.toHaveBeenCalled()
    expect(d.ledger.clearEffectsOwed).toHaveBeenCalledTimes(1)
  })

  /** A reversal whose original is still posted is annotated, refunded, announced and cleared. */
  it('finishes the annotation of a posted original, then the effects', async () => {
    const original = row({ id: 'orig', status: 'posted' })
    const d = deps(original)
    await settleOwed(d.deps, { record: row({ id: 'comp', reversesRecordId: 'orig', status: 'posted' }) })
    expect(d.ledger.transition).toHaveBeenCalledWith('orig', 'posted', 'reversed', { reversedByRecordId: 'comp' })
    expect(d.effects.reverseEffects).toHaveBeenCalledWith(original, expect.any(String))
    expect(d.events.usageReversed).toHaveBeenCalledWith(original, 'comp', expect.any(String))
    expect(d.ledger.clearEffectsOwed).toHaveBeenCalledWith('comp')
  })

  /** An original that was already annotated is not annotated again. */
  it('does not annotate an original that is already reversed', async () => {
    const d = deps(row({ id: 'orig', status: 'reversed' }))
    await settleOwed(d.deps, { record: row({ id: 'comp', reversesRecordId: 'orig' }) })
    expect(d.ledger.transition).not.toHaveBeenCalled()
    expect(d.effects.reverseEffects).toHaveBeenCalledTimes(1)
  })

  /** An original that never moved money (not enforced, or a system cost) owes no refund and no budget release. */
  it('runs no effect for an original that was not enforced or was a system cost', async () => {
    for (const over of [{ enforced: false }, { isSystemCost: true }]) {
      const d = deps(row({ id: 'orig', status: 'reversed', ...over }))
      await settleOwed(d.deps, { record: row({ id: 'comp', reversesRecordId: 'orig' }) })
      expect(d.effects.reverseEffects).not.toHaveBeenCalled()
      expect(d.events.usageReversed).toHaveBeenCalledTimes(1)
    }
  })

  /** A reversal whose original is gone has nothing to finish; the marker is cleared so it is not found again. */
  it('clears the marker of a reversal whose original is missing', async () => {
    const d = deps(null)
    await settleOwed(d.deps, { record: row({ id: 'comp', reversesRecordId: 'orig' }) })
    expect(d.effects.reverseEffects).not.toHaveBeenCalled()
    expect(d.events.usageReversed).not.toHaveBeenCalled()
    expect(d.ledger.clearEffectsOwed).toHaveBeenCalledWith('comp')
  })

  /** A row of a kind that owes no effect (a pending one) only has its marker cleared. */
  it('only clears the marker of a row that owes no effect', async () => {
    const d = deps()
    await settleOwed(d.deps, { record: row({ status: 'pending' }) })
    expect(d.effects.settleCapture).not.toHaveBeenCalled()
    expect(d.effects.restoreHold).not.toHaveBeenCalled()
    expect(d.ledger.clearEffectsOwed).toHaveBeenCalledTimes(1)
  })

  /** A leg that fails leaves the marker, so the next tick finds the row again. */
  it('does not clear the marker when an effect fails', async () => {
    const d = deps()
    d.effects.restoreHold.mockRejectedValueOnce(new Error('wallet down'))
    await expect(settleOwed(d.deps, { record: row({ status: 'released' }) })).rejects.toThrow('wallet down')
    expect(d.ledger.clearEffectsOwed).not.toHaveBeenCalled()
  })
})
