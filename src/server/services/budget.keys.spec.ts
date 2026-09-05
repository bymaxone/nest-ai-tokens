/**
 * @fileoverview Counter-key construction (spec §10.8) — the injectivity invariant.
 * @layer server
 */

import { COUNTER_DIMENSIONS, counterKey, windowKey } from './budget.keys'

describe('budget.keys — composite key injectivity', () => {
  // `budgetId` is caller-supplied (`UpsertBudgetInput.id`) and unvalidated, and the
  // Prisma adapter honours it, so both keys are built from a field an attacker
  // controls. These assert the construction, not the input.
  //
  // What each group is for, stated precisely because the distinction is easy to lose:
  // the LAYOUT tests pin the composition itself, so reordering the fields or changing
  // a delimiter fails here. The FACT tests pin the two properties of the surrounding
  // values that the layout relies on, exercised THROUGH `counterKey` rather than
  // against `Date.prototype.toISOString`, which no edit to this repository could change
  // anyway. The property test then covers the mixed-length case, which is the only
  // shape in which a collision is possible at all.

  /** A budget id that embeds both delimiters, a whole key tail, and the expanded-year prefix. */
  const ADVERSARIAL = ['x', 'x:', 'x|', 'x:cost', 'x:tokens', 'x:+01', 'x:2026-06-15T00:00:00.000Z', 'x:2026-06-15T00:00:00.000Z:cost', 'x|2026-06-15T00:00:00.000Z']

  /** A UTC midnight on 1 January of `year`, including years outside the 0000-9999 range. */
  function january(year: number): Date {
    const at = new Date(0)
    at.setUTCFullYear(year, 0, 1)
    at.setUTCHours(0, 0, 0, 0)
    return at
  }

  const WINDOWS = [new Date('2026-06-15T00:00:00.000Z'), new Date('2026-07-15T00:00:00.000Z'), january(0), january(10000), january(-1)]

  /** The dimension set the key is built from; a change here must reach these tests. */
  it('exposes exactly the three counter dimensions', () => {
    // Order is inert — nothing in src/ iterates this array — so compare as a set.
    expect([...COUNTER_DIMENSIONS].sort()).toEqual(['cost', 'count', 'tokens'])
  })

  /** LAYOUT: the dimension is last and the timestamp second-to-last. A reorder fails here. */
  it('composes the counter key as prefix, id, timestamp, then dimension', () => {
    expect(counterKey('b1', new Date('2026-06-15T00:00:00.000Z'), 'cost')).toBe('ai_tokens:budget:b1:2026-06-15T00:00:00.000Z:cost')
  })

  /** LAYOUT: the dedupe key is the id, a pipe, then the timestamp. A delimiter change fails here. */
  it('composes the window key as id, pipe, then timestamp', () => {
    expect(windowKey('b1', new Date('2026-06-15T00:00:00.000Z'))).toBe('b1|2026-06-15T00:00:00.000Z')
  })

  /** FACT 1: a dimension ending with another makes the trailing field ambiguous. `discount` would. */
  it('keeps the dimension literals prefix-free at the tail', () => {
    for (const a of COUNTER_DIMENSIONS) {
      for (const b of COUNTER_DIMENSIONS) {
        if (a !== b) expect(a.endsWith(b)).toBe(false)
      }
    }
  })

  /** FACT 2, through the key: an in-range window contributes a 24-character tail segment. */
  it('gives every in-range window the same tail length in the key', () => {
    const lengths = new Set([0, 1970, 2026, 9999].map((year) => counterKey('b1', january(year), 'cost').length))
    expect([...lengths]).toEqual([counterKey('b1', january(2026), 'cost').length])
  })

  /** FACT 3, through the key: the near-collision an expanded year almost creates.
   * These two keys differ at exactly one character — a year digit where the shorter
   * form would need the delimiter — and that single character is the whole invariant. */
  it('does not collide an expanded-year window with an in-range one', () => {
    const expanded = counterKey('x', january(10000), 'cost')
    const inRange = counterKey('x:+01', january(0), 'cost')
    expect(expanded).not.toBe(inRange)
    let differing = 0
    while (expanded.charAt(differing) === inRange.charAt(differing)) differing += 1
    expect(expanded.charAt(differing)).toBe('0')
    expect(inRange.charAt(differing)).toBe(':')
  })

  /** The property itself, over both timestamp lengths: no two distinct triples may share a key. */
  it('never maps two distinct budget/window/dimension triples to one counter key', () => {
    const seen = new Map<string, string>()
    for (const id of ADVERSARIAL) {
      for (const at of WINDOWS) {
        for (const dimension of COUNTER_DIMENSIONS) {
          const key = counterKey(id, at, dimension)
          const triple = JSON.stringify([id, at.toISOString(), dimension])
          expect(seen.get(key) ?? triple).toBe(triple)
          seen.set(key, triple)
        }
      }
    }
  })

  /** The same property for the dedupe key, whose delimiter cannot occur in a timestamp. */
  it('never maps two distinct budget/window pairs to one window key', () => {
    const seen = new Map<string, string>()
    for (const id of ADVERSARIAL) {
      for (const at of WINDOWS) {
        const key = windowKey(id, at)
        const pair = JSON.stringify([id, at.toISOString()])
        expect(seen.get(key) ?? pair).toBe(pair)
        seen.set(key, pair)
      }
    }
  })
})
