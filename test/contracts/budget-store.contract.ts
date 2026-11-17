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

    /*
     * Invariant: the stale-reference listing names what an attempt left behind and nothing else. `attempt` lists the
     * references that were not committed, `held` lists the committed `row` references of holds (`reserve:` keys), each with
     * the window and delta its application moved; a reference that was dropped is not listed, and `olderThan` bounds the
     * listing from above, strictly.
     */
    it('lists the references an attempt left behind and the committed references of holds, each with its application', async () => {
      const store = await make()
      await seedBudget(store, 'stale')
      const future = new Date(Date.now() + 3_600_000)
      const reference = (key: string, attempt: string) => ({ key, budgetId: 'stale', attempt })
      await store.consumeWindowOnce(reference('record:orphan', 'a1'), windowStart, delta(30n, 5, 1), {})
      await store.consumeWindowOnce(reference('reserve:held', 'a2'), windowStart, delta(40n, 7, 1), {})
      await store.commitReference(reference('reserve:held', 'a2'))
      await store.consumeWindowOnce(reference('record:kept', 'a3'), windowStart, delta(1n), {})
      await store.commitReference(reference('record:kept', 'a3'))
      await store.consumeWindowOnce(reference('record:dropped', 'a4'), windowStart, delta(2n), {})
      await store.dropReference(reference('record:dropped', 'a4'))
      const attempt = await store.findStaleReferences!({ selection: 'attempt', olderThan: future, limit: 50 })
      expect(attempt.map(({ key, tenantId, attempt: name, windowStart: at, delta: moved }) => ({ key, tenantId, name, at, moved }))).toEqual([
        { key: 'record:orphan', tenantId: 'budget-contract', name: 'a1', at: windowStart, moved: delta(30n, 5, 1) },
      ])
      const held = await store.findStaleReferences!({ selection: 'held', olderThan: future, limit: 50 })
      expect(held.map(({ key, attempt: name, delta: moved }) => ({ key, name, moved }))).toEqual([{ key: 'reserve:held', name: 'row', moved: delta(40n, 7, 1) }])
      expect(await store.findStaleReferences!({ selection: 'attempt', olderThan: new Date(0), limit: 50 })).toEqual([])
      expect(await store.findStaleReferences!({ selection: 'held', olderThan: new Date(0), limit: 50 })).toEqual([])
    })

    /** The pages follow the order `(createdAt, key, budgetId, attempt)`: every reference appears once, whatever the page size. */
    it.each([1, 2, 5])('pages the stale references in order, every one once, with a page of %i', async (limit) => {
      const store = await make()
      await seedBudget(store, 'page')
      const future = new Date(Date.now() + 3_600_000)
      for (const key of ['record:c', 'record:a', 'record:b', 'record:d', 'record:e']) {
        await store.consumeWindowOnce({ key, budgetId: 'page', attempt: 'x' }, windowStart, delta(1n), {})
      }
      const seen: string[] = []
      let after
      for (let round = 0; round < 10; round++) {
        const page = await store.findStaleReferences!({ selection: 'attempt', olderThan: future, limit, ...(after === undefined ? {} : { after }) })
        if (page.length === 0) break
        expect(page.length).toBeLessThanOrEqual(limit)
        seen.push(...page.map((found) => found.key))
        const last = page[page.length - 1]!
        after = { createdAt: last.createdAt, key: last.key, budgetId: last.budgetId, attempt: last.attempt }
      }
      expect([...seen].sort()).toEqual(['record:a', 'record:b', 'record:c', 'record:d', 'record:e'])
      expect(new Set(seen).size).toBe(5)
    })

    /** The `retained` selection lists the committed references of every key, and only those older than the bound. */
    it('lists every committed reference older than the bound under the retained selection', async () => {
      const store = await make()
      await seedBudget(store, 'ret')
      const future = new Date(Date.now() + 3_600_000)
      const reference = (key: string, attempt: string) => ({ key, budgetId: 'ret', attempt })
      for (const key of ['reserve:a', 'record:b', 'capture:c']) {
        await store.consumeWindowOnce(reference(key, 'x'), windowStart, delta(1n), {})
        await store.commitReference(reference(key, 'x'))
      }
      await store.consumeWindowOnce(reference('record:open', 'x'), windowStart, delta(1n), {})
      const listed = await store.findStaleReferences!({ selection: 'retained', olderThan: future, limit: 50 })
      expect(listed.map((found) => `${found.key}/${found.attempt}`).sort()).toEqual(['capture:c/row', 'record:b/row', 'reserve:a/row'])
      expect(await store.findStaleReferences!({ selection: 'retained', olderThan: new Date(0), limit: 50 })).toEqual([])
    })

    /*
     * Invariant: pruning deletes the record that made a movement replayable and moves nothing. It refuses an application an
     * attempt still holds, one that is younger than the bound, and one that does not exist; after it the key is a fresh one.
     */
    it('prunes an application whose references are all committed, and only then', async () => {
      const store = await make()
      await seedBudget(store, 'prune')
      const future = new Date(Date.now() + 3_600_000)
      const application = { key: 'record:p', budgetId: 'prune' }
      await store.consumeWindowOnce({ ...application, attempt: 'a' }, windowStart, delta(30n), {})
      await store.consumeWindowOnce({ ...application, attempt: 'b' }, windowStart, delta(30n), {})
      await store.commitReference({ ...application, attempt: 'a' })
      expect(await store.pruneApplication!(application, future)).toBe(false)
      await store.dropReference({ ...application, attempt: 'b' })
      expect(await store.pruneApplication!(application, new Date(0))).toBe(false)
      expect(await store.pruneApplication!(application, future)).toBe(true)
      expect(await store.pruneApplication!(application, future)).toBe(false)
      expect(await store.findStaleReferences!({ selection: 'retained', olderThan: future, limit: 50 })).toEqual([])
      expect(await store.getWindow('prune', windowStart)).toEqual({ spentNanoUsd: 30n, spentTokens: 0, spentCount: 0 })
      expect(await store.consumeWindowOnce({ ...application, attempt: 'c' }, windowStart, delta(30n), {})).toBe('applied')
    })

    /** Given-back applications older than the bound go, newer ones stay, and the window is as the drop left it. */
    it('prunes the applications given back before the bound, up to the limit', async () => {
      const store = await make()
      await seedBudget(store, 'back2')
      const future = new Date(Date.now() + 3_600_000)
      for (const key of ['record:g1', 'record:g2', 'record:g3']) {
        await store.consumeWindowOnce({ key, budgetId: 'back2', attempt: 'a' }, windowStart, delta(5n), {})
        await store.dropReference({ key, budgetId: 'back2', attempt: 'a' })
      }
      await store.consumeWindowOnce({ key: 'record:live', budgetId: 'back2', attempt: 'a' }, windowStart, delta(5n), {})
      expect(await store.pruneGivenBack!(new Date(0), 10)).toBe(0)
      expect(await store.pruneGivenBack!(future, 2)).toBe(2)
      expect(await store.pruneGivenBack!(future, 10)).toBe(1)
      expect(await store.pruneGivenBack!(future, 10)).toBe(0)
      expect(await store.getWindow('back2', windowStart)).toEqual({ spentNanoUsd: 5n, spentTokens: 0, spentCount: 0 })
      expect(await store.dropReference({ key: 'record:live', budgetId: 'back2', attempt: 'a' })).toBe('unapplied')
    })

    /**
     * Invariant: the pruning that spares tenants deletes the given-back applications of every other tenant and keeps the
     * spared ones, however many tenants it names; an empty set spares nobody, so it prunes exactly what `pruneGivenBack` does;
     * the budget's tenant is a NOT NULL column (ai_budgets."tenantId"), so no application has an unknown tenant that the
     * comparison `tenantId <> ALL(...)` could leave out as NULL.
     */
    it('prunes the given-back applications of the tenants it does not spare', async () => {
      const store = await make()
      await seedBudget(store, 'ex-a')
      await store.upsert({ id: 'ex-b', tenantId: 'budget-contract-b', scope: { type: 'tenant', id: 'budget-contract-b' }, window: 'total', softThresholds: [], policy: 'block' })
      await store.upsert({ id: 'ex-c', tenantId: 'budget-contract-c', scope: { type: 'tenant', id: 'budget-contract-c' }, window: 'total', softThresholds: [], policy: 'block' })
      const future = new Date(Date.now() + 3_600_000)
      const giveBack = async (budgetId: string, key: string): Promise<void> => {
        await store.consumeWindowOnce({ key, budgetId, attempt: 'a' }, windowStart, delta(5n), {})
        await store.dropReference({ key, budgetId, attempt: 'a' })
      }
      for (const budgetId of ['ex-a', 'ex-b', 'ex-c']) await giveBack(budgetId, `record:${budgetId}`)
      expect(await store.pruneGivenBackExcept!(new Date(0), 10, ['budget-contract'])).toBe(0)
      expect(await store.pruneGivenBackExcept!(future, 10, ['budget-contract', 'budget-contract-c'])).toBe(1)
      expect(await store.dropReference({ key: 'record:ex-a', budgetId: 'ex-a', attempt: 'a' })).toBe('missing')
      expect(await store.dropReference({ key: 'record:ex-b', budgetId: 'ex-b', attempt: 'a' })).toBe('absent')
      expect(await store.pruneGivenBackExcept!(future, 10, ['budget-contract', 'budget-contract-c'])).toBe(0)
      expect(await store.pruneGivenBackExcept!(future, 10, [])).toBe(2)
      expect(await store.pruneGivenBack!(future, 10)).toBe(0)
    })

    /** The limit counts across the tenants that are pruned. */
    it('prunes the given-back applications of the other tenants up to the limit', async () => {
      const store = await make()
      await seedBudget(store, 'lim-a')
      await store.upsert({ id: 'lim-b', tenantId: 'budget-contract-b', scope: { type: 'tenant', id: 'budget-contract-b' }, window: 'total', softThresholds: [], policy: 'block' })
      const future = new Date(Date.now() + 3_600_000)
      for (const key of ['record:l1', 'record:l2', 'record:l3']) {
        await store.consumeWindowOnce({ key, budgetId: 'lim-b', attempt: 'a' }, windowStart, delta(5n), {})
        await store.dropReference({ key, budgetId: 'lim-b', attempt: 'a' })
      }
      expect(await store.pruneGivenBackExcept!(future, 2, ['budget-contract'])).toBe(2)
      expect(await store.pruneGivenBackExcept!(future, 2, ['budget-contract'])).toBe(1)
    })
  })
}
