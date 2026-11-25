/**
 * @fileoverview How a refund to its source is divided: the pure arithmetic of the split, apart from any statement, so that the rule
 * is one function with one property test over sequences of partial refunds.
 * @layer prisma
 */

/**
 * Divide `amount` across slots weighted by `weights`, in whole nano-USD, by the largest remainder. Each share is `floor(amount * weight / total)`,
 * and what is left goes one unit at a time to the slots with the largest remainders, the earlier slot first on a tie. When `amount` does not
 * exceed the sum of the weights, no share exceeds its weight, so a slot is never given more than it has room for.
 *
 * @param weights What each slot can still take, in order; none negative.
 * @param amount What to divide, positive and not above the sum of the weights.
 * @returns The share of each slot, in order, summing to `amount`.
 * @throws {RangeError} A weight is negative, or `amount` is not positive or exceeds the sum of the weights.
 */
export function splitByWeights(weights: readonly bigint[], amount: bigint): bigint[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0n)
  if (weights.some((weight) => weight < 0n) || amount <= 0n || amount > total) throw new RangeError('a refund is split over non-negative weights, and is positive and no larger than their sum')
  const shares = weights.map((weight) => (amount * weight) / total)
  // What the floors left is fewer than one unit per slot, so each unit goes to a distinct slot: the largest remainders first; the sort is stable, so the earlier slot on a tie.
  const rest = Number(amount - shares.reduce((sum, share) => sum + share, 0n))
  const bonus = new Set(
    weights
      .map((weight, index) => ({ index, remainder: (amount * weight) % total }))
      .sort((a, b) => Number(b.remainder - a.remainder))
      .slice(0, rest)
      .map((slot) => slot.index),
  )
  return shares.map((share, index) => (bonus.has(index) ? share + 1n : share))
}
