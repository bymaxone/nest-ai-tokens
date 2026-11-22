/**
 * @fileoverview The descriptors the library hands to `Object.defineProperty` have no prototype, so a `get`, a `set`, a `value` or a flag that
 * another library put on `Object.prototype` is not part of any property the library defines: the stand-in of a disabled service, the cause of
 * an exception and the snapshot of an estimate are still built.
 * @layer server
 */

import { disabledService, liveService } from '../disabled-service'
import { AiTokensException } from '../errors'
import { attachCause } from '../errors/attach-cause'
import { readHoldEstimate } from './date-guards'
import { newVisit } from './argument-guards'
import { descriptor } from './descriptor'
import { setRealmGuard } from './prototype-guard'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

class Service {
  method(): number {
    return 1
  }
}

/** Plant `key` as a getter or a value on `Object.prototype`, run `run`, remove it. */
function planted<T>(key: string, run: () => T): T {
  const accessor = key === 'get' || key === 'set'
  Object.defineProperty(Object.prototype, key, accessor ? { value: (): number => 1, configurable: true, writable: true } : { value: true, configurable: true, writable: true })
  try {
    return run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('descriptor', () => {
  it('has no prototype and holds what it was given', () => {
    const made = descriptor({ value: 1, enumerable: false })
    expect(Object.getPrototypeOf(made)).toBeNull()
    expect(made.value).toBe(1)
  })

  it.each(['get', 'set', 'value', 'writable', 'enumerable', 'configurable'])('defines a property when %s is planted on Object.prototype', (key) => {
    const target = {}
    planted(key, () => Object.defineProperty(target, 'name', descriptor({ value: 5, enumerable: false })))
    expect(Object.getOwnPropertyDescriptor(target, 'name')).toEqual({ value: 5, writable: false, enumerable: false, configurable: false })
  })
})

describe('the definitions of the library beneath a planted get or set', () => {
  it.each(['get', 'set', 'value', 'writable'])('builds the stand-in of a disabled service, the cause of an exception and the snapshot of an estimate when %s is planted', (key) => {
    const standIn = planted(key, () => disabledService(Service, 'wallets'))
    expect(liveService(standIn)).toBeNull()
    expect(() => standIn.method()).toThrow(AiTokensException)
    const error = planted(key, () => attachCause(new Error('boom'), new Error('root')))
    expect((error.cause as Error).message).toBe('root')
    const estimate = planted(key, () => readHoldEstimate({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1, maxOutputTokens: 1 }, newVisit()))
    expect((estimate as { provider: string }).provider).toBe('openai')
  })
})
