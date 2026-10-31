import 'reflect-metadata'
import { inspect } from 'node:util'
import { AiTokensException } from './errors'
import { disabledService, liveService } from './disabled-service'

class Thing {
  ping(): string {
    return 'pong'
  }
}

describe('disabledService', () => {
  /** A method the class defines throws the config error naming the missing block. */
  it('throws AI_TOKENS_INVALID_CONFIG from a defined method', () => {
    const stub = disabledService(Thing, 'wallets')
    expect(() => stub.ping()).toThrow(AiTokensException)
    try {
      stub.ping()
    } catch (error) {
      expect((error as AiTokensException).getResponse()).toMatchObject({
        error: { code: 'AI_TOKENS_INVALID_CONFIG', details: { reason: 'wallets not configured: set options.wallets to enable Thing' } },
      })
    }
  })

  /** The stand-in is an instance of the service, so `constructor` and `instanceof` are the real ones. */
  it('has the service as its constructor and prototype', () => {
    const stub = disabledService(Thing, 'budgets')
    expect(stub.constructor).toBe(Thing)
    expect(stub).toBeInstanceOf(Thing)
  })

  /** Discovery libraries read metadata off `instance.constructor` for every provider; that must not throw. */
  it('lets Reflect read metadata from its constructor', () => {
    const stub = disabledService(Thing, 'budgets')
    expect(() => {
      Reflect.getOwnMetadata('any-key', stub.constructor)
    }).not.toThrow()
  })

  /** Copying or spreading the stand-in carries no property, so neither the methods nor the marker leak. */
  it('has no enumerable own property, string or symbol', () => {
    const stub = disabledService(Thing, 'wallets')
    const copy = Object.assign({}, stub)
    expect(Object.keys(stub)).toEqual([])
    expect(Object.keys(copy)).toEqual([])
    expect(Object.getOwnPropertySymbols(copy)).toEqual([])
  })

  /** Nothing the host probes a provider for runs the throwing methods or reads as present. */
  it('reads undefined for lifecycle hooks, then, toJSON and iterators', () => {
    const stub = disabledService(Thing, 'budgets') as unknown as {
      onModuleInit?: unknown
      onApplicationBootstrap?: unknown
      onModuleDestroy?: unknown
      then?: unknown
      toJSON?: unknown
      [Symbol.iterator]?: unknown
    }
    expect(stub.onModuleInit).toBeUndefined()
    expect(stub.onApplicationBootstrap).toBeUndefined()
    expect(stub.onModuleDestroy).toBeUndefined()
    expect(stub.then).toBeUndefined()
    expect(stub.toJSON).toBeUndefined()
    expect(stub[Symbol.iterator]).toBeUndefined()
  })

  /** Printing, serializing and awaiting it behave as for any plain provider. */
  it('stringifies, serializes, inspects and awaits without throwing', async () => {
    const stub = disabledService(Thing, 'wallets')
    expect(() => Object.prototype.toString.call(stub)).not.toThrow()
    expect(JSON.stringify(stub)).toBe('{}')
    expect(() => inspect(stub)).not.toThrow()
    await expect(Promise.resolve(stub)).resolves.toBe(stub)
  })
})

describe('liveService', () => {
  /** A real service passes through; a stand-in or an absent value becomes null. */
  it('passes a real service and nulls a stand-in or an absent one', () => {
    const real = new Thing()
    expect(liveService(real)).toBe(real)
    expect(liveService(disabledService(Thing, 'wallets'))).toBeNull()
    expect(liveService(null)).toBeNull()
    expect(liveService(undefined)).toBeNull()
  })
})
