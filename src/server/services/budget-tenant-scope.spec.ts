/**
 * Tenant B cannot delete, rotate, reconcile or overwrite tenant A's budget by its id: each call answers exactly as an
 * unknown id does, with the same result and the same message, and A's budget is left as it was.
 * @layer test
 */
import type { Budget } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { NOW, TENANT, budgetInput, codeOf, context, makeService } from '../../../test/fakes/budget-fixtures'
import { BudgetService } from './budget.service'
import { LedgerService } from './ledger.service'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import type { BudgetKey, IBudgetStore } from '../interfaces'

const OTHER = 'tenant-b'
const WINDOW = new Date('2026-06-01T00:00:00.000Z')

/** The message of the rejection of a promise, or `undefined` when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string } | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return { code: codeOf(error), message: (error as Error).message }
  }
}

/** A store that ignores the tenant of every key it is given. */
function tenantBlindStore(inner: InMemoryBudgetStore): IBudgetStore {
  const anyTenant = (key: BudgetKey): BudgetKey => ({ ...key, tenantId: [...inner.tenantsOf(key.id)][0] ?? key.tenantId })
  return {
    upsert: (budget) => inner.upsertAnyTenant(budget),
    remove: (key) => inner.remove(anyTenant(key)),
    findBudgetById: (key) => inner.findBudgetById(anyTenant(key)),
    findMatching: (_tenantId, scope) => inner.findMatchingAnyTenant(scope),
    conditionalConsume: (...args) => inner.conditionalConsume(...args),
    adjustWindow: (...args) => inner.adjustWindow(...args),
    getWindow: (...args) => inner.getWindow(...args),
    setWindowStart: (key, windowStart) => inner.setWindowStart(anyTenant(key), windowStart),
  }
}

