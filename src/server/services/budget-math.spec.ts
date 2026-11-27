/**
 * @fileoverview The tie-free floor and minimum of budget arithmetic.
 * @layer server
 */
import { max0, minBig } from './budget-math'

const HUGE = 10n ** 30n

describe('budget-math — floor and minimum', () => {
  /** Negatives floor to zero; zero and every positive value, `1n` included, come back as they are. */
  it.each([
    [-HUGE, 0n],
    [-1n, 0n],
    [0n, 0n],
    [1n, 1n],
    [2n, 2n],
    [HUGE, HUGE],
  ])('max0(%s) is %s', (value, expected) => {
    expect(max0(value)).toBe(expected)
  })

  /** The smaller of the two whichever side it is on, a tie and neighbours one apart included. */
  it.each([
    [0n, 0n, 0n],
    [5n, 5n, 5n],
    [5n, 6n, 5n],
    [6n, 5n, 5n],
    [-3n, 3n, -3n],
    [3n, -3n, -3n],
    [-7n, -8n, -8n],
    [HUGE + 1n, HUGE, HUGE],
  ])('minBig(%s, %s) is %s', (a, b, expected) => {
    expect(minBig(a, b)).toBe(expected)
  })
})
