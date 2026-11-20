/**
 * @fileoverview The kind of value the options take. `scopeResolver` and `fx` are functions, every group (`pricing`, `wallets`, `budgets`, `holds`,
 * `settlement`, `ledger`, `events`, `telemetry`, `reporting`, `content`) is an object, and each switch is a boolean, `ledger.hashChain` among them: the flag is read as truthy, so the string `'false'` would switch the chain on, and a
 * string where a group belongs would leave every option of the group at its default with no word said. Each is refused at startup with the typed invalid-configuration error that names the option and never repeats the
 * value, and each documented value is still accepted.
 * @layer server
 */

import { makeFullStore } from '../test/fakes/full-store'
import { validateOptions } from './server/config'
import { AiTokensException } from './server/errors'

/** A string no option takes as a value, to show a refusal never repeats what it was given. */
const MARKER = 'not-an-option-9876543'

/** The reason the typed refusal of `options` gives, or `undefined` when they are accepted. */
function refusalOf(options: object): string | undefined {
  try {
    validateOptions({ store: makeFullStore(), ...options })
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    const body = JSON.stringify(error.getResponse())
    expect(body).toContain('AI_TOKENS_INVALID_CONFIG')
    expect(body).not.toContain(MARKER)
    return (error.getResponse() as { error: { details: { reason: string } } }).error.details.reason
  }
  return undefined
}

describe('an option that is a function', () => {
  it.each(['scopeResolver', 'fx'])('refuses %s that is not one, naming it', (name) => {
    for (const value of [MARKER, 5, true, {}, [], 5n, Symbol(MARKER)]) {
      expect(refusalOf({ [name]: value })).toBe(`${name} must be a function`)
    }
  })

  it.each(['scopeResolver', 'fx'])('accepts %s as a function, and takes none as the default', (name) => {
    expect(refusalOf({ [name]: () => undefined })).toBeUndefined()
    expect(refusalOf({ [name]: undefined })).toBeUndefined()
    expect(refusalOf({ [name]: null })).toBeUndefined()
  })
})

const GROUPS = ['pricing', 'wallets', 'budgets', 'holds', 'settlement', 'ledger', 'events', 'telemetry', 'reporting', 'content']

describe('an option that is a group of options', () => {
  it.each(GROUPS)('refuses %s that is not an object, naming it', (name) => {
    for (const value of [MARKER, 5, true, [], 5n, () => undefined]) {
      expect(refusalOf({ [name]: value })).toBe(`${name} must be an object`)
    }
  })

  it.each(GROUPS)('accepts %s as an object, and takes none as the default', (name) => {
    expect(refusalOf({ [name]: {} })).toBeUndefined()
    expect(refusalOf({ [name]: undefined })).toBeUndefined()
  })

  /** `null` for holds is the default, as for any option; for wallets it is refused, because a failed load must not leave the wallet feature off. */
  it('takes holds set to null as the default, and refuses wallets set to null', () => {
    expect(refusalOf({ holds: null })).toBeUndefined()
    expect(refusalOf({ wallets: null })).toBe('wallets must be an object, or left out')
  })
})

describe('the hash chain flag of the ledger', () => {
  it('refuses a value that is not a boolean, which a string `false` is', () => {
    for (const value of ['false', 'true', MARKER, 0, 1, {}, [], null]) {
      expect(refusalOf({ ledger: { hashChain: value } })).toBe('ledger.hashChain must be true or false')
    }
  })

  it('accepts true, false and none', () => {
    expect(refusalOf({ ledger: { hashChain: true } })).toBeUndefined()
    expect(refusalOf({ ledger: { hashChain: false } })).toBeUndefined()
    expect(refusalOf({ ledger: {} })).toBeUndefined()
  })
})

describe('a switch inside a group', () => {
  const SWITCHES = [['pricing', 'seedFromSnapshot'], ['pricing', 'strict'], ['budgets', 'failClosed'], ['settlement', 'enabled'], ['events', 'emitter'], ['telemetry', 'metrics']]

  it.each(SWITCHES)('refuses %s.%s that is not a boolean, naming it', (group, name) => {
    for (const value of ['false', MARKER, 0, 1, {}, [], 5n, () => undefined]) {
      expect(refusalOf({ [group]: { [name]: value } })).toBe(`${group}.${name} must be true or false`)
    }
  })

  it.each(SWITCHES)('accepts %s.%s as true, false and none, and null takes the default', (group, name) => {
    for (const value of [true, false, undefined, null]) expect(refusalOf({ [group]: { [name]: value } })).toBeUndefined()
  })
})
