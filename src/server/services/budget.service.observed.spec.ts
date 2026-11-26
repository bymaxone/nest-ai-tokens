/**
 * @fileoverview What `BudgetService` hands to the audit hook, the log and the threshold events.
 * @layer test
 */

import { Logger } from '@nestjs/common'
import { delta } from '../../../test/contracts/budget-store.contract'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { NOW, TENANT, budgetInput, context, makeService, recordingHooks } from '../../../test/fakes/budget-fixtures'
import { BudgetService } from './budget.service'
import { LedgerService } from './ledger.service'

/** A service whose audit hook keeps the payload it was handed, which the shared double drops. */
function makeAuditedService(): { service: BudgetService; audits: { action: string; data: unknown }[] } {
  const audits: { action: string; data: unknown }[] = []
  const noop = (): void => undefined
  const service = new BudgetService(
    new InMemoryBudgetStore({ now: () => NOW }),
    new LedgerService(new InMemoryLedgerStore()),
    { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true },
    () => NOW,
    { thresholdCrossed: noop, exceeded: noop, projectedExceeded: noop, audit: (action: string, data: unknown): void => void audits.push({ action, data }) }
  )
  return { service, audits }
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as { getResponse(): { error: { details: { reason: string } } } }).getResponse().error.details.reason
  }
  throw new Error('accepted')
}

describe('BudgetService — what an audit event carries', () => {
  it('names the tenant and the budget on upsert, remove and rotate', async () => {
    // Scenario: an auditor reads the event to learn which budget of which tenant changed.
    const { service, audits } = makeAuditedService()
    const budget = await service.upsertBudget(budgetInput())
    await service.rotateWindow(budget.id, TENANT, new Date('2026-06-20T00:00:00.000Z'))
    await service.removeBudget(budget.id, TENANT)
    expect(audits).toEqual([
      { action: 'ai_tokens.budget.upserted', data: { tenantId: TENANT, budgetId: budget.id } },
      { action: 'ai_tokens.budget.rotated', data: { tenantId: TENANT, budgetId: budget.id, windowStart: '2026-06-20T00:00:00.000Z' } },
      { action: 'ai_tokens.budget.removed', data: { tenantId: TENANT, budgetId: budget.id } }
    ])
  })
})

describe('BudgetService — the reason of a refusal', () => {
  it('says why each refusal happened', async () => {
    // Scenario: a host reads the reason to learn what to fix.
    const { service } = makeService()
    expect(await reasonOf(service.rotateWindow('nope', TENANT))).toBe('the budget does not exist')
    expect(await reasonOf(service.upsertBudget(budgetInput({ limitNanoUsd: undefined })))).toBe('a budget must define at least one limit dimension')
  })

  it('says a budget id of another tenant is not available', async () => {
    // Scenario: the store hands back a budget of another tenant; the service's own check refuses it without saying whose it is.
    const { service, store } = makeService()
    const real = store.upsert.bind(store)
    jest.spyOn(store, 'upsert').mockImplementation(async (input) => ({ ...(await real(input)), tenantId: 'other-tenant' }))
    expect(await reasonOf(service.upsertBudget(budgetInput()))).toBe('budget id is not available')
  })

  it('says the store answered no list', async () => {
    // Scenario: a store answers the budgets of a tenant with a non-array; the call fails closed with that reason.
    const { service, store } = makeService()
    jest.spyOn(store, 'findMatching').mockResolvedValue(undefined as never)
    expect(await reasonOf(service.list(TENANT))).toBe('the store answered the budgets of a tenant with something that is no list')
  })
})

describe('BudgetService — thresholds emitted in ascending order', () => {
  it('emits 0.8 before 0.9 before 1 though the budget lists them descending', async () => {
    // Scenario: one consume crosses all three at once; a host sees them lowest first.
    const { service, thresholds } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n, softThresholds: [1, 0.9, 0.8] }))
    await service.consume(context(), delta(100n))
    expect(thresholds.map((t) => t.threshold)).toEqual([0.8, 0.9, 1])
  })
})

describe('BudgetService — logged warnings carry their text', () => {
  it('says a throttled budget has no onThrottle callback', async () => {
    // Scenario: policy throttle with no callback configured; the log names the budget.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { service } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 10n, policy: 'throttle' }))
    await service.consume(context(), delta(50n)).catch(() => undefined)
    expect(warn).toHaveBeenCalledWith(`budget ${budget.id} exceeded with policy 'throttle' but no onThrottle callback is configured`)
  })

  it('says a counter reset failed on rotation', async () => {
    // Scenario: the counter store is down while a window rotates; the log names the budget.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const counter = { reset: jest.fn().mockRejectedValue(new Error('down')) }
    const { service } = makeService({ options: { counter: counter as never } })
    const budget = await service.upsertBudget(budgetInput())
    await service.rotateWindow(budget.id, TENANT)
    expect(warn).toHaveBeenCalledWith(`failed to reset budget counter for ${budget.id}`)
  })
})

