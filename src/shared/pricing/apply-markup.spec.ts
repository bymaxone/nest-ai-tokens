import fc from 'fast-check'
import { applyMarkup, resolveMultiplier4dp } from './apply-markup'

describe('resolveMultiplier4dp', () => {
  /** The multiplier is rounded to four decimal places (the persisted precision). */
  it('rounds to four decimal places', () => {
    expect(resolveMultiplier4dp(1.23456)).toBe(1.2346)
    expect(resolveMultiplier4dp(2)).toBe(2)
  })

  /** Non-finite or non-positive multipliers are rejected. */
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('throws on the invalid multiplier %p', (value) => {
    expect(() => resolveMultiplier4dp(value)).toThrow(RangeError)
  })
})

describe('applyMarkup', () => {
  /** The spec worked example: 4× markup on $0.005 is $0.020. */
  it('applies a 4× markup exactly', () => {
    expect(applyMarkup(5_000_000n, 4.0)).toBe(20_000_000n)
  })

  /** A multiplier of 1.0 is the identity. */
  it('is the identity at 1.0', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (raw) => {
        expect(applyMarkup(raw, 1.0)).toBe(raw)
      }),
    )
  })

  /** Multipliers equal after 4-dp rounding produce identical results. */
  it('is stable to four decimal places', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (raw) => {
        expect(applyMarkup(raw, 1.23456)).toBe(applyMarkup(raw, 1.2346))
      }),
    )
  })

  /** Billed cost is monotonic non-decreasing in the multiplier for non-negative raw cost. */
  it('is monotonic in the multiplier', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.double({ min: 0.0001, max: 100, noNaN: true }),
        fc.double({ min: 0.0001, max: 100, noNaN: true }),
        (raw, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          expect(applyMarkup(raw, lo) <= applyMarkup(raw, hi)).toBe(true)
        },
      ),
    )
  })

  /** The final division truncates toward zero. */
  it('truncates toward zero', () => {
    // 3 * 10001 / 10000 = 30003 / 10000 = 3 (truncated).
    expect(applyMarkup(3n, 1.0001)).toBe(3n)
    // Negative raw cost (compensating record) truncates toward zero too.
    expect(applyMarkup(-3n, 1.0001)).toBe(-3n)
  })

  /** Invalid multipliers fail the call rather than defaulting to 1.0. */
  it.each([0, -2, Number.NaN, Number.NEGATIVE_INFINITY])('throws on the invalid multiplier %p', (value) => {
    expect(() => applyMarkup(1_000n, value)).toThrow(RangeError)
  })
})
