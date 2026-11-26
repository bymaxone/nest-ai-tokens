/**
 * @fileoverview The refusals of the money helpers for values their types do not allow.
 * @layer test
 */

import { floatUsdToNanoUsd, formatNanoUsd } from './money'

describe('money guards against values the type does not allow', () => {
  /** A JavaScript caller can pass a string or null; the guard refuses it rather than coercing it. */
  it.each(['0.5', null, undefined, true])('floatUsdToNanoUsd refuses the non-number %p', (value) => {
    // Scenario: `Number.isFinite` does not coerce, so the guard refuses; without it `Math.abs` would convert.
    expect(() => floatUsdToNanoUsd(value as never)).toThrow(RangeError)
  })

  /** The message names the function and the expectation. */
  it('floatUsdToNanoUsd names itself in the refusal', () => {
    // Scenario: a host reads the message to find which entry point refused its value.
    expect(() => floatUsdToNanoUsd(Number.NaN)).toThrow('floatUsdToNanoUsd: expected a finite number')
  })

  /** A decimals value that is not a number is refused, though 9 - '2' would coerce. */
  it.each(['2', true, []])('formatNanoUsd refuses the non-number decimals %p', (decimals) => {
    // Scenario: BigInt('2') and 9 - '2' coerce, so without the guard '2' would render.
    expect(() => formatNanoUsd(1n, { decimals: decimals as never })).toThrow(RangeError)
  })

  /** The message names the function and the range, on either side of it. */
  it.each([-1, 10])('formatNanoUsd names itself and the range when refusing %p', (decimals) => {
    // Scenario: a host reads the message to find which option was out of range. A negative value
    // also fails inside bigint arithmetic, with another message, so the message tells them apart.
    expect(() => formatNanoUsd(1n, { decimals })).toThrow(
      'formatNanoUsd: decimals must be an integer in [0, 9]'
    )
  })
})

describe('money at the values where the sign of the amount is zero or absent', () => {
  /** Both zeroes and an amount that rounds to nothing convert to the one bigint zero. */
  it.each([0, -0, 1e-12, -1e-12])('floatUsdToNanoUsd converts %p to 0n', (usd) => {
    // Scenario: bigint has no negative zero, so a zero amount carries no sign.
    expect(floatUsdToNanoUsd(usd)).toBe(0n)
  })

  /** NaN and the infinities have no sign to convert and stop at the guard. */
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'floatUsdToNanoUsd refuses %p at the guard',
    (usd) => {
      // Scenario: the message shows the refusal is the guard's, not a bigint conversion error.
      expect(() => floatUsdToNanoUsd(usd)).toThrow('floatUsdToNanoUsd: expected a finite number')
    }
  )
})
