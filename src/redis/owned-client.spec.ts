import type { Redis } from 'ioredis'
import { RedisBudgetCounterStore } from './index'

/** A client with the surface the store uses at shutdown; `quitMode` decides how `quit()` behaves. */
class MockClient {
  status = 'ready'
  quits = 0
  disconnects = 0
  quitMode: 'ok' | 'hang' | 'fail' = 'ok'
  constructor(readonly url: string) {
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

jest.mock('ioredis', () => ({ __esModule: true, default: class Owned { constructor(url: string) { return new MockClient(url) } } }))

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
