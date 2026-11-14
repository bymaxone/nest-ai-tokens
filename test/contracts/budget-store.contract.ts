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

/** Seed a minimal budget row with a fixed id so window inserts satisfy the FK on real Postgres. */
async function seedBudget(store: IBudgetStore, id: string): Promise<void> {
  await store.upsert({ id, tenantId: 'budget-contract', scope: { type: 'tenant', id: 'budget-contract' }, window: 'total', softThresholds: [], policy: 'block' })
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
      await seedBudget(store, 'b1')
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
      await seedBudget(store, 'cost')
      expect(await store.getWindow('cost', windowStart)).toBeNull()
      expect(await store.conditionalConsume('cost', windowStart, delta(100n), { nanoUsd: 100n })).toBe(true)
      expect(await store.conditionalConsume('cost', windowStart, delta(1n), { nanoUsd: 100n })).toBe(false)
      expect((await store.getWindow('cost', windowStart))?.spentNanoUsd).toBe(100n)
    })

    /** The token dimension blocks independently of cost. */
    it('enforces the token dimension boundary', async () => {
      const store = await make()
      await seedBudget(store, 'tok')
      expect(await store.conditionalConsume('tok', windowStart, delta(0n, 100), { tokens: 100 })).toBe(true)
      expect(await store.conditionalConsume('tok', windowStart, delta(0n, 1), { tokens: 100 })).toBe(false)
    })

    /** The count dimension blocks independently. */
    it('enforces the count dimension boundary', async () => {
      const store = await make()
      await seedBudget(store, 'cnt')
      expect(await store.conditionalConsume('cnt', windowStart, delta(0n, 0, 2), { count: 2 })).toBe(true)
      expect(await store.conditionalConsume('cnt', windowStart, delta(0n, 0, 1), { count: 2 })).toBe(false)
    })

    /** A consume that passes cost but exceeds another dimension moves nothing (spend stays zero). */
    it('moves nothing when any single dimension is over', async () => {
      const store = await make()
      await seedBudget(store, 'multi')
      const ok = await store.conditionalConsume('multi', windowStart, delta(10n, 60), { nanoUsd: 100n, tokens: 50 })
      expect(ok).toBe(false)
      const window = await store.getWindow('multi', windowStart)
      expect(window?.spentNanoUsd ?? 0n).toBe(0n)
      expect(window?.spentTokens ?? 0).toBe(0)
    })

    /** adjustWindow applies a signed delta and floors each dimension at zero. */
    it('floors adjustWindow at zero', async () => {
      const store = await make()
      await seedBudget(store, 'adj')
      await store.conditionalConsume('adj', windowStart, delta(30n, 5, 1), {})
      await store.adjustWindow('adj', windowStart, delta(-50n, -10, -5))
      const window = await store.getWindow('adj', windowStart)
      expect(window).toEqual({ spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 })
    })

    /**
     * The admin paths are tenant-scoped: another tenant's key finds nothing, removes nothing, moves no window, and an
     * upsert with an id that belongs to another tenant is refused, leaving the owner's row as it was.
     */
    it('keeps the budget of one tenant out of reach of another tenant by id', async () => {
      const store = await make()
      await seedBudget(store, 'owned')
      const owner = { tenantId: 'budget-contract', id: 'owned' }
      const stranger = { tenantId: 'other-tenant', id: 'owned' }
      const before = await store.findBudgetById(owner)
      expect(before).not.toBeNull()

      expect(await store.findBudgetById(stranger)).toBeNull()
      await store.remove(stranger)
      await store.setWindowStart(stranger, windowStart)
      await expect(
        store.upsert({ id: 'owned', tenantId: 'other-tenant', scope: { type: 'tenant', id: 'other-tenant' }, window: 'day', softThresholds: [], policy: 'allow' }),
      ).rejects.toThrow()

      expect(await store.findBudgetById(owner)).toEqual(before)
      expect(await store.getWindow('owned', windowStart)).toBeNull()
      await store.remove(owner)
      expect(await store.findBudgetById(owner)).toBeNull()
    })

    /*
     * Invariant: one application moves a window once, whoever takes it. The same key consumed or adjusted twice moves it
     * once; the second answer is 'replayed' and the attempt holds a reference on it.
     */
    it('moves a window once for one application, whether consumed or adjusted', async () => {
      const store = await make()
      await seedBudget(store, 'once')
      const consumed = { key: 'consume-key', budgetId: 'once', attempt: 'a' }
      expect(await store.consumeWindowOnce(consumed, windowStart, delta(10n, 4, 1), { nanoUsd: 100n })).toBe('applied')
      expect(await store.consumeWindowOnce({ ...consumed, attempt: 'b' }, windowStart, delta(10n, 4, 1), { nanoUsd: 100n })).toBe('replayed')
      const adjusted = { key: 'adjust-key', budgetId: 'once', attempt: 'row' }
      expect(await store.adjustWindowOnce(adjusted, windowStart, delta(5n, 1, 0))).toBe('applied')
      expect(await store.adjustWindowOnce(adjusted, windowStart, delta(5n, 1, 0))).toBe('replayed')
      expect(await store.getWindow('once', windowStart)).toEqual({ spentNanoUsd: 15n, spentTokens: 5, spentCount: 1 })
    })

    /*
     * Invariant: concurrent attempts with one application move the window once, whichever instance wins: exactly one
     * 'applied', the others 'replayed', and the window holds one consumption.
     */
    it('lets exactly one of many concurrent attempts with one application move the window', async () => {
      const store = await make()
      await seedBudget(store, 'race')
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.consumeWindowOnce({ key: 'race-key', budgetId: 'race', attempt: `attempt-${i.toString()}` }, windowStart, delta(10n), { nanoUsd: 1_000n })),
      )
      expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === 'replayed')).toHaveLength(7)
      expect(await store.getWindow('race', windowStart)).toEqual({ spentNanoUsd: 10n, spentTokens: 0, spentCount: 0 })
    })

    /*
     * Invariant: a refused consume records no application and takes no reference, so the same key can be tried again once
     * there is headroom, and then moves the window once.
     */
    it('records nothing for a refused consume, so the key can be applied later', async () => {
      const store = await make()
      await seedBudget(store, 'refused')
      await store.adjustWindow('refused', windowStart, delta(95n))
      const reference = { key: 'later', budgetId: 'refused', attempt: 'a' }
      expect(await store.consumeWindowOnce(reference, windowStart, delta(10n), { nanoUsd: 100n })).toBe('refused')
      expect(await store.dropReference(reference)).toBe('absent')
      await store.adjustWindow('refused', windowStart, delta(-50n))
      expect(await store.consumeWindowOnce(reference, windowStart, delta(10n), { nanoUsd: 100n })).toBe('applied')
      expect(await store.getWindow('refused', windowStart)).toEqual({ spentNanoUsd: 55n, spentTokens: 0, spentCount: 0 })
    })

    /*
     * Invariant: an application met again in another window or with another delta is a mismatch, not a replay: the key names
     * another call, and nothing moves and no reference is taken.
     */
    it('answers a mismatch for an active application met with another delta or window, and moves nothing', async () => {
      const store = await make()
      await seedBudget(store, 'mismatch')
      const other = new Date('2026-07-01T00:00:00.000Z')
      const reference = { key: 'mismatch-key', budgetId: 'mismatch', attempt: 'a' }
      expect(await store.consumeWindowOnce(reference, windowStart, delta(30n, 1, 1), {})).toBe('applied')
      expect(await store.consumeWindowOnce({ ...reference, attempt: 'b' }, windowStart, delta(80n, 1, 1), {})).toBe('mismatch')
      expect(await store.consumeWindowOnce({ ...reference, attempt: 'b' }, windowStart, delta(30n, 2, 1), {})).toBe('mismatch')
      expect(await store.consumeWindowOnce({ ...reference, attempt: 'b' }, windowStart, delta(30n, 1, 2), {})).toBe('mismatch')
      expect(await store.consumeWindowOnce({ ...reference, attempt: 'b' }, other, delta(30n, 1, 1), {})).toBe('mismatch')
      expect(await store.adjustWindowOnce({ ...reference, attempt: 'b' }, windowStart, delta(80n, 1, 1))).toBe('mismatch')
      expect(await store.adjustWindowOnce({ ...reference, attempt: 'b' }, other, delta(30n, 1, 1))).toBe('mismatch')
      expect(await store.dropReference({ ...reference, attempt: 'b' })).toBe('missing')
      expect(await store.getWindow('mismatch', windowStart)).toEqual({ spentNanoUsd: 30n, spentTokens: 1, spentCount: 1 })
      expect(await store.getWindow('mismatch', other)).toBeNull()
    })

    /*
     * Invariant: the movement goes back, from the window it moved, when the last reference on it is dropped, and not before:
     * a drop with other references left keeps it. Dropping a reference the attempt does not hold is 'missing', and an
     * application never recorded is 'absent'.
     */
    it('gives a movement back when its last reference is dropped, from the window it moved', async () => {
      const store = await make()
      await seedBudget(store, 'back')
      const reference = { key: 'back-key', budgetId: 'back', attempt: 'a' }
      expect(await store.consumeWindowOnce(reference, windowStart, delta(30n, 2, 1), {})).toBe('applied')
      expect(await store.consumeWindowOnce({ ...reference, attempt: 'b' }, windowStart, delta(30n, 2, 1), {})).toBe('replayed')
      expect(await store.dropReference({ key: 'nobody', budgetId: 'back', attempt: 'a' })).toBe('absent')
      expect(await store.dropReference({ ...reference, attempt: 'c' })).toBe('missing')
      expect(await store.dropReference(reference)).toBe('kept')
      expect(await store.getWindow('back', windowStart)).toEqual({ spentNanoUsd: 30n, spentTokens: 2, spentCount: 1 })
      expect(await store.dropReference({ ...reference, attempt: 'b' })).toBe('unapplied')
      expect(await store.dropReference({ ...reference, attempt: 'b' })).toBe('missing')
      expect(await store.getWindow('back', windowStart)).toEqual({ spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 })
    })

    /** A key given back is applied again, in any window: the new application takes the place of the old. */
    it('lets a given-back key be applied again, in another window', async () => {
      const store = await make()
      await seedBudget(store, 'again')
      const other = new Date('2026-07-01T00:00:00.000Z')
      const reference = { key: 'again-key', budgetId: 'again', attempt: 'a' }
      expect(await store.consumeWindowOnce(reference, windowStart, delta(30n), {})).toBe('applied')
      expect(await store.dropReference(reference)).toBe('unapplied')
      expect(await store.adjustWindowOnce({ ...reference, attempt: 'b' }, other, delta(7n))).toBe('applied')
      expect(await store.getWindow('again', other)).toEqual({ spentNanoUsd: 7n, spentTokens: 0, spentCount: 0 })
      expect(await store.dropReference({ ...reference, attempt: 'b' })).toBe('unapplied')
      expect(await store.getWindow('again', other)).toEqual({ spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 })
      expect(await store.getWindow('again', windowStart)).toEqual({ spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 })
    })

    /*
     * Invariant: committing names the reference of the call whose row stands. Whichever of two attempts commits first holds
     * `row`, and the other, committing second, drops its own: in either order exactly one `row` remains, and the movement
     * goes back only when `row` itself is dropped.
     */
    it.each([
      { name: 'the winner first', order: ['a', 'b'] },
      { name: 'the other attempt first', order: ['b', 'a'] },
    ])('ends with exactly one committed reference when both attempts commit, $name', async ({ order }) => {
      const store = await make()
      await seedBudget(store, 'commit-' + order.join(''))
      const base = { key: 'commit-key', budgetId: 'commit-' + order.join('') }
      expect(await store.consumeWindowOnce({ ...base, attempt: 'a' }, windowStart, delta(30n), {})).toBe('applied')
      expect(await store.consumeWindowOnce({ ...base, attempt: 'b' }, windowStart, delta(30n), {})).toBe('replayed')
      expect(await store.commitReference({ ...base, attempt: order[0]! })).toBe('committed')
      expect(await store.commitReference({ ...base, attempt: order[1]! })).toBe('already')
      expect(await store.dropReference({ ...base, attempt: 'a' })).toBe('missing')
      expect(await store.dropReference({ ...base, attempt: 'b' })).toBe('missing')
      expect(await store.getWindow(base.budgetId, windowStart)).toEqual({ spentNanoUsd: 30n, spentTokens: 0, spentCount: 0 })
      expect(await store.dropReference({ ...base, attempt: 'row' })).toBe('unapplied')
    })

    /** A reclaimed reference is 'gone' to the attempt that commits late; committing the committed reference, or an unknown application, is harmless. */
    it("answers 'gone' for a reclaimed reference and 'absent' for no application when committing", async () => {
      const store = await make()
      await seedBudget(store, 'late')
      const reference = { key: 'late-key', budgetId: 'late', attempt: 'a' }
      expect(await store.commitReference(reference)).toBe('absent')
      expect(await store.consumeWindowOnce({ ...reference, attempt: 'b' }, windowStart, delta(30n), {})).toBe('applied')
      expect(await store.commitReference(reference)).toBe('gone')
      expect(await store.commitReference({ ...reference, attempt: 'b' })).toBe('committed')
      expect(await store.commitReference({ ...reference, attempt: 'row' })).toBe('already')
    })
  })
}
