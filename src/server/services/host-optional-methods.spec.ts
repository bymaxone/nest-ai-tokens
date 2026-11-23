/**
 * An optional method of a host store is one the store or its class defines. A function planted on `Object.prototype` under the name of
 * such a method is not the store's: the library must not call it, and must treat the store as one that keeps no such method. Each row
 * plants a spy under the name, runs the operation over a store that has none, and asserts the spy was never called and the fallback ran.
 * @layer server
 */
import { Logger } from '@nestjs/common'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { ResolvedAiTokensOptions } from '../config'
import { BudgetReferenceSweeper } from '../enforcement/budget-reference-sweeper'
import { OrphanDebitSweeper } from '../enforcement/orphan-debit-sweeper'
import type { IBudgetStore } from '../interfaces'
import { LedgerService } from './ledger.service'
import { PricingService } from './pricing.service'
import { UsageReportService } from './usage-report.service'
import { setRealmGuard } from '../utils/prototype-guard'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them; the guard is proven in prototype-guard.spec.ts.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

/** A copy of `store` as a plain object that has every method of it except `names`, so those are found nowhere but on `Object.prototype`. */
function without<T extends object>(store: T, ...names: string[]): T {
  const copy: Record<string, unknown> = {}
  for (let holder: object | null = store; holder !== null && holder !== Object.prototype; holder = Object.getPrototypeOf(holder) as object | null) {
    for (const key of Object.getOwnPropertyNames(holder)) {
      if (key === 'constructor' || names.includes(key) || key in copy) continue
      const value = (store as Record<string, unknown>)[key]
      copy[key] = typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(store) : value
    }
  }
  return copy as T
}

/** Plant a spy as `name` on `Object.prototype`, run `run`, remove it, and return the spy. */
async function planted(name: string, run: () => Promise<unknown>): Promise<jest.Mock> {
  const spy = jest.fn(() => Promise.resolve([]))
  Object.defineProperty(Object.prototype, name, { value: spy, configurable: true, writable: true, enumerable: false })
  try {
    await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, name)
  }
  return spy
}

const OWED = ['findEffectsOwed', 'findEffectsOwedFor', 'clearEffectsOwed']

describe('the owed-effects methods of a ledger store', () => {
  it.each(OWED)('is not found on Object.prototype under the name %s', async (name) => {
    const ledger = new LedgerService(without(new InMemoryLedgerStore(), ...OWED))
    const spy = await planted(name, async () => {
      expect(ledger.supportsOwedEffects()).toBe(false)
      expect(await ledger.findEffectsOwed(new Date(), 10)).toEqual([])
      expect(await ledger.findEffectsOwedFor('r1')).toBeNull()
      expect(await ledger.clearEffectsOwed('r1')).toBe(false)
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('still finds a method the store defines', async () => {
    const ledger = new LedgerService(new InMemoryLedgerStore())
    expect(ledger.supportsOwedEffects()).toBe(true)
  })
})

describe('the seedPrice method of a pricing store', () => {
  it('is not found on Object.prototype, so the seed goes through upsertPrice', async () => {
    const store = new InMemoryPricingStore()
    const upsert = jest.spyOn(store, 'upsertPrice')
    const service = new PricingService({ pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} } } as ResolvedAiTokensOptions, without(store, 'seedPrice'))
    const spy = await planted('seedPrice', () => service.seedFromSnapshot())
    expect(spy).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalled()
  })
})

describe('the summarize method of a ledger store', () => {
  it('is not found on Object.prototype, so a summary is aggregated from the rows', async () => {
    const report = new UsageReportService(without(new InMemoryLedgerStore(), 'summarize'), new InMemoryPricingStore(), { currency: 'USD', reporting: { maxExportRows: 100 } })
    let summary: unknown
    const spy = await planted('summarize', async () => {
      summary = await report.summarize({ tenantId: 't1', from: new Date(0), to: new Date(), groupBy: ['feature'] })
    })
    expect(spy).not.toHaveBeenCalled()
    expect(summary).toEqual([])
  })
})

describe('the optional methods of a budget store and a wallet store, as the sweeps see them', () => {
  const OPTIONS = { graceSeconds: 60, holdTtlSeconds: 60, retentionSeconds: 3_600 }

  it.each(['findStaleReferences', 'pruneApplication', 'pruneGivenBack', 'pruneGivenBackExcept'])('does not call %s when the budget store has none', async (name) => {
    const list = jest.fn((_query: { selection: string }) => Promise.resolve([]))
    const store = (name === 'findStaleReferences' ? {} : { findStaleReferences: list }) as unknown as IBudgetStore
    const sweeper = new BudgetReferenceSweeper(store, new LedgerService(new InMemoryLedgerStore()), OPTIONS)
    const spy = await planted(name, () => sweeper.sweep())
    expect(spy).not.toHaveBeenCalled()
    // Without pruneApplication the sweep never walks the retained applications, whatever is planted under that name.
    expect(list.mock.calls.map(([query]) => query.selection)).not.toContain('retained')
  })

  it('does not call findDebitsBefore when the wallet store has none, and is not supported', async () => {
    const sweeper = new OrphanDebitSweeper({}, new LedgerService(new InMemoryLedgerStore()), { graceSeconds: 60, retentionSeconds: 3_600 }, () => new Date(), () => Promise.resolve())
    let supported = true
    const spy = await planted('findDebitsBefore', async () => {
      supported = sweeper.supported
      await sweeper.sweep()
    })
    expect(supported).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('still calls a method the store defines', async () => {
    const list = jest.fn(() => Promise.resolve([]))
    const sweeper = new BudgetReferenceSweeper({ findStaleReferences: list } as unknown as IBudgetStore, new LedgerService(new InMemoryLedgerStore()), OPTIONS)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await sweeper.sweep()
    expect(list).toHaveBeenCalled()
  })
})
