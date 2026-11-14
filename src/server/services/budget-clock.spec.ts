/**
 * A budget's creation instant and the records it counts come from one clock, so a record written in the same
 * millisecond as the budget is counted by a recompute, whatever a store would stamp on its own.
 * @layer test
 */
import { NOW, TENANT, budgetInput, makeService, usageRecord } from '../../../test/fakes/budget-fixtures'

describe('BudgetService stamps a budget on its own clock', () => {
  it('stamps createdAt from the injected clock, to the millisecond', async () => {
    const { service } = makeService({ storeOptions: { unstampedCreatedAtOffsetMs: 1 } })

    const budget = await service.upsertBudget(budgetInput({ window: 'total', limitTokens: 1_000 }))

    expect(budget.createdAt).toEqual(NOW)
  })

  /** A store that rounds an unstamped createdAt up by a millisecond would put the window start after this record. */
  it('counts a record written in the same millisecond as the budget when the window is recomputed', async () => {
    const { service, store, ledgerStore } = makeService({ storeOptions: { unstampedCreatedAtOffsetMs: 1 } })
    const budget = await service.upsertBudget(budgetInput({ window: 'total', limitTokens: 1_000 }))
    await ledgerStore.append(usageRecord({ idempotencyKey: 'a', totalTokens: 400, occurredAt: NOW }), 'ha')

    await service.reconcileWindow(budget.id, TENANT, budget.createdAt)

    expect((await store.getWindow(budget.id, budget.createdAt))?.spentTokens).toBe(400)
  })

  it('keeps the first createdAt when the budget is updated', async () => {
    let tick = 0
    const { service } = makeService({ now: () => new Date(NOW.getTime() + tick) })
    const created = await service.upsertBudget(budgetInput({ window: 'total', limitTokens: 1_000 }))
    tick = 5_000

    const updated = await service.upsertBudget({ ...budgetInput({ window: 'total', limitTokens: 2_000 }), id: created.id })

    expect(updated.createdAt).toEqual(created.createdAt)
    expect(updated.limitTokens).toBe(2_000)
  })
})