describe('BudgetService — a threshold is announced once per window', () => {
  it('does not announce a threshold again when spend is released below it and crosses it anew', async () => {
    // Scenario: 85 of 100 spent announces 0.8; a release drops spend to 45; spending 40 more crosses 0.8 again, silently.
    const { service, thresholds } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await service.consume(context(), delta(85n))
    await service.release(context(), delta(40n))
    await service.consume(context(), delta(40n))
    expect(thresholds.map((t) => t.threshold)).toEqual([0.8])
  })

  it('announces nothing for a threshold that spend had already reached before this instance saw it', async () => {
    // Scenario: another instance took spend to exactly 0.8; this instance (no memory of it) adds 10 and must not announce 0.8.
    const first = makeService()
    await first.service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await first.service.consume(context(), delta(80n))
    const { hooks, thresholds } = recordingHooks()
    const second = new BudgetService(first.store, new LedgerService(first.ledgerStore), { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true }, () => NOW, hooks)
    await second.consume(context(), delta(10n))
    expect(thresholds).toEqual([])
  })
})

describe('BudgetService — what releasing one of two attempts gives back', () => {
  it('keeps the movement while another attempt of the same key holds it', async () => {
    // Scenario: two attempts share one keyed movement; releasing one drops its reference and leaves the spend.
    const { service } = makeService()
    await service.upsertBudget(budgetInput())
    await service.consume(context(), delta(10n), NOW, 'k', 'first')
    await service.consume(context(), delta(10n), NOW, 'k', 'second')
    await service.release(context(), delta(10n), NOW, 'k', 'first')
    const [status] = await service.status(context().tenantId, context().scope)
    expect(status?.spent.nanoUsd).toBe(10n)
  })
})

describe('BudgetService — the counter and store trouble each warning names', () => {
  const COUNTER_KEY = (budgetId: string): string => `ai_tokens:budget:${budgetId}:2026-06-01T00:00:00.000Z:cost`
  const counterOf = (over: Record<string, unknown> = {}): never =>
    ({ incrIfBelow: jest.fn().mockResolvedValue(true), decr: jest.fn().mockResolvedValue(undefined), reset: jest.fn().mockResolvedValue(undefined), ...over }) as never

  it('names the counter key when an adjust cannot reach the counter', async () => {
    // Scenario: the counter rejects the increment of an adjust; the warning carries the key it could not move.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { service } = makeService({ options: { counter: counterOf({ incrIfBelow: jest.fn().mockRejectedValue(new Error('down')) }) } })
    const budget = await service.upsertBudget(budgetInput())
    await service.adjust(context(), delta(30n))
    expect(warn).toHaveBeenCalledWith(`failed to adjust budget counter ${COUNTER_KEY(budget.id)}`)
  })

  it('names the counter key when an overflowing increment forces a resync', async () => {
    // Scenario: the counter refuses an increment at its ceiling and is reseeded from the database; the warning says so.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const incrIfBelow = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const { service } = makeService({ options: { counter: counterOf({ incrIfBelow }) } })
    const budget = await service.upsertBudget(budgetInput())
    await service.adjust(context(), delta(30n))
    expect(warn).toHaveBeenCalledWith(`budget counter ${COUNTER_KEY(budget.id)} overflowed the int64 ceiling; resynced to the database window spend`)
  })

  it('names the budget when the counter is unavailable and the database takes over', async () => {
    // Scenario: the counter throws on a consume; the call falls back to the database and the warning names the budget.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { service } = makeService({ options: { counter: counterOf({ incrIfBelow: jest.fn().mockRejectedValue(new Error('down')) }) } })
    const budget = await service.upsertBudget(budgetInput())
    await service.consume(context(), delta(10n))
    expect(warn).toHaveBeenCalledWith(`budget counter unavailable for ${budget.id}; falling back to the database`)
  })

  it('names the budget when the store is unavailable and the call is allowed', async () => {
    // Scenario: failClosed is off and the store rejects; the call goes through and the warning names the budget.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { service, store } = makeService({ options: { failClosed: false, counter: counterOf() } })
    const budget = await service.upsertBudget(budgetInput())
    jest.spyOn(store, 'conditionalConsume').mockRejectedValue(new Error('db down'))
    await service.consume(context(), delta(10n))
    expect(warn).toHaveBeenCalledWith(`budget store unavailable for ${budget.id}; allowing (failClosed disabled)`)
  })

  it('names the counter key when a rollback decrement fails', async () => {
    // Scenario: a refused consume rolls back its counter increment and the decrement fails; the warning names the key.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { service, store } = makeService({ options: { counter: counterOf({ decr: jest.fn().mockRejectedValue(new Error('down')) }) } })
    const budget = await service.upsertBudget(budgetInput())
    jest.spyOn(store, 'conditionalConsume').mockResolvedValue(false)
    await service.consume(context(), delta(10n)).catch(() => undefined)
    expect(warn).toHaveBeenCalledWith(`failed to roll back budget counter ${COUNTER_KEY(budget.id)}`)
  })

  it('carries no details on a store failure that fails closed', async () => {
    // Scenario: the store rejects with failClosed on; the typed error exposes an empty details object, no stray keys.
    const { service, store } = makeService({ options: { counter: counterOf() } })
    await service.upsertBudget(budgetInput())
    jest.spyOn(store, 'conditionalConsume').mockRejectedValue(new Error('db down'))
    const error = (await service.consume(context(), delta(10n)).catch((e: unknown) => e)) as { getResponse(): { error: { details?: unknown } } }
    expect(error.getResponse().error.details ?? {}).toEqual({})
  })
})
