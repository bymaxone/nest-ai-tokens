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

  /** Properties the class does not define read as undefined, so lifecycle and promise checks skip it. */
  it('reads undefined for anything the class does not define', () => {
    const stub = disabledService(Thing, 'budgets') as unknown as {
      onModuleInit?: unknown
      then?: unknown
      constructor?: unknown
      [Symbol.toPrimitive]?: unknown
    }
    expect(stub.onModuleInit).toBeUndefined()
    expect(stub.then).toBeUndefined()
    expect(stub.constructor).toBeUndefined()
    expect(stub[Symbol.toPrimitive]).toBeUndefined()
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
