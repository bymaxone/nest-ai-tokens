/**
 * @fileoverview The reason each refusal of `validateOptions` carries.
 * @layer test
 */

import { makeFullStore } from '../../../test/fakes/full-store'
import { AiTokensException } from '../errors'
import { validateOptions } from './validate-options'

/** The `details.reason` the typed refusal of `options` carries. */
function reasonOf(options: Record<string, unknown>): string {
  try {
    validateOptions(options as never)
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    return (error.getResponse() as { error: { details: { reason: string } } }).error.details.reason
  }
  throw new Error('accepted')
}

/** A store with the first method of a port removed. */
function storeWithout(method: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries({ ...makeFullStore() }).filter(([name]) => name !== method))
}

describe('the reason of a refused configuration names what is missing', () => {
  it('names options.store when the store is left out', () => {
    // Scenario: a host forgets the store; the public reason says which option to set.
    expect(reasonOf({})).toBe('options.store is required')
  })

  it('names the ledger method a store lacks', () => {
    // Scenario: a store without `append` is refused with that method named.
    expect(reasonOf({ store: storeWithout('append') })).toBe('store is missing the required ledger method "append"')
  })

  it('names the pricing method a store lacks', () => {
    // Scenario: a store without `resolveRate` is refused with that method named.
    expect(reasonOf({ store: storeWithout('resolveRate') })).toBe(
      'store is missing the required pricing method "resolveRate"'
    )
  })

  it('names the wallet method a store lacks when wallets are enabled', () => {
    // Scenario: wallets are on, the store has no wallet port, and the reason names that method.
    const reason = reasonOf({ store: storeWithout('getWallet'), wallets: {} })
    expect(reason).toBe('wallets enabled but store is missing "getWallet"')
  })

  it('names the budget method a store lacks when budgets are enabled', () => {
    // Scenario: budgets are on, the store has no budget port, and the reason names that method.
    const reason = reasonOf({ store: storeWithout('upsert'), budgets: {} })
    expect(reason).toBe('budgets enabled but store is missing "upsert"')
  })

  it('names the missing resolve() of a markup policy', () => {
    // Scenario: a markup object without resolve() is refused with that method named.
    expect(reasonOf({ store: makeFullStore(), markup: {} })).toBe('markup policy must implement a resolve() method')
  })
})

describe('the reason of a refused option value says what it must be', () => {
  it.each([
    [{ markup: 0 }, 'markup must be a finite number greater than 0'],
    [{ budgets: null }, 'budgets must be an object, or left out'],
    [{ ledger: { hashChain: 'false' } }, 'ledger.hashChain must be true or false'],
    [{ scopeResolver: 'user' }, 'scopeResolver must be a function'],
    [{ holds: [] }, 'holds must be an object'],
    [{ pricing: { strict: 'false' } }, 'pricing.strict must be true or false'],
    [{ budgets: { defaultPolicy: 'blok' } }, 'budgets.defaultPolicy must be one of block, throttle or allow'],
    [{ ratingMode: 'table' }, 'ratingMode must be one of rate-table or provider-reported'],
    [{ budgets: { alertThresholds: 0.8 } }, 'budget alert thresholds must be a list of numbers within (0, 1]'],
    [{ budgets: { alertThresholds: [2] } }, 'budget alert thresholds must be numbers within (0, 1]'],
    [{ holds: { ttlSeconds: 0 } }, 'holds.ttlSeconds must be an integer from 1 to 2147483647'],
    [{ settlement: { retentionSeconds: 1 } }, 'settlement.retentionSeconds must exceed settlement.graceSeconds and holds.ttlSeconds'],
    [{ pricing: { cacheTtlMs: 0 } }, 'pricing.cacheTtlMs must be a positive integer number of milliseconds'],
    [{ wallets: { creditRateNanoUsd: 0n } }, 'wallets.creditRateNanoUsd must be a bigint from 1 to 9223372036854775807'],
    [{ wallets: { overdraftNanoUsd: -1n } }, 'wallets.overdraftNanoUsd must be a bigint from 0 to 9223372036854775807'],
  ])('for %p', (options, reason) => {
    // Scenario: a host reads which option was refused and the values it takes.
    expect(reasonOf({ store: makeFullStore(), ...options })).toBe(reason)
  })
})
