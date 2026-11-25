/**
 * @fileoverview Property specs of the refund split: the parts of a random split sum to the amount, a part never exceeds what its grant has left,
 * and a sequence of partial refunds ends with every slot at zero.
 * @layer prisma
 */

import { splitByWeights } from './refund-split'

/** A small deterministic generator, so a failing sequence can be replayed from its seed. */
function lcg(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

describe('splitByWeights', () => {
  /** The shares sum to the amount, none is negative, and none exceeds what its slot can take. */
  it('splits a refund exactly, within every slot, for any weights', () => {
    const next = lcg(7)
    for (let round = 0; round < 500; round += 1) {
      const weights = Array.from({ length: 1 + Math.floor(next() * 5) }, () => BigInt(Math.floor(next() * 40)))
      const total = weights.reduce((sum, weight) => sum + weight, 0n)
      if (total === 0n) continue
      const amount = 1n + BigInt(Math.floor(next() * Number(total)))
      const shares = splitByWeights(weights, amount)
      expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(amount)
      shares.forEach((share, index) => {
        expect(share >= 0n).toBe(true)
        expect(share <= (weights[index]!)).toBe(true)
      })
    }
  })

  /** A sequence of partial refunds, each weighted by what is left, ends with every slot full when the last refund takes the rest. */
  it('fills every slot exactly over a sequence of partial refunds', () => {
    const next = lcg(11)
    for (let round = 0; round < 300; round += 1) {
      const original = Array.from({ length: 1 + Math.floor(next() * 4) }, () => 1n + BigInt(Math.floor(next() * 30)))
      let left = [...original]
      let remaining = original.reduce((sum, weight) => sum + weight, 0n)
      while (remaining > 0n) {
        const amount = next() < 0.3 ? remaining : 1n + BigInt(Math.floor(next() * Number(remaining)))
        const shares = splitByWeights(left, amount)
        left = left.map((weight, index) => weight - (shares[index]!))
        expect(left.every((weight) => weight >= 0n)).toBe(true)
        remaining -= amount
      }
      expect(left.every((weight) => weight === 0n)).toBe(true)
    }
  })

  /** A tie in the remainders goes to the earlier slot. */
  it('gives the extra unit to the earlier slot on a tie', () => {
    expect(splitByWeights([1n, 1n], 1n)).toEqual([1n, 0n])
  })

  /** Input that cannot be split is refused. */
  it.each([
    [[1n, 2n], 0n],
    [[1n, 2n], 4n],
    [[-1n, 5n], 1n],
  ])('refuses %p for %p', (weights, amount) => {
    expect(() => splitByWeights(weights, amount)).toThrow(RangeError)
  })
})