describe('BudgetService admin paths are tenant-scoped', () => {
  it('answers removeBudget of another tenant exactly as an unknown id: nothing removed, nothing audited', async () => {
    const { service, store, audits } = makeService()
    const a = await service.upsertBudget(budgetInput())
    audits.length = 0

    const foreign = await rejection(service.removeBudget(a.id, OTHER))
    const unknown = await rejection(service.removeBudget('does-not-exist', OTHER))

    expect(foreign).toEqual(unknown)
    expect(foreign).toBeUndefined()
    expect(audits).toEqual([])
    expect(await store.findBudgetById({ tenantId: TENANT, id: a.id })).not.toBeNull()
  })

  it('answers rotateWindow of another tenant exactly as an unknown id, and leaves the budget unchanged', async () => {
    const { service, store } = makeService()
    const a = await service.upsertBudget(budgetInput())
    const before = await store.findBudgetById({ tenantId: TENANT, id: a.id })

    const foreign = await rejection(service.rotateWindow(a.id, OTHER, new Date('2026-06-20T00:00:00.000Z')))
    const unknown = await rejection(service.rotateWindow('does-not-exist', OTHER, new Date('2026-06-20T00:00:00.000Z')))

    expect(foreign?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(foreign?.message.replace(a.id, 'ID')).toBe(unknown?.message.replace('does-not-exist', 'ID'))
    expect(await store.findBudgetById({ tenantId: TENANT, id: a.id })).toEqual(before)
  })

  it('answers reconcileWindow of another tenant exactly as an unknown id, and leaves the counters alone', async () => {
    const { service, store } = makeService()
    const a = await service.upsertBudget(budgetInput())
    store.forceWindow(a.id, WINDOW, { spentNanoUsd: 7n, spentTokens: 7, spentCount: 7 })

    const foreign = await rejection(service.reconcileWindow(a.id, OTHER, WINDOW))
    const unknown = await rejection(service.reconcileWindow('does-not-exist', OTHER, WINDOW))

    expect(foreign?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(foreign?.message.replace(a.id, 'ID')).toBe(unknown?.message.replace('does-not-exist', 'ID'))
    expect(await store.getWindow(a.id, WINDOW)).toEqual({ spentNanoUsd: 7n, spentTokens: 7, spentCount: 7 })
  })

  it('refuses to overwrite the budget of another tenant by id, without naming it', async () => {
    const { service, store } = makeService()
    const a = await service.upsertBudget(budgetInput())
    const before = await store.findBudgetById({ tenantId: TENANT, id: a.id })

    const refused = await rejection(service.upsertBudget({ ...budgetInput(), tenantId: OTHER, id: a.id, limitNanoUsd: 1n }))

    expect(refused?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(refused?.message).not.toContain(TENANT)
    expect(await store.findBudgetById({ tenantId: TENANT, id: a.id })).toEqual(before)
  })

  /** A caller from plain JavaScript can put anything in the tenant position: it never reaches a store key. */
  it.each([
    { name: 'undefined', tenant: undefined },
    { name: 'an empty string', tenant: '' },
    { name: 'a Date', tenant: new Date() },
    { name: 'a number', tenant: 7 },
  ])('refuses $name as the tenant before it touches the store', async ({ tenant }) => {
    const { service, store } = makeService()
    const a = await service.upsertBudget(budgetInput())
    const touched = jest.spyOn(store, 'findBudgetById')
    const removed = jest.spyOn(store, 'remove')

    const results = await Promise.all([
      rejection(service.removeBudget(a.id, tenant as never)),
      rejection(service.rotateWindow(a.id, tenant as never, NOW)),
      rejection(service.reconcileWindow(a.id, tenant as never, WINDOW)),
      rejection(service.upsertBudget({ ...budgetInput(), tenantId: tenant as never })),
    ])

    for (const result of results) expect(result?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(touched).not.toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
  })

  /** The refusal is only for an id another tenant owns: an unused id, and the tenant's own id, still upsert. */
  it('upserts a new explicit id and updates the tenant own budget by id', async () => {
    const { service, store } = makeService()
    const created = await service.upsertBudget({ ...budgetInput(), id: 'explicit-id' })
    const updated = await service.upsertBudget({ ...budgetInput(), id: created.id, limitNanoUsd: 5n })

    expect(created.id).toBe('explicit-id')
    expect(updated.limitNanoUsd).toBe(5n)
    expect((await store.findBudgetById({ tenantId: TENANT, id: 'explicit-id' }))?.limitNanoUsd).toBe(5n)
  })
})

describe('BudgetService does not trust a store that ignores the tenant', () => {
  function blind(): { service: BudgetService; inner: InMemoryBudgetStore; a: () => Promise<Budget> } {
    const inner = new InMemoryBudgetStore({ now: () => NOW })
    const service = new BudgetService(tenantBlindStore(inner), new LedgerService(new InMemoryLedgerStore()), { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true }, () => NOW)
    return { service, inner, a: () => service.upsertBudget(budgetInput()) }
  }

  it('keeps removeBudget, rotateWindow and reconcileWindow from reaching A through a blind store', async () => {
    const { service, inner, a } = blind()
    const budget = await a()

    await service.removeBudget(budget.id, OTHER)
    const rotate = await rejection(service.rotateWindow(budget.id, OTHER, NOW))
    const reconcile = await rejection(service.reconcileWindow(budget.id, OTHER, WINDOW))

    expect(rotate?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(reconcile?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(await inner.findBudgetById({ tenantId: TENANT, id: budget.id })).not.toBeNull()
  })

  it('does not let tenant B consume, or list, A budgets when findMatching ignores the tenant', async () => {
    const { service, inner, a } = blind()
    const budget = await a()

    expect(await service.list(OTHER)).toEqual([])
    await service.consume(context({ tenantId: OTHER }), { nanoUsd: 5n, tokens: 0, count: 1 })

    expect(await inner.getWindow(budget.id, WINDOW)).toBeNull()
  })

  it('refuses an upsert that would overwrite the budget of another tenant through a blind store', async () => {
    const { service, inner, a } = blind()
    const budget = await a()
    const before = await inner.findBudgetById({ tenantId: TENANT, id: budget.id })

    const refused = await rejection(service.upsertBudget({ ...budgetInput(), tenantId: OTHER, id: budget.id, limitNanoUsd: 1n }))

    expect(refused?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(refused?.message).not.toContain(TENANT)
    expect(await inner.findBudgetById({ tenantId: TENANT, id: budget.id })).toEqual(before)
  })

  it('does not return a budget the store stored under another tenant', async () => {
    const inner = new InMemoryBudgetStore({ now: () => NOW })
    const wrong: IBudgetStore = { ...tenantBlindStore(inner), upsert: (budget) => inner.upsertAnyTenant({ ...budget, tenantId: TENANT }) }
    const service = new BudgetService(wrong, new LedgerService(new InMemoryLedgerStore()), { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true }, () => NOW)

    const refused = await rejection(service.upsertBudget({ ...budgetInput(), tenantId: OTHER }))

    expect(refused?.code).toBe('AI_TOKENS_INVALID_CONFIG')
  })
})
