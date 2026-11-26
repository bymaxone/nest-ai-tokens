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
