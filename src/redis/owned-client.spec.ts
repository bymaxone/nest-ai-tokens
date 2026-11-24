/**
 * @fileoverview Specs of the shutdown of the client a `RedisBudgetCounterStore` creates from a URL: the graceful quit, the
 * bounded fall-back to a disconnect, the clients it must leave alone, the refusal of calls after shutdown, and the
 * validation of the `closeTimeoutMs` bound, against a mocked `ioredis` and fake timers.
 * @layer redis
 */

import type { Redis } from 'ioredis'
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { RedisBudgetCounterStore } from './index'

/** A client with the surface the store uses at shutdown; `quitMode` decides how `quit()` behaves. */
class MockClient {
  status = 'ready'
  quits = 0
  disconnects = 0
  quitMode: 'ok' | 'hang' | 'fail' = 'ok'
  constructor(
    readonly url: string,
    readonly options?: Record<string, unknown>,
  ) {
    mockCreated.push(this)
  }
  eval(): Promise<number> {
    return Promise.resolve(1)
  }
  del(): Promise<number> {
    return Promise.resolve(1)
  }
  quit(): Promise<'OK'> {
    this.quits += 1
    if (this.quitMode === 'hang') return new Promise(() => undefined)
    if (this.quitMode === 'fail') return Promise.reject(new Error('quit failed'))
    this.status = 'end'
    return Promise.resolve('OK')
  }
  disconnect(): void {
    this.disconnects += 1
    this.status = 'end'
  }
}

/** The clients the mocked ioredis constructor created, in order. */
const mockCreated: MockClient[] = []

jest.mock('ioredis', () => ({ __esModule: true, default: function Owned(url: string, options?: Record<string, unknown>) { return new MockClient(url, options) } }))

beforeEach(() => {
  mockCreated.length = 0
})

