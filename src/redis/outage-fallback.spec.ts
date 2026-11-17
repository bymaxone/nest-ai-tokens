/**
 * @fileoverview The budget service keeps serving from the database while the Redis of its live counter is unreachable: the
 * counter store created from a URL fails a command with a timeout, as a stopped server makes the client do, and a metered
 * call is still counted in the database window and refused at the limit.
 * @layer redis
 */

import { makeService, budgetInput, context } from '../../test/fakes/budget-fixtures'
import { RedisBudgetCounterStore } from './index'

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class Stopped {
    eval(): Promise<never> {
      return Promise.reject(new Error('Command timed out'))
    }
    del(): Promise<never> {
      return Promise.reject(new Error('Command timed out'))
    }
  },
}))

describe('the budget service with a stopped Redis counter', () => {
  /** Invariant: the database window counts the call and enforces the limit while every counter command fails. */
  it('counts in the database and refuses at the limit while the counter times out', async () => {
    const counter = new RedisBudgetCounterStore('redis://127.0.0.1:1')
    const { service } = makeService({ options: { counter } })
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await expect(service.consume(context(), { nanoUsd: 60n, tokens: 0, count: 0 })).resolves.toBeUndefined()
    const [status] = await service.status('t1', { type: 'user', id: 'u1' })
    expect(status?.spent.nanoUsd).toBe(60n)
    await expect(service.consume(context(), { nanoUsd: 60n, tokens: 0, count: 0 })).rejects.toMatchObject({ response: { error: { code: 'AI_TOKENS_BUDGET_EXCEEDED' } } })
  })
})
