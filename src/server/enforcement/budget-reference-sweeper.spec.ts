/**
 * @fileoverview The budget-reference sweep against in-memory stores: for every cell of the verdict product, the sweep
 * leaves the window and the references a run in which the call never failed would have left. A reference an attempt left
 * behind is given back when its row is not the same call, renamed to `row` when it is, and a committed reference is
 * left alone, except the reservation of a released hold.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { Budget, UsageStatus } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { usageRecord } from '../../../test/fakes/budget-fixtures'
import { LedgerService } from '../services/ledger.service'
import type { ReferenceKind, ReferenceName, RowState } from '../services/budget-reference-verdict'
import { BudgetReferenceSweeper } from './budget-reference-sweeper'
import { setRealmGuard } from '../utils/prototype-guard'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them; the guard is proven in prototype-guard.spec.ts.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

const GRACE = 300
const TTL = 900
const RETENTION = 7 * 24 * 3600
const WINDOW = new Date('2026-06-01T00:00:00.000Z')
const OCCURRED = new Date('2026-06-10T00:00:00.000Z')
const ZERO = { spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 }
const ALL_LINE = 'ai_tokens.budget_reference_sweep.prune_skipped given-back pruning skipped: an owed marker is older than the retention'
const TENANT_LINE = (count: number): string => `ai_tokens.budget_reference_sweep.prune_skipped given-back pruning skipped for ${String(count)} tenant(s): an owed marker is older than the retention`

/** A clock the stores and the sweeper share. */
function clock(): { now: () => Date; advance: (seconds: number) => void } {
  const state = { at: new Date('2026-06-10T12:00:00.000Z') }
  return { now: (): Date => state.at, advance: (seconds): void => void (state.at = new Date(state.at.getTime() + seconds * 1000)) }
}

interface Rig {
  budgets: InMemoryBudgetStore
  ledgerStore: InMemoryLedgerStore
  sweeper: BudgetReferenceSweeper
  advance: (seconds: number) => void
  now: () => Date
  budget: Budget
}

