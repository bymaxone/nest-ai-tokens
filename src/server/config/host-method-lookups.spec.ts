/**
 * A method of a host object is one the host's object or its class defines. A key planted on `Object.prototype` is not a method: it must
 * not let a store with no `append` or a markup policy with no `resolve` pass validation, and it must not be called on a sink that has no such
 * method. A method of the host's class still counts.
 * @layer server
 */
import { Logger } from '@nestjs/common'
import type { BymaxAiTokensModuleOptions, IAiTokensStore } from '../interfaces'
import { absorbHostMethod } from '../utils/absorb-host-call'
import { validateOptions } from './validate-options'
import { makeFullStore } from '../../../test/fakes/full-store'

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it, whatever `run` does. */
function planted<T>(key: string, value: unknown, run: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

const scopeResolver = (): never => undefined as never

/** The store without the method `name`. */
function storeWithout(name: string): IAiTokensStore {
  const copy: Record<string, unknown> = { ...makeFullStore() }
  Reflect.deleteProperty(copy, name)
  return copy as unknown as IAiTokensStore
}

describe('the methods a host object is validated for', () => {
  it.each(['append', 'resolveRate'])('refuses a store with no %s although a function of that name is planted on Object.prototype', (name) => {
    const options = { store: storeWithout(name), scopeResolver } as BymaxAiTokensModuleOptions
    expect(() => planted(name, () => Promise.resolve(), () => validateOptions(options))).toThrow()
  })

  it('refuses a markup policy with no resolve although resolve is planted on Object.prototype', () => {
    const options = { store: makeFullStore(), scopeResolver, markup: {} } as unknown as BymaxAiTokensModuleOptions
    expect(() => planted('resolve', () => 1, () => validateOptions(options))).toThrow()
  })

  /** A method the host's class defines still counts. */
  it('accepts a store whose methods a class defines', () => {
    class Store {}
    for (const [name, fn] of Object.entries(makeFullStore())) Object.defineProperty(Store.prototype, name, { value: fn })
    expect(() => validateOptions({ store: new Store() as unknown as IAiTokensStore, scopeResolver })).not.toThrow()
  })
})

describe('the method of a host sink that is called', () => {
  const logger = new Logger('probe')

  it('does not call a function planted on Object.prototype on a sink that has no such method, optional or not', () => {
    const planting = jest.fn()
    const sink = {}
    planted('recordUsage', planting, () => {
      absorbHostMethod(logger, 'k', sink, 'recordUsage', [], true)
      absorbHostMethod(logger, 'k', sink, 'recordUsage', [])
    })
    expect(planting).not.toHaveBeenCalled()
  })

  it('calls a method that the class of the sink defines, and one it has as its own', () => {
    const calls: string[] = []
    class Sink {
      recordUsage(): void {
        calls.push('class')
      }
    }
    absorbHostMethod(logger, 'k', new Sink(), 'recordUsage', [])
    absorbHostMethod(logger, 'k', { recordUsage: () => calls.push('own') }, 'recordUsage', [])
    expect(calls).toEqual(['class', 'own'])
  })
})
