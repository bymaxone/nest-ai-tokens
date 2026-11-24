/**
 * @fileoverview A promise on a decision path is waited for with a native `await`, never chained. A chain (`.then`, `.catch`, `.finally`)
 * returns a promise built by the constructor that `Promise[Symbol.species]` names, read on every call, so a host that controls that slot,
 * or the `constructor` of the promise it returned, decides what the chain resolves to. Each row plants such a slot for the one call that
 * chains, with a constructor that hands back a promise of a forged answer, and asserts the answer the store or the ledger really gave.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import { usageRow, entryRow, T0 } from '../test/fakes/prisma-rows'
import { TENANT } from '../test/fakes/budget-fixtures'
import { InMemoryBudgetStore } from '../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../test/fakes/in-memory-ledger-store'
import { usageRecord } from '../test/fakes/budget-fixtures'
import { PrismaAiTokensStore } from './prisma'
import { guardStoreErrors } from './prisma/store-boundary'
import { rowAfterFailure } from './server/services/record-replay'
import { LedgerService } from './server/services/ledger.service'
import { BudgetReferenceSweeper } from './server/enforcement/budget-reference-sweeper'
import { setRealmGuard } from './server/utils/prototype-guard'
import type { UsageRecord } from './shared'

// The rows plant a species on `Promise`, which the realm guard does not name; the guard is off only so that a planted slot is not refused early.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

/** A constructor that runs the executor it is given and hands back `answer` as the promise the chain resolves to. */
function forging(answer: Promise<unknown>): new (executor: (resolve: () => void, reject: () => void) => void) => Promise<unknown> {
  return function Forged(executor: (resolve: () => void, reject: () => void) => void): Promise<unknown> {
    executor(() => undefined, () => undefined)
    return answer
  } as unknown as new (executor: (resolve: () => void, reject: () => void) => void) => Promise<unknown>
}

/** Plant the species on `Promise`, call `start` (which chains before it first awaits), remove the species, and give back what `start` returned. */
function whileSpeciesPlanted<T>(answer: unknown, start: () => T): T {
  const forged = forging(Promise.resolve(answer))
  Object.defineProperty(Promise, Symbol.species, { configurable: true, get: () => forged })
  try {
    return start()
  } finally {
    Reflect.deleteProperty(Promise, Symbol.species)
  }
}

/** A driver that answers every query with `rows` and runs a transaction on itself. */
function driver(rows: (text: string) => unknown): ConstructorParameters<typeof PrismaAiTokensStore>[0] {
  const client = {
    // `async` functions, so that no row of this driver goes through the live `Promise.resolve` that one row replaces.
    $queryRawUnsafe: async (text: string): Promise<unknown> => rows(text),
    $executeRawUnsafe: async (): Promise<number> => 0,
    $transaction: <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => fn(client),
  }
  return client as unknown as ConstructorParameters<typeof PrismaAiTokensStore>[0]
}

