/**
 * @fileoverview The store-agnostic budget contract suite (spec §10.8, §15.2).
 * `runBudgetStoreContract` proves that ANY {@link IBudgetStore} consumes windows
 * race-safely and atomically across the three dimensions: two concurrent consumes
 * with headroom for one leave exactly one winner, an over-limit consume on ANY
 * single dimension moves nothing, the window row is created on first touch, and
 * `adjustWindow` floors each dimension at zero. It runs against the in-memory fake
 * here and, unchanged, against Testcontainers PostgreSQL in the Prisma e2e.
 * @layer test
 */

import type { BudgetDelta, BudgetLimits, IBudgetStore } from '@bymax-one/nest-ai-tokens'

/** Build a budget delta across the three dimensions. */
export function delta(nanoUsd: bigint, tokens = 0, count = 0): BudgetDelta {
  return { nanoUsd, tokens, count }
}

/**
 * Register the shared budget-store contract against a store factory.
 *
 * @param label A human-readable store name for the describe block.
 * @param make Produces a fresh store per test.
 */
export function runBudgetStoreContract(label: string, make: () => Promise<IBudgetStore> | IBudgetStore): void {
  const windowStart = new Date('2026-06-01T00:00:00.000Z')

  describe(`IBudgetStore contract — ${label}`, () => {
    /** Two concurrent consumes against a window with headroom for one: exactly one wins. */
    it('lets exactly one of two concurrent consumes win', async () => {
      const store = await make()
      const limits: BudgetLimits = { nanoUsd: 100n }
      const [a, b] = await Promise.all([
        store.conditionalConsume('b1', windowStart, delta(80n), limits),
        store.conditionalConsume('b1', windowStart, delta(80n), limits),
      ])
      expect([a, b].filter((ok) => ok)).toHaveLength(1)
      const window = await store.getWindow('b1', windowStart)
      expect(window?.spentNanoUsd).toBe(80n)
    })

    /** The cost dimension blocks at its exact limit; the window is created on first touch. */
    it('enforces the cost dimension boundary and first-touch creation', async () => {
      const store = await make()
      expect(await store.getWindow('cost', windowStart)).toBeNull()
      expect(await store.conditionalConsume('cost', windowStart, delta(100n), { nanoUsd: 100n })).toBe(true)
      expect(await store.conditionalConsume('cost', windowStart, delta(1n), { nanoUsd: 100n })).toBe(false)
      expect((await store.getWindow('cost', windowStart))?.spentNanoUsd).toBe(100n)
    })

    /** The token dimension blocks independently of cost. */
    it('enforces the token dimension boundary', async () => {
      const store = await make()
      expect(await store.conditionalConsume('tok', windowStart, delta(0n, 100), { tokens: 100 })).toBe(true)
      expect(await store.conditionalConsume('tok', windowStart, delta(0n, 1), { tokens: 100 })).toBe(false)
    })

    /** The count dimension blocks independently. */
    it('enforces the count dimension boundary', async () => {
      const store = await make()
      expect(await store.conditionalConsume('cnt', windowStart, delta(0n, 0, 2), { count: 2 })).toBe(true)
      expect(await store.conditionalConsume('cnt', windowStart, delta(0n, 0, 1), { count: 2 })).toBe(false)
    })

    /** A consume that passes cost but exceeds another dimension moves nothing (spend stays zero). */
    it('moves nothing when any single dimension is over', async () => {
      const store = await make()
      const ok = await store.conditionalConsume('multi', windowStart, delta(10n, 60), { nanoUsd: 100n, tokens: 50 })
      expect(ok).toBe(false)
      const window = await store.getWindow('multi', windowStart)
      expect(window?.spentNanoUsd ?? 0n).toBe(0n)
      expect(window?.spentTokens ?? 0).toBe(0)
    })

    /** adjustWindow applies a signed delta and floors each dimension at zero. */
    it('floors adjustWindow at zero', async () => {
      const store = await make()
      await store.conditionalConsume('adj', windowStart, delta(30n, 5, 1), {})
      await store.adjustWindow('adj', windowStart, delta(-50n, -10, -5))
      const window = await store.getWindow('adj', windowStart)
      expect(window).toEqual({ spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 })
    })
  })
}
