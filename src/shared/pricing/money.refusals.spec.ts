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

  /** The message names the function and the range. */
  it('formatNanoUsd names itself and the range in the refusal', () => {
    // Scenario: a host reads the message to find which option was out of range.
    expect(() => formatNanoUsd(1n, { decimals: 10 })).toThrow(
      'formatNanoUsd: decimals must be an integer in [0, 9]'
    )
  })
})