describe('a promise on a decision path is not chained', () => {
  it('the store boundary hands back what the store resolved with, not what a planted species made', async () => {
    class Store {
      findThing(): Promise<string> {
        return Promise.resolve('real')
      }
    }
    const guarded = guardStoreErrors(new Store(), () => false)
    expect(await whileSpeciesPlanted('FORGED', () => guarded.findThing())).toBe('real')
  })

  it('the ledger query of the PostgreSQL store reads the rows the database returned', async () => {
    const store = new PrismaAiTokensStore(driver(() => [usageRow()]))
    expect(await whileSpeciesPlanted([], () => store.query({ tenantId: TENANT }))).toHaveLength(1)
  })

  it('the debit lookup of the PostgreSQL store reads the rows the database returned', async () => {
    const store = new PrismaAiTokensStore(driver(() => []))
    const query = { keyPrefixes: ['reserve:'], olderThan: T0, limit: 10 }
    expect(await whileSpeciesPlanted([{ forged: true }], () => store.findDebitsBefore(query))).toEqual([])
  })

  it('the entry listing of the PostgreSQL store reads the page and the count the database returned', async () => {
    const wallet = { id: 'w1', tenantId: TENANT, ownerType: 'user', ownerId: 'u1', balanceNanoUsd: 1_000n, createdAt: T0, updatedAt: T0 }
    const store = new PrismaAiTokensStore(
      driver((text) => (text.includes('COUNT(*)') ? [{ total: 1n }] : text.includes('"ai_wallet_entries"') ? [entryRow()] : [wallet])),
    )
    const ref = { tenantId: TENANT, ownerType: 'user', ownerId: 'u1' } as const
    const page = await whileSpeciesPlanted([[], [{ total: 99n }]], () => store.listEntries(ref))
    expect(page.total).toBe(1)
    expect(page.entries).toHaveLength(1)
  })

  it('the entry listing reads the page and the count when Promise.resolve is the planted slot', async () => {
    const wallet = { id: 'w1', tenantId: TENANT, ownerType: 'user', ownerId: 'u1', balanceNanoUsd: 1_000n, createdAt: T0, updatedAt: T0 }
    const store = new PrismaAiTokensStore(
      driver((text) => (text.includes('COUNT(*)') ? [{ total: 1n }] : text.includes('"ai_wallet_entries"') ? [entryRow()] : [wallet])),
    )
    const ref = { tenantId: TENANT, ownerType: 'user', ownerId: 'u1' } as const
    const kept = Promise.resolve
    // `Promise.all` asks `Promise.resolve` for every element, so a host that replaces it answers for the page and the count.
    let asked = 0
    Object.defineProperty(Promise, 'resolve', { configurable: true, writable: true, value: () => kept.call(Promise, (asked += 1) === 1 ? [] : [{ total: 99n }]) })
    let pending: Promise<unknown>
    try {
      pending = store.listEntries(ref).then(
        (page) => page,
        (error: unknown) => error,
      )
      await pending
    } finally {
      Object.defineProperty(Promise, 'resolve', { configurable: true, writable: true, value: kept })
    }
    const page = (await pending) as { total?: number }
    expect(page.total).toBe(1)
  })

  it('the lookup after a failed append returns the row the ledger holds', async () => {
    const row = usageRecord({ tenantId: TENANT }) as UsageRecord
    expect(await whileSpeciesPlanted(null, () => rowAfterFailure(() => Promise.resolve(row)))).toBe(row)
  })

  it('the budget a stale reference names is the one the store returned', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    let now = new Date('2026-06-10T12:00:00.000Z')
    const budgets = new InMemoryBudgetStore({ now: () => now })
    const ledgerStore = new InMemoryLedgerStore(() => now)
    const budget = await budgets.upsert({ id: 'b1', tenantId: 't1', scope: { type: 'user', id: 'u1' }, window: 'month', softThresholds: [], policy: 'block' })
    const reference = { key: 'reserve:k1', budgetId: 'b1', attempt: 'a1' }
    const window = new Date('2026-06-01T00:00:00.000Z')
    expect(await budgets.consumeWindowOnce(reference, window, { nanoUsd: 25n, tokens: 100, count: 1 }, {})).toBe('applied')
    await ledgerStore.append({
      ...usageRecord({
        tenantId: 't1',
        scope: { type: 'user', id: 'u1' },
        billedCostNanoUsd: 25n,
        inputTokens: 100,
        totalTokens: 100,
        occurredAt: new Date('2026-06-10T00:00:00.000Z'),
        status: 'posted',
        idempotencyKey: 'k1',
      }),
    }, 'hash')
    const found = await budgets.findBudgetById({ tenantId: 't1', id: 'b1' })
    // The slot is planted for the sweep, and forges only the first chain after the store is asked for the budget.
    const intrinsic = Promise
    const forged = forging(Promise.resolve(null))
    let armed = false
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get: () => {
        if (!armed) return intrinsic
        armed = false
        return forged
      },
    })
    jest.spyOn(budgets, 'findBudgetById').mockImplementation(() => {
      armed = true
      return Promise.resolve(found)
    })
    const sweeper = new BudgetReferenceSweeper(budgets, new LedgerService(ledgerStore), { graceSeconds: 300, holdTtlSeconds: 900, retentionSeconds: 604_800 }, () => now)
    now = new Date(now.getTime() + 1_201_000)
    try {
      await sweeper.sweep()
    } finally {
      Reflect.deleteProperty(Promise, Symbol.species)
    }
    // The same call, so the movement is kept and its reference renamed to `row`: a forged absent budget would give it back instead.
    expect(await budgets.getWindow('b1', window)).toEqual({ spentNanoUsd: 25n, spentTokens: 100, spentCount: 1 })
    expect(budget.id).toBe('b1')
  })
})