async function rig(over: { pageSize?: number; pages?: number } = {}): Promise<Rig> {
  const { now, advance } = clock()
  const budgets = new InMemoryBudgetStore({ now })
  const ledgerStore = new InMemoryLedgerStore(now)
  const budget = await budgets.upsert({ id: 'b1', tenantId: 't1', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
  const sweeper = new BudgetReferenceSweeper(budgets, new LedgerService(ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, now, over)
  return { budgets, ledgerStore, sweeper, advance, now, budget }
}

/** The references left on every application, as `key/attempt`. */
function references(store: InMemoryBudgetStore): Promise<string[]> {
  return Promise.resolve(store.heldReferences())
}

const DELTA = { nanoUsd: 25n, tokens: 100, count: 1 }

/** Put one cell of the product in place: the application and its reference, and the ledger row under the key. */
async function arrange(r: Rig, kind: ReferenceKind, name: ReferenceName, state: RowState, same: boolean): Promise<string> {
  const key = `${kind}:k1`
  const reference = { key, budgetId: 'b1', attempt: 'a1' }
  expect(await r.budgets.consumeWindowOnce(reference, WINDOW, DELTA, {})).toBe('applied')
  if (name === 'row') await r.budgets.commitReference(reference)
  if (state !== 'none') {
    await r.ledgerStore.append({ ...usageRecord({ tenantId: 't1', scope: { type: 'user', id: same ? 'u1' : 'u2' }, billedCostNanoUsd: 25n, inputTokens: 100, totalTokens: 100, occurredAt: OCCURRED, status: state, idempotencyKey: `k1` }) }, 'hash')
  }
  return `${key}/${name === 'row' ? 'row' : 'a1'}`
}

describe('BudgetReferenceSweeper', () => {
  beforeEach(() => void jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined))
  afterEach(() => void jest.restoreAllMocks())

  /**
   * Invariant: whatever the cell, the sweep ends with the window and the references of a run in which nothing failed. A
   * movement given back leaves a zero window and no reference (the call never happened); a movement kept leaves the
   * window at the call's amount and exactly one reference, named `row`; a reference that is not judged stays as it was.
   */
  const CELLS: [ReferenceKind, ReferenceName, RowState, 'same' | 'other', 'drop' | 'commit' | 'keep'][] = [
    ['reserve', 'attempt', 'none', 'other', 'drop'],
    ['reserve', 'attempt', 'pending', 'same', 'commit'],
    ['reserve', 'attempt', 'pending', 'other', 'drop'],
    ['reserve', 'attempt', 'posted', 'same', 'commit'],
    ['reserve', 'attempt', 'posted', 'other', 'drop'],
    ['reserve', 'attempt', 'reversed', 'same', 'commit'],
    ['reserve', 'attempt', 'reversed', 'other', 'drop'],
    ['reserve', 'attempt', 'released', 'same', 'drop'],
    ['record', 'attempt', 'none', 'other', 'drop'],
    ['record', 'attempt', 'pending', 'same', 'drop'],
    ['record', 'attempt', 'posted', 'same', 'commit'],
    ['record', 'attempt', 'posted', 'other', 'drop'],
    ['record', 'attempt', 'reversed', 'same', 'commit'],
    ['record', 'attempt', 'reversed', 'other', 'drop'],
    ['record', 'attempt', 'released', 'same', 'drop'],
    ['reserve', 'row', 'pending', 'same', 'keep'],
    ['reserve', 'row', 'posted', 'same', 'keep'],
    ['reserve', 'row', 'reversed', 'same', 'keep'],
    ['reserve', 'row', 'released', 'same', 'drop'],
    ['record', 'row', 'posted', 'same', 'keep'],
    ['record', 'row', 'reversed', 'same', 'keep'],
  ]

  it.each(CELLS)('%s reference named %s with a %s row that is %s: %s', async (kind, name, state, same, verdict) => {
    const r = await rig()
    const left = await arrange(r, kind, name, state, same === 'same')
    // A `row` reference of a hold is judged once it is older than the hold TTL plus the grace; an attempt's after the grace.
    r.advance(TTL + GRACE + 1)
    await r.sweeper.sweep()
    const window = (await r.budgets.getWindow('b1', WINDOW)) ?? ZERO
    if (verdict === 'drop') {
      expect(window).toEqual(ZERO)
      expect(await references(r.budgets)).toEqual([])
    } else if (verdict === 'commit') {
      expect(window).toEqual({ spentNanoUsd: 25n, spentTokens: 100, spentCount: 1 })
      expect(await references(r.budgets)).toEqual([`${kind}:k1/row`])
    } else {
      expect(window).toEqual({ spentNanoUsd: 25n, spentTokens: 100, spentCount: 1 })
      expect(await references(r.budgets)).toEqual([left])
    }
  })

  /** The budget a reference names is read as the store returned it: a `features` planted on `Object.prototype` does not make the call another call. */
  it('commits the reference of the same call when a features is planted on Object.prototype and the budget has none', async () => {
    const r = await rig()
    await arrange(r, 'reserve', 'attempt', 'posted', true)
    r.advance(TTL + GRACE + 1)
    Object.defineProperty(Object.prototype, 'features', { value: ['planted.feature'], configurable: true, writable: true, enumerable: false })
    try {
      await r.sweeper.sweep()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'features')
    }
    expect(await r.budgets.getWindow('b1', WINDOW)).toEqual({ spentNanoUsd: 25n, spentTokens: 100, spentCount: 1 })
    expect(await references(r.budgets)).toEqual(['reserve:k1/row'])
  })

  /** A budget the store no longer has is nobody's: the reference is judged as another call's and given back. */
  it('gives back the reference of an attempt whose budget no longer exists', async () => {
    const r = await rig()
    await arrange(r, 'reserve', 'attempt', 'posted', true)
    jest.spyOn(r.budgets, 'findBudgetById').mockResolvedValue(null)
    r.advance(TTL + GRACE + 1)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual([])
  })

  /** A reference that is not older than the grace belongs to an attempt that may still be running: it is not touched. */
  it('leaves a reference younger than the grace alone', async () => {
    const r = await rig()
    await arrange(r, 'record', 'attempt', 'none', false)
    r.advance(GRACE - 1)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual(['record:k1/a1'])
    expect((await r.budgets.getWindow('b1', WINDOW))?.spentNanoUsd).toBe(25n)
  })

  /** The reservation of a released hold is judged only once it is older than the hold TTL plus the grace. */
  it('leaves the committed reservation of a released hold alone until it is older than the TTL plus the grace', async () => {
    const r = await rig()
    await arrange(r, 'reserve', 'row', 'released', true)
    r.advance(TTL + GRACE - 1)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual(['reserve:k1/row'])
    r.advance(2)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual([])
    expect(await r.budgets.getWindow('b1', WINDOW)).toEqual(ZERO)
  })

  /** A second sweep, and a sweep that finds nothing, change nothing. */
  it('is idempotent', async () => {
    const r = await rig()
    await arrange(r, 'record', 'attempt', 'posted', true)
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    const once = [await references(r.budgets), await r.budgets.getWindow('b1', WINDOW)]
    await r.sweeper.sweep()
    expect([await references(r.budgets), await r.budgets.getWindow('b1', WINDOW)]).toEqual(once)
    expect(Logger.prototype.warn).not.toHaveBeenCalled()
  })

  /**
   * Invariant: the kept `row` references of live calls, which stay older than the bound for as long as their rows stand,
   * never starve a reference that needs a verdict. With a page of two and one page a tick, the cursor walks past four kept
   * reservations and reaches the released one behind them on the third tick, and wraps to the start after the last page.
   */
  it('reaches a reference behind more kept references than a page holds, over several ticks, and wraps', async () => {
    const r = await rig({ pageSize: 2, pages: 1 })
    for (const [index, state] of (['posted', 'posted', 'posted', 'posted', 'released'] as const).entries()) {
      const key = `reserve:h${String(index)}`
      const reference = { key, budgetId: 'b1', attempt: 'a' }
      await r.budgets.consumeWindowOnce(reference, WINDOW, DELTA, {})
      await r.budgets.commitReference(reference)
      await r.ledgerStore.append({ ...usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: state, idempotencyKey: `h${String(index)}`, occurredAt: OCCURRED }) }, 'hash')
      r.advance(1)
    }
    r.advance(TTL + GRACE)
    await r.sweeper.sweep()
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toHaveLength(5)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual(['reserve:h0/row', 'reserve:h1/row', 'reserve:h2/row', 'reserve:h3/row'])
    expect((await r.budgets.getWindow('b1', WINDOW))?.spentNanoUsd).toBe(100n)
    // The walk ended on a short page and wrapped: the next tick starts again from the first reference, and changes nothing.
    await r.sweeper.sweep()
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toHaveLength(4)
  })

  /**
   * Invariant: a tenant-wide budget cannot tell two payers apart and need not. Both attempts hold the one application, whose
   * movement is counted once; whichever reference the sweep renames first becomes `row` and the other drops itself.
   */
  it('counts a tenant-wide movement once when two payers each hold a reference on it', async () => {
    const r = await rig()
    await r.budgets.upsert({ id: 'b1', tenantId: 't1', scope: { type: 'tenant', id: 't1' }, window: 'month', softThresholds: [], policy: 'block' })
    await r.budgets.consumeWindowOnce({ key: 'record:k1', budgetId: 'b1', attempt: 'a1' }, WINDOW, DELTA, {})
    await r.budgets.consumeWindowOnce({ key: 'record:k1', budgetId: 'b1', attempt: 'a2' }, WINDOW, DELTA, {})
    await r.ledgerStore.append({ ...usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, billedCostNanoUsd: 25n, inputTokens: 100, totalTokens: 100, occurredAt: OCCURRED, idempotencyKey: 'k1' }) }, 'hash')
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual(['record:k1/row'])
    expect(await r.budgets.getWindow('b1', WINDOW)).toEqual({ spentNanoUsd: 25n, spentTokens: 100, spentCount: 1 })
  })

  /** A `record:` reference whose application moved another amount than the row's billed amount is another call's: given back. */
  it('drops a record reference whose application delta differs from the row\'s amount', async () => {
    const r = await rig()
    await r.budgets.consumeWindowOnce({ key: 'record:k1', budgetId: 'b1', attempt: 'a1' }, WINDOW, { nanoUsd: 30n, tokens: 100, count: 1 }, {})
    await r.ledgerStore.append({ ...usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, billedCostNanoUsd: 25n, inputTokens: 100, totalTokens: 100, occurredAt: OCCURRED, idempotencyKey: 'k1' }) }, 'hash')
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual([])
    expect(await r.budgets.getWindow('b1', WINDOW)).toEqual(ZERO)
  })

  /** One reference that fails to settle never stops the rest, and the tick writes one summary line with a count, no amount. */
  it('settles the other references when one fails, and logs one line with a count', async () => {
    const r = await rig()
    for (const key of ['record:a', 'record:b']) await r.budgets.consumeWindowOnce({ key, budgetId: 'b1', attempt: 'x' }, WINDOW, DELTA, {})
    const original = r.budgets.dropReference.bind(r.budgets)
    jest.spyOn(r.budgets, 'dropReference').mockImplementation((reference) => (reference.key === 'record:a' ? Promise.reject(new Error('down')) : original(reference)))
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual(['record:a/x'])
    const lines = (Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))
    expect(lines).toEqual(['ai_tokens.budget_reference_sweep.settle_failed count=1'])
  })

  /** A listing that fails with something that is not an Error is still logged, as a fixed marker. */
  it('logs a rejection that is not an Error without its content', async () => {
    const r = await rig()
    jest.spyOn(r.budgets, 'findStaleReferences').mockRejectedValue('secret connection string')
    await r.sweeper.sweep()
    expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))[0]).toBe('ai_tokens.budget_reference_sweep.scan_failed non-Error rejection')
  })

  /** An attempt-named reference whose key is no hold's or record's is not judged by this table. */
  it('leaves an attempt-named reference of a key it does not know alone', async () => {
    const r = await rig()
    await r.budgets.adjustWindowOnce({ key: 'capture:x', budgetId: 'b1', attempt: 'a' }, WINDOW, DELTA)
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(await references(r.budgets)).toEqual(['capture:x/a'])
  })

  /** A store that can list but not delete leaves the pruning out and still settles the references. */
  it('settles references for a store that cannot prune', async () => {
    const r = await rig()
    await arrange(r, 'record', 'attempt', 'none', false)
    const bare = Object.create(r.budgets, { pruneGivenBack: { value: undefined }, pruneGivenBackExcept: { value: undefined }, pruneApplication: { value: undefined } }) as InMemoryBudgetStore
    const sweeper = new BudgetReferenceSweeper(bare, new LedgerService(r.ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, () => new Date(Date.now() + 10 * 365 * 86_400_000))
    const listed = jest.spyOn(bare, 'findStaleReferences')
    await sweeper.sweep()
    expect(await references(r.budgets)).toEqual([])
    expect(listed.mock.calls.map(([query]) => query.selection)).not.toContain('retained')
  })

  /** One budget is loaded once for every reference of a page that names it. */
  it('loads a budget once for the references of a page that name it', async () => {
    const r = await rig()
    for (const key of ['record:a', 'record:b', 'record:c']) await r.budgets.consumeWindowOnce({ key, budgetId: 'b1', attempt: 'x' }, WINDOW, DELTA, {})
    const loaded = jest.spyOn(r.budgets, 'findBudgetById')
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(loaded).toHaveBeenCalledTimes(1)
  })

  /** A reference that is kept is neither renamed nor dropped: the store is not asked to touch it. */
  it('asks the store to change nothing for a reference it keeps', async () => {
    const r = await rig()
    await arrange(r, 'reserve', 'row', 'posted', true)
    const commit = jest.spyOn(r.budgets, 'commitReference')
    const drop = jest.spyOn(r.budgets, 'dropReference')
    r.advance(TTL + GRACE + 1)
    await r.sweeper.sweep()
    expect([commit.mock.calls.length, drop.mock.calls.length]).toEqual([0, 0])
  })

  /** Without a clock of its own the sweep reads the wall clock: a reference that was just taken is younger than the grace. */
  it('reads the wall clock when none is given', async () => {
    const r = await rig()
    const real = new InMemoryBudgetStore()
    await real.upsert({ id: 'b1', tenantId: 't1', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
    await real.consumeWindowOnce({ key: 'record:now', budgetId: 'b1', attempt: 'a' }, WINDOW, DELTA, {})
    await new BudgetReferenceSweeper(real, new LedgerService(r.ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }).sweep()
    expect(real.heldReferences()).toEqual(['record:now/a'])
  })

  /** A failed listing ends the tick with a logged line and no throw; the next tick retries. */
  it('logs a failed listing and ends the tick', async () => {
    const r = await rig()
    jest.spyOn(r.budgets, 'findStaleReferences').mockRejectedValue(new Error('down'))
    await expect(r.sweeper.sweep()).resolves.toBeUndefined()
    expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))[0]).toContain('ai_tokens.budget_reference_sweep.scan_failed name=Error')
  })

  /** A store without the listing leaves the sweep inactive. */
  it('does nothing for a store that cannot list stale references', async () => {
    const r = await rig()
    const bare = Object.create(r.budgets, { findStaleReferences: { value: undefined } }) as InMemoryBudgetStore
    const sweeper = new BudgetReferenceSweeper(bare, new LedgerService(r.ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION })
    await expect(sweeper.sweep()).resolves.toBeUndefined()
  })

  /**
   * Pruning deletes the record that made a movement replayable, once the movement belongs to a row that ended and the
   * application is older than the retention. It moves no window.
   */
  describe('pruning', () => {
    /** An application held under `row` by a committed call, with its ledger row, aged past the retention. */
    async function committed(r: Rig, key: string, status: UsageStatus, owed = false): Promise<void> {
      const reference = { key, budgetId: 'b1', attempt: 'a' }
      await r.budgets.consumeWindowOnce(reference, WINDOW, DELTA, {})
      await r.budgets.commitReference(reference)
      const idempotencyKey = key.slice(key.indexOf(':') + 1)
      await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status, idempotencyKey, occurredAt: OCCURRED }), 'hash', undefined, owed ? { reason: 'refund' } : undefined)
    }

    it.each([
      ['posted', 'record:k1'],
      ['reversed', 'record:k2'],
      ['posted', 'reserve:k3'],
    ] as const)('deletes the application of a %s row under %s once it is older than the retention, and moves no window', async (status, key) => {
      const r = await rig()
      await committed(r, key, status)
      r.advance(RETENTION - 1)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual([`${key}/row`])
      r.advance(2)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual([])
      expect((await r.budgets.getWindow('b1', WINDOW))?.spentNanoUsd).toBe(25n)
    })

    /**
     * Invariant: a released hold's reservation is given back by the verdict, never deleted by the pruning. The two ages are
     * independent (the held walk judges it after the hold TTL plus the grace and can lag behind a cursor), so deleting its
     * application first would leave the movement counted with nothing left to give it back.
     */
    it('leaves the reservation of a released hold to the verdict even when it is older than the retention', async () => {
      const r = await rig()
      const short = new BudgetReferenceSweeper(r.budgets, new LedgerService(r.ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: TTL }, r.now)
      await committed(r, 'reserve:rel', 'released')
      r.advance(TTL + 1)
      await short.sweep()
      expect(await references(r.budgets)).toEqual(['reserve:rel/row'])
      expect((await r.budgets.getWindow('b1', WINDOW))?.spentNanoUsd).toBe(25n)
      r.advance(GRACE)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual([])
      expect(await r.budgets.getWindow('b1', WINDOW)).toEqual(ZERO)
    })

    /** A hold that is still pending is the only thing its reference stands on: it is never pruned, however old. */
    it('never deletes the application of a pending hold', async () => {
      const r = await rig()
      await committed(r, 'reserve:p1', 'pending')
      r.advance(RETENTION * 3)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual(['reserve:p1/row'])
    })

    /** An application whose row still owes effects is what a re-run of those effects relies on: it stays until the marker is cleared. */
    it('keeps the application of a row that still owes effects, and deletes it once they were finished', async () => {
      const r = await rig()
      await committed(r, 'record:m1', 'posted', true)
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual(['record:m1/row'])
      const row = await r.ledgerStore.findByIdempotencyKey('t1', 'm1')
      await r.ledgerStore.clearEffectsOwed(row?.id ?? '')
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual([])
    })

    /**
     * Invariant: a reversal whose effects are still owed keeps the application that deduplicates its budget leg. The marker of a
     * reversal is on the compensating row, not on the original the key names, so the pruning reads both; deleting it would let the
     * sweep's retry subtract the reversal's amounts a second time and erase unrelated spend.
     */
    it('keeps the application of a reversal whose compensating row still owes effects, and deletes it once they were finished', async () => {
      const r = await rig()
      const original = await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'posted', idempotencyKey: 'rev-orig', occurredAt: OCCURRED }), 'hash')
      const compensating = await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'posted', idempotencyKey: `reverse:${original.id}`, reversesRecordId: original.id, occurredAt: OCCURRED }), 'hash', undefined, { reason: 'refund' })
      await r.ledgerStore.transition(original.id, 'posted', 'reversed', { reversedByRecordId: compensating.id })
      const reference = { key: `reverse:${original.id}`, budgetId: 'b1', attempt: 'a' }
      await r.budgets.adjustWindowOnce(reference, WINDOW, DELTA)
      await r.budgets.commitReference(reference)
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual([`reverse:${original.id}/row`])
      await r.ledgerStore.clearEffectsOwed(compensating.id)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual([])
    })

    /**
     * Invariant: while a released hold still owes its effects, the record of its given-back reservation stays, so a retry of the
     * release finds the application and gives nothing back a second time. The given-back applications carry no key to the row, so
     * the pruning waits for every marker older than the retention to be cleared.
     */
    it('keeps the given-back applications while a marker older than the retention remains, and deletes them once it is cleared', async () => {
      const r = await rig()
      const held = { key: 'reserve:rel', budgetId: 'b1', attempt: 'row' }
      await r.budgets.consumeWindowOnce(held, WINDOW, DELTA, {})
      await r.budgets.dropReference(held)
      const row = await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'released', idempotencyKey: 'rel', occurredAt: OCCURRED }), 'hash', undefined, { reason: 'refund' })
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      // The tick says why nothing was pruned, once, so a stuck marker is visible.
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual([TENANT_LINE(1)])
      // The application is still there: dropping the reference again finds it, with no reference left on it.
      expect(await r.budgets.dropReference(held)).toBe('missing')
      ;(Logger.prototype.warn as jest.Mock).mockClear()
      await r.ledgerStore.clearEffectsOwed(row.id)
      await r.sweeper.sweep()
      expect(await r.budgets.dropReference(held)).toBe('absent')
      expect(Logger.prototype.warn).not.toHaveBeenCalled()
    })

    /**
     * Invariant: a marker older than the retention protects the given-back applications of its own tenant and no other: the
     * application belongs to a budget and a budget to one tenant, and the retry that needs it is of a row of that tenant.
     */
    it('keeps the given-back applications of the tenant that owes effects and prunes the other tenants', async () => {
      const r = await rig()
      await r.budgets.upsert({ id: 'b2', tenantId: 't2', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
      for (const budgetId of ['b1', 'b2']) {
        await r.budgets.consumeWindowOnce({ key: 'reserve:rel', budgetId, attempt: 'row' }, WINDOW, DELTA, {})
        await r.budgets.dropReference({ key: 'reserve:rel', budgetId, attempt: 'row' })
      }
      const row = await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'released', idempotencyKey: 'rel', occurredAt: OCCURRED }), 'hash', undefined, { reason: 'refund' })
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual([TENANT_LINE(1)])
      expect(await r.budgets.dropReference({ key: 'reserve:rel', budgetId: 'b1', attempt: 'row' })).toBe('missing')
      expect(await r.budgets.dropReference({ key: 'reserve:rel', budgetId: 'b2', attempt: 'row' })).toBe('absent')
      ;(Logger.prototype.warn as jest.Mock).mockClear()
      await r.ledgerStore.clearEffectsOwed(row.id)
      await r.sweeper.sweep()
      expect(await r.budgets.dropReference({ key: 'reserve:rel', budgetId: 'b1', attempt: 'row' })).toBe('absent')
      expect(Logger.prototype.warn).not.toHaveBeenCalled()
    })

    /** Two tenants with an old marker are two in the line, and a tenant with several markers is one. */
    it('counts the tenants that owe effects, not the markers', async () => {
      const r = await rig()
      for (const [tenantId, key] of [['t1', 'a'], ['t1', 'b'], ['t2', 'c']] as const) {
        await r.ledgerStore.append(usageRecord({ tenantId, scope: { type: 'user', id: 'u1' }, status: 'released', idempotencyKey: key, occurredAt: OCCURRED }), `hash-${key}`, undefined, { reason: 'refund' })
      }
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual([TENANT_LINE(2)])
    })

    /** A ledger that keeps no marker owes nothing, so no tenant is spared and every tenant is pruned. */
    it('prunes every tenant on a ledger that keeps no marker', async () => {
      const r = await rig()
      await r.budgets.upsert({ id: 'b2', tenantId: 't2', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
      for (const budgetId of ['b1', 'b2']) {
        await r.budgets.consumeWindowOnce({ key: 'record:g', budgetId, attempt: 'a' }, WINDOW, DELTA, {})
        await r.budgets.dropReference({ key: 'record:g', budgetId, attempt: 'a' })
      }
      const markerless = Object.create(r.ledgerStore, { findEffectsOwed: { value: undefined }, findEffectsOwedFor: { value: undefined }, clearEffectsOwed: { value: undefined } }) as InMemoryLedgerStore
      const sweeper = new BudgetReferenceSweeper(r.budgets, new LedgerService(markerless), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, r.now)
      r.advance(RETENTION + 1)
      await sweeper.sweep()
      for (const budgetId of ['b1', 'b2']) expect(await r.budgets.dropReference({ key: 'record:g', budgetId, attempt: 'a' })).toBe('absent')
      expect(Logger.prototype.warn).not.toHaveBeenCalled()
    })

    /** A listing that is exactly one page long is whole: the sweep asks for one row more than a page to tell. */
    it('names the tenants when the marker listing is exactly one page long', async () => {
      const r = await rig({ pageSize: 1 })
      await r.budgets.upsert({ id: 'b2', tenantId: 't2', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
      await r.budgets.consumeWindowOnce({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' }, WINDOW, DELTA, {})
      await r.budgets.dropReference({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' })
      await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'released', idempotencyKey: 'a', occurredAt: OCCURRED }), 'hash-a', undefined, { reason: 'refund' })
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual([TENANT_LINE(1)])
      expect(await r.budgets.dropReference({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' })).toBe('absent')
    })

    /** A store that cannot spare a tenant is paused for all, and says so with the line that names no tenant count. */
    it('pauses the given-back pruning for every tenant on a store that cannot spare one', async () => {
      const r = await rig()
      await r.budgets.upsert({ id: 'b2', tenantId: 't2', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
      await r.budgets.consumeWindowOnce({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' }, WINDOW, DELTA, {})
      await r.budgets.dropReference({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' })
      await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'released', idempotencyKey: 'rel', occurredAt: OCCURRED }), 'hash', undefined, { reason: 'refund' })
      const bare = Object.create(r.budgets, { pruneGivenBackExcept: { value: undefined } }) as InMemoryBudgetStore
      const sweeper = new BudgetReferenceSweeper(bare, new LedgerService(r.ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, r.now)
      r.advance(RETENTION + 1)
      await sweeper.sweep()
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual([ALL_LINE])
      expect(await r.budgets.dropReference({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' })).toBe('missing')
    })

    /** A listing that may have been cut at the page size cannot name every tenant, so nobody is pruned. */
    it('pauses the given-back pruning for every tenant when the marker listing may be truncated', async () => {
      const r = await rig({ pageSize: 1 })
      await r.budgets.upsert({ id: 'b2', tenantId: 't2', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
      await r.budgets.consumeWindowOnce({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' }, WINDOW, DELTA, {})
      await r.budgets.dropReference({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' })
      for (const [tenantId, key] of [['t1', 'a'], ['t3', 'b']] as const) {
        await r.ledgerStore.append(usageRecord({ tenantId, scope: { type: 'user', id: 'u1' }, status: 'released', idempotencyKey: key, occurredAt: OCCURRED }), `hash-${key}`, undefined, { reason: 'refund' })
      }
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual([ALL_LINE])
      expect(await r.budgets.dropReference({ key: 'reserve:x', budgetId: 'b2', attempt: 'row' })).toBe('missing')
    })

    /** With no marker older than the retention the pruning spares nobody. */
    it('prunes every tenant when no marker is older than the retention', async () => {
      const r = await rig()
      await r.budgets.upsert({ id: 'b2', tenantId: 't2', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
      for (const budgetId of ['b1', 'b2']) {
        await r.budgets.consumeWindowOnce({ key: 'record:g', budgetId, attempt: 'a' }, WINDOW, DELTA, {})
        await r.budgets.dropReference({ key: 'record:g', budgetId, attempt: 'a' })
      }
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      for (const budgetId of ['b1', 'b2']) expect(await r.budgets.dropReference({ key: 'record:g', budgetId, attempt: 'a' })).toBe('absent')
      expect(Logger.prototype.warn).not.toHaveBeenCalled()
    })

    it('counts a failed read of the markers with the rest of the tick and prunes nothing given back', async () => {
      const r = await rig()
      await r.budgets.consumeWindowOnce({ key: 'record:g', budgetId: 'b1', attempt: 'a' }, WINDOW, DELTA, {})
      await r.budgets.dropReference({ key: 'record:g', budgetId: 'b1', attempt: 'a' })
      jest.spyOn(r.ledgerStore, 'findEffectsOwed').mockRejectedValue(new Error('down'))
      const pruned = jest.spyOn(r.budgets, 'pruneGivenBack')
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect(pruned).not.toHaveBeenCalled()
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual(['ai_tokens.budget_reference_sweep.settle_failed count=1'])
    })

    /** A committed reference with no row under its key, or under a key the table does not know, is left alone. */
    it('keeps a reference whose row is missing and one whose key it does not know', async () => {
      const r = await rig()
      for (const key of ['record:none', 'other:x']) {
        const reference = { key, budgetId: 'b1', attempt: 'a' }
        await r.budgets.consumeWindowOnce(reference, WINDOW, DELTA, {})
        await r.budgets.commitReference(reference)
      }
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual(['other:x/row', 'record:none/row'])
    })

    /** The applications of a capture, a reversal and a release are judged by the row they settle: its id, or the hold's key. */
    it.each([
      ['capture:', 'posted', true],
      ['capture:', 'pending', false],
      ['reverse:', 'reversed', true],
      ['reverse:', 'posted', false],
      ['release:reserve:', 'released', true],
      ['release:reserve:', 'posted', false],
    ] as const)('prunes a %s application when its row is %s: %s', async (prefix, status, pruned) => {
      const r = await rig()
      const row = await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status, idempotencyKey: 'hold-9', occurredAt: OCCURRED }), 'hash')
      const key = prefix === 'release:reserve:' ? `${prefix}hold-9` : `${prefix}${row.id}`
      const reference = { key, budgetId: 'b1', attempt: 'a' }
      await r.budgets.adjustWindowOnce(reference, WINDOW, DELTA)
      await r.budgets.commitReference(reference)
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual(pruned ? [] : [`${key}/row`])
    })

    it('does not delete the application of a capture whose row belongs to another tenant', async () => {
      const r = await rig()
      const row = await r.ledgerStore.append(usageRecord({ tenantId: 't2', status: 'posted', idempotencyKey: 'x', occurredAt: OCCURRED }), 'hash')
      const reference = { key: `capture:${row.id}`, budgetId: 'b1', attempt: 'a' }
      await r.budgets.adjustWindowOnce(reference, WINDOW, DELTA)
      await r.budgets.commitReference(reference)
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect(await references(r.budgets)).toEqual([`${reference.key}/row`])
    })

    /** An application that was given back is deleted once it is older than the retention; a younger one stays. */
    it('deletes the applications given back before the retention, and not the ones given back since', async () => {
      const r = await rig()
      const give = async (key: string): Promise<void> => {
        await r.budgets.consumeWindowOnce({ key, budgetId: 'b1', attempt: 'a' }, WINDOW, DELTA, {})
        await r.budgets.dropReference({ key, budgetId: 'b1', attempt: 'a' })
      }
      await give('record:old')
      r.advance(RETENTION + 1)
      await give('record:new')
      await r.sweeper.sweep()
      // Dropping a reference tells an application that is gone ('absent') from one that is given back and still recorded
      // ('missing'); taking the key again would answer 'applied' either way.
      expect(await r.budgets.dropReference({ key: 'record:old', budgetId: 'b1', attempt: 'a' })).toBe('absent')
      expect(await r.budgets.dropReference({ key: 'record:new', budgetId: 'b1', attempt: 'a' })).toBe('missing')
    })

    it('counts a failed deletion of given-back applications with the rest of the tick', async () => {
      const r = await rig()
      jest.spyOn(r.budgets, 'pruneGivenBackExcept').mockRejectedValue(new Error('down'))
      await r.sweeper.sweep()
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual(['ai_tokens.budget_reference_sweep.settle_failed count=1'])
    })

    /** A store that only knows the pruning of every tenant is still pruned by it when nothing owes effects. */
    it('prunes with the store that cannot spare a tenant when no marker is older than the retention', async () => {
      const r = await rig()
      await r.budgets.consumeWindowOnce({ key: 'record:g', budgetId: 'b1', attempt: 'a' }, WINDOW, DELTA, {})
      await r.budgets.dropReference({ key: 'record:g', budgetId: 'b1', attempt: 'a' })
      const bare = Object.create(r.budgets, { pruneGivenBackExcept: { value: undefined } }) as InMemoryBudgetStore
      const sweeper = new BudgetReferenceSweeper(bare, new LedgerService(r.ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, r.now)
      r.advance(RETENTION + 1)
      await sweeper.sweep()
      expect(await r.budgets.dropReference({ key: 'record:g', budgetId: 'b1', attempt: 'a' })).toBe('absent')
      expect(Logger.prototype.warn).not.toHaveBeenCalled()
    })

    it('leaves the pruning to a store that can do it, and logs a failure once per tick', async () => {
      const r = await rig()
      await committed(r, 'record:f1', 'posted')
      await committed(r, 'record:f2', 'posted')
      jest.spyOn(r.budgets, 'pruneApplication').mockRejectedValue(new Error('down'))
      r.advance(RETENTION + 1)
      await r.sweeper.sweep()
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual(['ai_tokens.budget_reference_sweep.settle_failed count=2'])
    })

    /** A store that can spare a tenant but has no pruning of every tenant is still pruned, sparing nobody, when nothing is owed. */
    it('prunes through the store that can spare a tenant when it has no pruning of every tenant and the ledger keeps no marker', async () => {
      const r = await rig()
      await r.budgets.consumeWindowOnce({ key: 'record:g', budgetId: 'b1', attempt: 'a' }, WINDOW, DELTA, {})
      await r.budgets.dropReference({ key: 'record:g', budgetId: 'b1', attempt: 'a' })
      const only = Object.create(r.budgets, { pruneGivenBack: { value: undefined } }) as InMemoryBudgetStore
      const markerless = Object.create(r.ledgerStore, { findEffectsOwed: { value: undefined }, findEffectsOwedFor: { value: undefined }, clearEffectsOwed: { value: undefined } }) as InMemoryLedgerStore
      const sweeper = new BudgetReferenceSweeper(only, new LedgerService(markerless), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, r.now)
      r.advance(RETENTION + 1)
      await sweeper.sweep()
      expect(await r.budgets.dropReference({ key: 'record:g', budgetId: 'b1', attempt: 'a' })).toBe('absent')
      expect(Logger.prototype.warn).not.toHaveBeenCalled()
    })

    /** The pruning of a store that spares tenants and has no other is asked for with no tenant spared: an empty list, nothing else. */
    it('asks a store with no pruning of every tenant to prune with an empty list of spared tenants', async () => {
      const r = await rig()
      const only = Object.create(r.budgets, { pruneGivenBack: { value: undefined } }) as InMemoryBudgetStore
      const markerless = Object.create(r.ledgerStore, { findEffectsOwed: { value: undefined }, findEffectsOwedFor: { value: undefined }, clearEffectsOwed: { value: undefined } }) as InMemoryLedgerStore
      const spy = jest.spyOn(only, 'pruneGivenBackExcept')
      const sweeper = new BudgetReferenceSweeper(only, new LedgerService(markerless), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, r.now)
      r.advance(RETENTION + 1)
      await sweeper.sweep()
      expect(spy).toHaveBeenCalledWith(expect.any(Date), expect.any(Number), [])
    })

    /** A store that knows no pruning of given-back applications says nothing about a marker that is owed: there is nothing to pause. */
    it('logs no pause for a store with no pruning at all, whatever is owed', async () => {
      const r = await rig({ pageSize: 1 })
      for (const key of ['x1', 'x2']) await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'released', idempotencyKey: key, occurredAt: OCCURRED }), `hash-${key}`, undefined, { reason: 'refund' })
      const none = Object.create(r.budgets, { pruneGivenBack: { value: undefined }, pruneGivenBackExcept: { value: undefined } }) as InMemoryBudgetStore
      const sweeper = new BudgetReferenceSweeper(none, new LedgerService(r.ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, r.now, { pageSize: 1 })
      r.advance(RETENTION + 1)
      await sweeper.sweep()
      expect(Logger.prototype.warn).not.toHaveBeenCalled()
    })

    /** The same store keeps the pause when a marker is owed and the listing cannot name the tenants, and prunes nothing. */
    it('pauses for every tenant on a store with no pruning of every tenant when the marker listing may be truncated', async () => {
      const r = await rig({ pageSize: 1 })
      await r.budgets.consumeWindowOnce({ key: 'record:g', budgetId: 'b1', attempt: 'a' }, WINDOW, DELTA, {})
      await r.budgets.dropReference({ key: 'record:g', budgetId: 'b1', attempt: 'a' })
      for (const key of ['x1', 'x2']) await r.ledgerStore.append(usageRecord({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, status: 'released', idempotencyKey: key, occurredAt: OCCURRED }), `hash-${key}`, undefined, { reason: 'refund' })
      const only = Object.create(r.budgets, { pruneGivenBack: { value: undefined } }) as InMemoryBudgetStore
      const sweeper = new BudgetReferenceSweeper(only, new LedgerService(r.ledgerStore), { graceSeconds: GRACE, holdTtlSeconds: TTL, retentionSeconds: RETENTION }, r.now, { pageSize: 1 })
      r.advance(RETENTION + 1)
      await sweeper.sweep()
      expect(await r.budgets.dropReference({ key: 'record:g', budgetId: 'b1', attempt: 'a' })).toBe('missing')
      expect((Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))).toEqual([ALL_LINE])
    })
  })
})