describe('RedisBudgetCounterStore shutdown of the client it created', () => {
  /** A URL store owns the client it connected, so shutdown quits it gracefully and does not need to drop the connection. */
  it('quits the client it created from a URL', async () => {
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    await store.incrIfBelow('k', 1n, 10n, 60)
    await store.onModuleDestroy()
    expect(mockCreated).toHaveLength(1)
    expect(mockCreated[0]).toMatchObject({ quits: 1, disconnects: 0, status: 'end' })
  })

  /** The host owns a client it passed in: shutdown never quits or disconnects it. */
  it('never touches a client the host passed in', async () => {
    const host = new MockClient('host')
    const store = new RedisBudgetCounterStore(host as unknown as Redis)
    await store.incrIfBelow('k', 1n, 10n, 60)
    await store.onModuleDestroy()
    expect(host).toMatchObject({ quits: 0, disconnects: 0, status: 'ready' })
  })

  /** A client that has already ended is left alone: a second teardown would keep an ioredis timer alive. */
  it('does nothing for a client that has already ended', async () => {
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    await store.incrIfBelow('k', 1n, 10n, 60)
    const [client] = mockCreated
    if (client === undefined) throw new Error('no client')
    client.status = 'end'
    await store.onModuleDestroy()
    expect(client).toMatchObject({ quits: 0, disconnects: 0 })
  })

  /** A quit that does not finish within the bound is replaced by a disconnect, and no timer is left behind. */
  it('falls back to disconnect when the quit outlasts the bound, leaving no timer', async () => {
    jest.useFakeTimers()
    try {
      const store = new RedisBudgetCounterStore('redis://localhost:6379', { closeTimeoutMs: 500 })
      await store.incrIfBelow('k', 1n, 10n, 60)
      const [client] = mockCreated
      if (client === undefined) throw new Error('no client')
      client.quitMode = 'hang'
      const closing = store.onModuleDestroy()
      await jest.advanceTimersByTimeAsync(499)
      expect(client.disconnects).toBe(0)
      await jest.advanceTimersByTimeAsync(1)
      await closing
      expect(client).toMatchObject({ quits: 1, disconnects: 1, status: 'end' })
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  /** A quit that is late but whose client has ended meanwhile is not followed by a second teardown. */
  it('does not disconnect a client that ended while the quit was pending', async () => {
    jest.useFakeTimers()
    try {
      const store = new RedisBudgetCounterStore('redis://localhost:6379', { closeTimeoutMs: 500 })
      await store.incrIfBelow('k', 1n, 10n, 60)
      const [client] = mockCreated
      if (client === undefined) throw new Error('no client')
      client.quitMode = 'hang'
      const closing = store.onModuleDestroy()
      await jest.advanceTimersByTimeAsync(100)
      client.status = 'end'
      await jest.advanceTimersByTimeAsync(500)
      await closing
      expect(client.disconnects).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  /** A quit that finishes in time is not followed by a disconnect, whatever status the client reports afterwards. */
  it('does not disconnect after a quit that finished in time', async () => {
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    await store.incrIfBelow('k', 1n, 10n, 60)
    const [client] = mockCreated
    if (client === undefined) throw new Error('no client')
    client.quit = (): Promise<'OK'> => {
      client.quits += 1
      return Promise.resolve('OK')
    }
    await store.onModuleDestroy()
    expect(client).toMatchObject({ quits: 1, disconnects: 0, status: 'ready' })
  })

  /** A failed quit on a client that has ended is not followed by a disconnect. */
  it('does not disconnect when the quit fails on a client that has ended', async () => {
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    await store.incrIfBelow('k', 1n, 10n, 60)
    const [client] = mockCreated
    if (client === undefined) throw new Error('no client')
    client.quit = (): Promise<'OK'> => {
      client.quits += 1
      client.status = 'end'
      return Promise.reject(new Error('already closed'))
    }
    await store.onModuleDestroy()
    expect(client).toMatchObject({ quits: 1, disconnects: 0 })
  })

  /** A quit that fails is replaced by a disconnect too, and a quit that finished leaves no timer. */
  it('falls back to disconnect when the quit fails, and clears the bound when it succeeds', async () => {
    jest.useFakeTimers()
    try {
      const failing = new RedisBudgetCounterStore('redis://localhost:6379')
      await failing.incrIfBelow('k', 1n, 10n, 60)
      const [first] = mockCreated
      if (first === undefined) throw new Error('no client')
      first.quitMode = 'fail'
      await failing.onModuleDestroy()
      expect(first).toMatchObject({ quits: 1, disconnects: 1 })
      const ok = new RedisBudgetCounterStore('redis://localhost:6379')
      await ok.incrIfBelow('k', 1n, 10n, 60)
      await ok.onModuleDestroy()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  /** A second shutdown does nothing, and a later call fails closed instead of opening a new connection. */
  it('is safe to call twice and refuses to reconnect afterwards', async () => {
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    await store.incrIfBelow('k', 1n, 10n, 60)
    await store.onModuleDestroy()
    await store.onModuleDestroy()
    expect(mockCreated[0]?.quits).toBe(1)
    await expect(store.incrIfBelow('k', 1n, 10n, 60)).rejects.toThrow('counter store is closed')
    expect(mockCreated).toHaveLength(1)
  })

  /** A store that never connected has nothing to close, and stays closed. */
  it('closes nothing for a URL store that never connected, and does not connect later', async () => {
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    await store.onModuleDestroy()
    expect(mockCreated).toHaveLength(0)
    await expect(store.decr('k', 1n)).rejects.toThrow('counter store is closed')
    expect(mockCreated).toHaveLength(0)
  })

  /** A connection that failed to open leaves nothing to close. */
  it('ignores a connection that failed to open', async () => {
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    const failing = jest.spyOn(store as unknown as { connect: () => Promise<Redis> }, 'connect').mockRejectedValue(new Error('import failed'))
    await expect(store.reset('k')).rejects.toThrow('import failed')
    await expect(store.onModuleDestroy()).resolves.toBeUndefined()
    failing.mockRestore()
  })
})

describe('RedisBudgetCounterStore closeTimeoutMs', () => {
  /** A bound a timer cannot honour (not a whole number, below 1, or above 2^31-1) is refused at construction, naming the option. */
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1, 2 ** 31, '2000' as unknown as number])('refuses %p', (value) => {
    const build = (): RedisBudgetCounterStore => new RedisBudgetCounterStore('redis://localhost:6379', { closeTimeoutMs: value })
    expect(build).toThrow(AiTokensException)
    let thrown: unknown
    try {
      build()
    } catch (error) {
      thrown = error
    }
    const body = (thrown as AiTokensException).getResponse() as { error: { code: string; details: { reason: string } } }
    expect(body.error.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(body.error.details.reason).toContain('closeTimeoutMs')
  })

  /** The reason names the option and the bound, and never repeats the value the host gave. */
  it.each(['closeTimeoutMs', 'commandTimeoutMs'] as const)('keeps the value of %s out of the reason', (option) => {
    const marker = 'private-host-10.0.0.5-s3cr3t'
    let thrown: unknown
    try {
      new RedisBudgetCounterStore('redis://localhost:6379', { [option]: marker })
    } catch (error) {
      thrown = error
    }
    const body = JSON.stringify((thrown as AiTokensException).getResponse())
    expect(body).toContain(option)
    expect(body).not.toContain(marker)
    expect(body).not.toMatch(/received/i)
  })

  /** The smallest, a usual and the largest bound a timer honours are accepted, and so is leaving it out. */
  it.each([1, 2_000, 2 ** 31 - 1, undefined])('accepts %p', (value) => {
    expect(() => new RedisBudgetCounterStore('redis://localhost:6379', value === undefined ? {} : { closeTimeoutMs: value })).not.toThrow()
  })
})

describe('RedisBudgetCounterStore client it creates', () => {
  /** The client is built with one retry per command, the offline queue on, and the default command timeout, so a stopped Redis answers in about the timeout. */
  it('creates the client with one retry, the offline queue and the default command timeout', async () => {
    await new RedisBudgetCounterStore('redis://localhost:6379').incrIfBelow('k', 1n, 10n, 60)
    expect(mockCreated[0]?.options).toEqual({ maxRetriesPerRequest: 1, enableOfflineQueue: true, commandTimeout: 500 })
  })

  /** The command timeout is the one the host chose. */
  it('creates the client with the command timeout of the options', async () => {
    await new RedisBudgetCounterStore('redis://localhost:6379', { commandTimeoutMs: 1_234 }).incrIfBelow('k', 1n, 10n, 60)
    expect(mockCreated[0]?.options).toMatchObject({ commandTimeout: 1_234 })
  })
})

describe('RedisBudgetCounterStore commandTimeoutMs', () => {
  /** A bound a timer cannot honour is refused at construction, naming the option. */
  it.each([Number.NaN, 1.5, 0, -1, 2 ** 31, '500' as unknown as number])('refuses %p', (value) => {
    let thrown: unknown
    try {
      new RedisBudgetCounterStore('redis://localhost:6379', { commandTimeoutMs: value })
    } catch (error) {
      thrown = error
    }
    const body = (thrown as AiTokensException).getResponse() as { error: { code: string; details: { reason: string } } }
    expect(body.error.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(body.error.details.reason).toContain('commandTimeoutMs')
  })
})

describe('RedisBudgetCounterStore refusals while it connects and while it waits for a command', () => {
  /** A command of a client the host owns answers with a subclass of Promise: the reply is waited for. */
  it('waits for the reply of a command that is a promise subclass', async () => {
    class SdkPromise<T> extends Promise<T> {}
    const client = { status: 'ready', eval: (): Promise<number> => SdkPromise.resolve(1) }
    const store = new RedisBudgetCounterStore(client as never)
    await expect(store.incrIfBelow('k', 10n, 5n, 60)).resolves.toBe(true)
  })

  /** A host that holds an accessor for `constructor` on Promise.prototype while the store asks for its client answers for the wait: the store refuses. */
  it('refuses a call made while Promise.prototype.constructor is an accessor', async () => {
    const kept = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor')!
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    let call: Promise<boolean>
    Reflect.defineProperty(Promise.prototype, 'constructor', { configurable: true, get: () => Object })
    try {
      call = store.incrIfBelow('k', 1n, 10n, 60)
    } finally {
      Reflect.defineProperty(Promise.prototype, 'constructor', kept)
    }
    await expect(call).rejects.toMatchObject({ response: { error: { code: 'AI_TOKENS_INVALID_CONFIG' } } })
    await store.onModuleDestroy()
  })

  /**
   * A store closed while the client library is still loading opens no client, quits nothing, and leaves no rejection nobody handles; the
   * call that started the connection fails closed, and closing again stays safe.
   */
  it('opens no client when it is closed while the client library loads, and says the store is closed', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const store = new RedisBudgetCounterStore('redis://localhost:6379')
      const call = store.incrIfBelow('k', 1n, 10n, 60)
      const closing = store.onModuleDestroy()
      await expect(call).rejects.toThrow('counter store is closed')
      await closing
      await store.onModuleDestroy()
      await new Promise<void>((done) => setImmediate(done))
      expect(mockCreated).toHaveLength(0)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
