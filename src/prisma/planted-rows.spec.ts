/**
 * @fileoverview The rows the PostgreSQL adapter maps are read as the database returned them: a column that is `null` is an absent field, and
 * a key planted on `Object.prototype` under its name is not one. A grant with no expiry keeps its balance with an `expiresAt` planted in the
 * past, and every mapper hands the services a row with no prototype.
 * @layer prisma
 */

import { bareUsageRow, budgetRow, entryRow, priceRow, T0, T1 } from '../../test/fakes/prisma-rows'
import { mapBudgetRow, mapPriceRow, mapUsageRow, mapWalletEntryRow, walletBalanceDelta } from './adapter-sql'
import { setRealmGuard } from '../server/utils/prototype-guard'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it. */
function planted<T>(key: string, value: unknown, run: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('a grant with no expiry', () => {
  const PAST = new Date('2000-01-01T00:00:00.000Z')

  it('is spendable and keeps its amount when an expiresAt in the past is planted', () => {
    const entry = mapWalletEntryRow(entryRow({ type: 'grant', amountNanoUsd: 50_000_000_000n, expiresAt: null, effectiveAt: T0, createdAt: T1 }))
    expect(walletBalanceDelta(entry)).toBe(50_000_000_000n)
    expect(planted('expiresAt', PAST, () => walletBalanceDelta(entry))).toBe(50_000_000_000n)
  })
})

describe('the mappers of the adapter', () => {
  it.each([
    ['a usage row', () => mapUsageRow(bareUsageRow()), 'extraUnits'],
    ['a price row', () => mapPriceRow(priceRow({ unitRates: null })), 'unitRates'],
    ['a wallet entry row', () => mapWalletEntryRow(entryRow({ expiresAt: null })), 'expiresAt'],
    ['a budget row', () => mapBudgetRow(budgetRow({ limitTokens: null, features: [] })), 'limitTokens'],
  ])('hand the services %s with no prototype, whose absent field is not the planted one', (_name, map, key) => {
    const row = planted(key, 'planted', () => map()) as unknown as Record<string, unknown>
    expect(Object.getPrototypeOf(row)).toBeNull()
    expect(Object.hasOwn(row, key)).toBe(false)
    expect(row[key]).toBeUndefined()
  })
})
