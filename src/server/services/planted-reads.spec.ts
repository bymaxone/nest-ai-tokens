/**
 * @fileoverview The reads that decide what is reported, hashed or swept are the host's own: with a key planted on `Object.prototype` under the
 * name of an optional field, a usage report still sums every record of its filter, a hash chain written beside the plant still verifies once
 * it is removed, a sweep still walks its pages, and a Redis counter keeps its key prefix.
 * @layer server
 */

import { TENANT, usageRecord } from '../../../test/fakes/budget-fixtures'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { RedisBudgetCounterStore } from '../../redis'
import { BudgetReferenceSweeper } from '../enforcement/budget-reference-sweeper'
import type { IBudgetStore } from '../interfaces'
import { setRealmGuard } from '../utils/prototype-guard'
import { LedgerService } from './ledger.service'
import { UsageReportService } from './usage-report.service'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it. */
async function planted<T>(key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('a usage report beneath a polluted realm', () => {
  const FILTERS: [string, unknown][] = [
    ['isSystemCost', true], ['enforcedOnly', true], ['feature', 'zzz'], ['features', ['zzz']], ['provider', 'zzz'], ['model', 'zzz'], ['operation', 'embedding'],
    ['serviceTier', 'batch'], ['tags', ['zzz']], ['systemCostCategory', 'zzz'], ['status', ['released']], ['scope', { type: 'user', id: 'nobody' }], ['beneficiary', { type: 'user', id: 'nobody' }],
  ]

  /** Three recorded calls of 6,250,000 each, and a report service over them. */
  async function world(): Promise<UsageReportService> {
    const store = new InMemoryLedgerStore()
    for (const key of ['a', 'b', 'c']) await store.append(usageRecord({ idempotencyKey: key, billedCostNanoUsd: 6_250_000n, rawCostNanoUsd: 6_250_000n }), `hash-${key}`)
    return new UsageReportService(store, new InMemoryPricingStore(), { currency: 'USD', reporting: { maxExportRows: 100 } })
  }

  it.each(FILTERS)('sums the three records of its filter when %s is planted', async (key, value) => {
    const report = await world()
    const input = { tenantId: TENANT, from: new Date(0), to: new Date('2100-01-01T00:00:00.000Z'), groupBy: ['feature' as const] }
    const clean = await report.summarize(input)
    expect(clean.reduce((sum, row) => sum + row.records, 0)).toBe(3)
    const summary = await planted(key, value, () => report.summarize(input))
    expect(summary.reduce((sum, row) => sum + row.records, 0)).toBe(3)
    expect(summary.reduce((sum, row) => sum + row.billedCostNanoUsd, 0n)).toBe(18_750_000n)
  })
})

describe('a hash chain beneath a polluted realm', () => {
  it.each(['reversesRecordId', 'correlationId', 'requestedBy', 'requestedModel', 'requestId', 'systemCostCategory', 'extraUnits'])('still verifies after a record is written while %s is planted', async (key) => {
    const store = new InMemoryLedgerStore()
    const ledger = new LedgerService(store, { ledger: { hashChain: true } })
    await ledger.append(usageRecord({ idempotencyKey: 'a' }), 'a')
    await planted(key, key === 'extraUnits' ? { web_search: 1 } : 'planted', () => ledger.append(usageRecord({ idempotencyKey: 'b' }), 'b'))
    await ledger.append(usageRecord({ idempotencyKey: 'c' }), 'c')
    expect(await ledger.verifyChain(TENANT)).toEqual(expect.objectContaining({ valid: true }))
  })
})

describe('the options of a sweep and of a counter beneath a polluted realm', () => {
  it('walks its pages when pages and pageSize are planted as 0 and the host gave none', async () => {
    const list = jest.fn((_query: { limit: number }) => Promise.resolve([]))
    const store = { findStaleReferences: list } as unknown as IBudgetStore
    const sweeper = await planted('pages', 0, () => planted('pageSize', 0, () => Promise.resolve(new BudgetReferenceSweeper(store, new LedgerService(new InMemoryLedgerStore()), { graceSeconds: 1, holdTtlSeconds: 1, retentionSeconds: 1 }))))
    await sweeper.sweep()
    expect(list).toHaveBeenCalled()
    expect(list.mock.calls.every(([query]) => query.limit > 0)).toBe(true)
  })

  it('keeps an empty key prefix when keyPrefix is planted and the host gave none', async () => {
    const counter = await planted('keyPrefix', 'planted:', () => Promise.resolve(new RedisBudgetCounterStore('redis://localhost:6379')))
    expect((counter as unknown as { keyPrefix: string }).keyPrefix).toBe('')
  })
})
