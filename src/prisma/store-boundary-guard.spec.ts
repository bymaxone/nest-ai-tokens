/**
 * @fileoverview The guard of the store's boundary on a plain object: what it leaves alone (a property that is not a function, the
 * constructor, a result that is not a promise), what it types (a rejection, a throw before the first await, a thenable that is not a
 * promise), and what it lets through unchanged (the signals the store raises on purpose and a typed error).
 * @layer prisma
 */

import { AiTokensException } from '../server/errors'
import { guardStoreErrors } from './store-boundary'

class Sample {
  readonly field = 5
  get inherited(): number {
    return this.field + 1
  }
  fine(): string {
    return 'ok'
  }
  plain(): { kept: true } {
    return PLAIN
  }
  nothing(): null {
    return null
  }
  nothingAtAll(): undefined {
    return undefined
  }
  callable(): (() => string) & { then: () => void } {
    return Object.assign(() => 'called', { then: () => undefined })
  }
  fakeThen(): { then: number } {
    return { then: 1 }
  }
  thenable(): PromiseLike<never> {
    return { then: (onFulfilled, onRejected) => Promise.reject(new Error('driver down')).then(onFulfilled, onRejected) }
  }
  lazy(): PromiseLike<string> {
    return { then: (onFulfilled) => Promise.resolve('ran').then(onFulfilled) }
  }
  async rejects(): Promise<never> {
    throw Object.assign(new Error('driver down'), { code: 'P2010' })
  }
  throwsNow(): never {
    throw Object.assign(new Error('driver down'), { code: 'P2010' })
  }
  async signal(): Promise<never> {
    throw new SignalError()
  }
  signalNow(): never {
    throw new SignalError()
  }
  async typed(): Promise<never> {
    throw new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT')
  }
}

class SignalError extends Error {}
const PLAIN = { kept: true } as const
const guarded = (): Sample => guardStoreErrors(new Sample(), (error) => error instanceof SignalError)

/** Whether a thrown or rejected value is the typed store error, with the original failure on its cause. */
async function typedFailure(run: () => unknown): Promise<AiTokensException> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AiTokensException) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

describe('guardStoreErrors', () => {
  /** What is not a method is returned as it is, so the store keeps its fields and its class. */
  it('returns a field, the constructor and a result that is not a promise unchanged', () => {
    const store = guarded()
    expect(store.field).toBe(5)
    expect(store.inherited).toBe(6)
    expect(store.constructor).toBe(Sample)
    expect(store.fine()).toBe('ok')
    expect(store.plain()).toBe(PLAIN)
    expect(store.nothing()).toBeNull()
    expect(store.nothingAtAll()).toBeUndefined()
    expect(store.callable()()).toBe('called')
    expect(store.fakeThen()).toEqual({ then: 1 })
  })

  /** A rejection and a throw before the first await become the typed error, with the driver's failure on its cause. */
  it.each([['rejects'], ['throwsNow']] as const)('types the failure of %s and keeps it on the cause', async (method) => {
    const error = await typedFailure(() => guarded()[method]())
    expect(error.getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR' } })
    expect((error.cause as Error).message).toBe('driver down')
  })

  /** A thenable that is no native promise is refused before its `then` runs, and the refusal is the typed error. */
  it('types the refusal of a thenable that is not a native promise', async () => {
    const error = await typedFailure(() => guarded().thenable())
    expect(error.getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR' } })
  })

  /** A thenable that answers is waited for, and what it resolved with is what the method returns. */
  it('waits for a thenable that resolves', async () => {
    await expect(guarded().lazy()).resolves.toBe('ran')
  })

  /** A throw before the first await is thrown at the call, not turned into a rejected promise. */
  it('throws a failure before the first await at the call', () => {
    expect(() => guarded().throwsNow()).toThrow(AiTokensException)
  })

  /** The signals and a typed error cross unchanged, whether they are thrown or rejected. */
  it('passes a signal and a typed error through unchanged', async () => {
    await expect(guarded().signal()).rejects.toBeInstanceOf(SignalError)
    expect(() => guarded().signalNow()).toThrow(SignalError)
    await expect(guarded().typed()).rejects.toBeInstanceOf(AiTokensException)
    expect((await typedFailure(() => guarded().typed())).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_IDEMPOTENCY_CONFLICT' } })
  })

  /**
   * A host replaces a method of the store to inject a fault, as `jest.spyOn` does: the replacement is installed on the object and read
   * back from it. What is read back is the replacement itself, with its own members, and what the replacement throws is its own;
   * the methods nobody replaced stay guarded, and so does the original once the replacement is restored.
   */
  it('hands back a replaced method as it is and keeps the others guarded', async () => {
    const store = guarded()
    const spy = jest.spyOn(store, 'fine').mockReturnValueOnce('replaced')
    expect(store.fine).toBe(spy)
    expect(store.fine()).toBe('replaced')
    expect(store.fine()).toBe('ok')
    spy.mockRestore()
    await expect(store.rejects()).rejects.toBeInstanceOf(AiTokensException)
    const failing = jest.spyOn(store, 'plain').mockImplementationOnce(() => {
      throw new Error('injected')
    })
    expect(() => store.plain()).toThrow('injected')
    failing.mockRestore()
    expect(store.plain()).toBe(PLAIN)
  })
})
