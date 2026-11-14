/**
 * @fileoverview The verdict of the budget-reference sweep: what happens to a reference an attempt left behind, as a
 * function of the reference's kind and name, the state of the ledger row under its key, and whether that row is the same
 * call. The table below is the whole product; a kind, a name or a row state without an entry fails the enumeration.
 * @layer server
 */

import type { Budget, UsageRecord, UsageStatus } from '../../shared'
import type { StaleReference } from '../interfaces'
import { usageRecord } from '../../../test/fakes/budget-fixtures'
import { isSameCall, judge, kindOf, ledgerKeyOf, lookupOf, type ReferenceKind, type ReferenceName, type RowState, type ReferenceVerdict, verdictFor } from './budget-reference-verdict'

const KINDS: ReferenceKind[] = ['reserve', 'record']
const NAMES: ReferenceName[] = ['attempt', 'row']
const STATES: RowState[] = ['none', 'pending', 'posted', 'reversed', 'released']

/** One verdict per cell: `[kind, name, row state, same call]`. A cell the sweep cannot reach still has one, so no cell is left to chance. */
const MATRIX: Record<string, ReferenceVerdict> = {
  // reserve, named by an attempt
  'reserve/attempt/none/other': 'drop',
  'reserve/attempt/none/same': 'drop',
  'reserve/attempt/pending/other': 'drop',
  'reserve/attempt/pending/same': 'commit',
  'reserve/attempt/posted/other': 'drop',
  'reserve/attempt/posted/same': 'commit',
  'reserve/attempt/reversed/other': 'drop',
  'reserve/attempt/reversed/same': 'commit',
  'reserve/attempt/released/other': 'drop',
  'reserve/attempt/released/same': 'drop',
  // record, named by an attempt: a hold row is never the same call as a record, and a record row is never released
  'record/attempt/none/other': 'drop',
  'record/attempt/none/same': 'drop',
  'record/attempt/pending/other': 'drop',
  'record/attempt/pending/same': 'drop',
  'record/attempt/posted/other': 'drop',
  'record/attempt/posted/same': 'commit',
  'record/attempt/reversed/other': 'drop',
  'record/attempt/reversed/same': 'commit',
  'record/attempt/released/other': 'drop',
  'record/attempt/released/same': 'drop',
  // reserve, named `row`: only a released hold gives its reservation back
  'reserve/row/none/other': 'keep',
  'reserve/row/none/same': 'keep',
  'reserve/row/pending/other': 'keep',
  'reserve/row/pending/same': 'keep',
  'reserve/row/posted/other': 'keep',
  'reserve/row/posted/same': 'keep',
  'reserve/row/reversed/other': 'keep',
  'reserve/row/reversed/same': 'keep',
  'reserve/row/released/other': 'drop',
  'reserve/row/released/same': 'drop',
  // record, named `row`: a record row is never released, so nothing here is given back
  'record/row/none/other': 'keep',
  'record/row/none/same': 'keep',
  'record/row/pending/other': 'keep',
  'record/row/pending/same': 'keep',
  'record/row/posted/other': 'keep',
  'record/row/posted/same': 'keep',
  'record/row/reversed/other': 'keep',
  'record/row/reversed/same': 'keep',
  'record/row/released/other': 'keep',
  'record/row/released/same': 'keep',
}

describe('verdictFor', () => {
  /** Every cell of the product has a verdict, and the table holds nothing the product does not. */
  it('names a verdict for every kind, name, row state and same-call cell, and no other', () => {
    const cells = KINDS.flatMap((kind) => NAMES.flatMap((name) => STATES.flatMap((state) => (['same', 'other'] as const).map((same) => `${kind}/${name}/${state}/${same}`))))
    expect(cells.filter((cell) => !(cell in MATRIX))).toEqual([])
    expect(Object.keys(MATRIX).filter((cell) => !cells.includes(cell))).toEqual([])
  })

  /** The row states the table enumerates are the ledger's own: a new status makes this fail until the table names it. */
  it('enumerates exactly the ledger statuses', () => {
    const statuses: Record<UsageStatus, true> = { pending: true, posted: true, reversed: true, released: true }
    expect([...STATES].filter((state) => state !== 'none').sort()).toEqual(Object.keys(statuses).sort())
  })

  it.each(Object.entries(MATRIX))('gives %s the verdict %s', (cell, verdict) => {
    const [kind, name, state, same] = cell.split('/') as [ReferenceKind, ReferenceName, RowState, 'same' | 'other']
    expect(verdictFor(kind, name, state, same === 'same')).toBe(verdict)
  })
})

const AT = new Date('2026-06-10T00:00:00.000Z')
const MONTH = new Date('2026-06-01T00:00:00.000Z')

function row(over: Partial<UsageRecord> = {}): UsageRecord {
  return { ...usageRecord({ billedCostNanoUsd: 25n, totalTokens: 100, inputTokens: 100, occurredAt: AT, ...over }), id: 'r1', createdAt: AT, updatedAt: AT }
}

