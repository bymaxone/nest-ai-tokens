/**
 * @fileoverview The key sets of the budget snapshots and counter dimensions.
 * @layer test
 */

import { buildStatus, limitSnapshot, limitsOf, remainingSnapshot } from './budget-math'
import { counterDimensions, counterTtlSeconds } from './budget.keys'

const NONE = { spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 }
const START = new Date('2026-06-15T00:00:00.000Z')

describe('budget-math — a dimension a budget does not limit is absent, not undefined', () => {
  it.each([
    ['nanoUsd', { limitNanoUsd: 5n }, { nanoUsd: 5n }],
    ['tokens', { limitTokens: 5 }, { tokens: 5 }],
    ['count', { limitCount: 5 }, { count: 5 }]
  ])('limitsOf lists only %s', (_name, budget, expected) => {
    // Scenario: a consumer that enumerates the limits must not see a key for a dimension that is not limited.
    expect({ ...limitsOf(budget as never) }).toStrictEqual(expected)
  })

  it.each([
    ['nanoUsd', { nanoUsd: 5n }],
    ['tokens', { tokens: 5 }],
    ['count', { count: 5 }]
  ])('limitSnapshot lists only %s', (_name, limits) => {
    // Scenario: the event payload carries the limited dimensions only.
    expect(limitSnapshot(limits)).toStrictEqual(limits)
  })

  it.each([
    ['nanoUsd', { nanoUsd: 5n }, { spentNanoUsd: 2n }, { nanoUsd: 3n }],
    ['tokens', { tokens: 5 }, { spentTokens: 2 }, { tokens: 3 }],
    ['count', { count: 5 }, { spentCount: 2 }, { count: 3 }]
  ])('remainingSnapshot lists only %s', (_name, limits, spent, expected) => {
    // Scenario: the event payload carries what is left of the limited dimensions only.
    expect(remainingSnapshot(limits, { ...NONE, ...spent })).toStrictEqual(expected)
  })

  it('buildStatus carries no features key for a budget without a filter', () => {
    // Scenario: a status consumer that enumerates the keys must not see `features: undefined`.
    const status = buildStatus({ id: 'b1', window: 'day', policy: 'block', limitNanoUsd: 1n } as never, START, null, NONE)
    expect(Object.keys(status)).not.toContain('features')
  })
})

describe('budget.keys — the time a counter lives and the dimensions a delta touches', () => {
  it('keeps a window counter for the window plus an hour of grace', () => {
    // Scenario: a one-day window lives 86 400 s plus 3 600 s, so the counter outlives the window it counts.
    expect(counterTtlSeconds(START, new Date(START.getTime() + 86_400_000))).toBe(90_000)
  })

  it('keeps a total-window counter for 400 days', () => {
    // Scenario: a window that never resets still expires a counter nobody touches.
    expect(counterTtlSeconds(START, null)).toBe(34_560_000)
  })

  it('leaves out a dimension the delta does not move', () => {
    // Scenario: a zero delta must not cost a counter round trip.
    const limits = { nanoUsd: 10n, tokens: 10, count: 10 }
    expect(counterDimensions({ nanoUsd: 0n, tokens: 0, count: 0 }, limits)).toEqual([])
    expect(counterDimensions({ nanoUsd: 1n, tokens: 0, count: 0 }, limits).map((d) => d.name)).toEqual(['cost'])
    expect(counterDimensions({ nanoUsd: 0n, tokens: 2, count: 0 }, limits).map((d) => d.name)).toEqual(['tokens'])
    expect(counterDimensions({ nanoUsd: 0n, tokens: 0, count: 3 }, limits).map((d) => d.name)).toEqual(['count'])
  })
})