function budget(over: Partial<Budget> = {}): Budget {
  return { id: 'b1', tenantId: 't1', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block', createdAt: new Date('2026-01-01T00:00:00.000Z'), ...over }
}

function stale(over: Partial<StaleReference> = {}): StaleReference {
  return { key: 'record:k1', budgetId: 'b1', tenantId: 't1', attempt: 'a1', createdAt: AT, windowStart: MONTH, delta: { nanoUsd: 25n, tokens: 100, count: 1 }, ...over }
}

describe('kindOf and ledgerKeyOf', () => {
  it('reads the kind from the key prefix and the ledger key from what follows it', () => {
    expect(kindOf('reserve:abc')).toBe('reserve')
    expect(kindOf('record:abc')).toBe('record')
    expect(ledgerKeyOf('reserve:abc:def', 'reserve')).toBe('abc:def')
    expect(ledgerKeyOf('record:abc', 'record')).toBe('abc')
  })

  /** The keys that take `row` directly are not judged by this table. */
  it.each(['capture:r1', 'reverse:r1', 'release:reserve:k', 'other'])('has no kind for %s', (key) => {
    expect(kindOf(key)).toBeNull()
  })
})

describe('isSameCall', () => {
  it('accepts an enforced row of the budget\'s payer, feature and window with the application\'s delta', () => {
    expect(isSameCall('record', stale(), budget(), row())).toBe(true)
  })

  /** One case per condition, each the only thing that differs from the accepted call above. */
  it.each([
    ['another tenant', budget({ tenantId: 't2' }), stale(), row()],
    ['another payer', budget({ scope: { type: 'user', id: 'u2' } }), stale(), row()],
    ['another feature', budget({ features: ['other'] }), stale(), row()],
    ['an unenforced row', budget(), stale(), row({ enforced: false })],
    ['a system cost', budget(), stale(), row({ isSystemCost: true })],
    ['another window', budget(), stale({ windowStart: new Date('2026-05-01T00:00:00.000Z') }), row()],
    ['another billed amount', budget(), stale({ delta: { nanoUsd: 26n, tokens: 100, count: 1 } }), row()],
    ['other tokens', budget(), stale({ delta: { nanoUsd: 25n, tokens: 99, count: 1 } }), row()],
    ['another count', budget(), stale({ delta: { nanoUsd: 25n, tokens: 100, count: 2 } }), row()],
  ])('rejects a record reference when the row differs by %s', (_name, b, ref, r) => {
    expect(isSameCall('record', ref, b, r)).toBe(false)
  })

  it('accepts a tenant-wide budget for any payer of the tenant, and a budget whose feature list holds the row\'s feature', () => {
    expect(isSameCall('record', stale(), budget({ scope: { type: 'tenant', id: 't1' } }), row({ scope: { type: 'user', id: 'u9' } }))).toBe(true)
    expect(isSameCall('record', stale(), budget({ features: ['workout.generate'] }), row())).toBe(true)
  })

  /** A hold takes its window from the clock at the take and a capture overwrites the billed amount: neither is compared. */
  it('compares neither the window nor the amount for a reserve reference', () => {
    const ref = stale({ key: 'reserve:k1', windowStart: new Date('2026-05-01T00:00:00.000Z'), delta: { nanoUsd: 999n, tokens: 1, count: 1 } })
    expect(isSameCall('reserve', ref, budget(), row())).toBe(true)
    expect(isSameCall('reserve', ref, budget({ tenantId: 't2' }), row())).toBe(false)
    expect(isSameCall('reserve', ref, budget({ scope: { type: 'user', id: 'u2' } }), row())).toBe(false)
  })
})

describe('judge', () => {
  it('keeps a reference whose key names no hold or record', () => {
    expect(judge(stale({ key: 'capture:r1', attempt: 'row' }), budget(), row())).toBe('keep')
    expect(judge(stale({ key: 'capture:r1' }), budget(), row())).toBe('keep')
  })

  it('drops an attempt-named reference with no row, and with a row whose budget is gone', () => {
    expect(judge(stale(), budget(), null)).toBe('drop')
    expect(judge(stale(), null, row())).toBe('drop')
  })

  it('renames the reference of a same-call record row, keeps its row reference, and drops the reservation of a released hold', () => {
    expect(judge(stale(), budget(), row())).toBe('commit')
    expect(judge(stale({ attempt: 'row' }), budget(), row())).toBe('keep')
    expect(judge(stale({ key: 'reserve:k1', attempt: 'row' }), budget(), row({ status: 'released' }))).toBe('drop')
    expect(judge(stale({ key: 'reserve:k1' }), budget(), row({ status: 'pending' }))).toBe('commit')
  })
})

describe('lookupOf', () => {
  /** Each key names where its row is found and which status ends it; a key the table does not know has no lookup. */
  it.each([
    ['reserve:h1', 'key', 'h1', { pending: false, posted: true, reversed: true, released: true }],
    ['record:r1', 'key', 'r1', { pending: false, posted: true, reversed: true, released: true }],
    ['capture:id1', 'id', 'id1', { pending: false, posted: true, reversed: true, released: true }],
    ['reverse:id2', 'id', 'id2', { pending: false, posted: false, reversed: true, released: false }],
    ['release:reserve:h3', 'key', 'h3', { pending: false, posted: false, reversed: false, released: true }],
  ] as const)('reads %s by %s %s', (key, by, value, ends) => {
    const lookup = lookupOf(key)
    expect(lookup).toMatchObject({ by, value })
    for (const [status, ended] of Object.entries(ends)) expect(lookup?.ended(status as UsageStatus)).toBe(ended)
  })

  it('has no lookup for a key it does not know', () => {
    expect(lookupOf('other:x')).toBeNull()
    expect(lookupOf('')).toBeNull()
  })
})
