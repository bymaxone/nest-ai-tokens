/**
 * @fileoverview The shutdown of a client the store created waits for the connection with a native `await`. A chain on the connection
 * promise returns a promise built by `Promise[Symbol.species]`, read live, so a host that plants it decides which client is closed, or
 * that none is: the client is then left connected and the process cannot exit.
 * @layer redis
 */

import { RedisBudgetCounterStore } from './index'

/** The clients the mocked ioredis constructor created. */
const created: { status: string; quits: number; disconnects: number }[] = []

jest.mock('ioredis', () => ({
  __esModule: true,
  default: function Owned(): unknown {
    const client = {
      status: 'ready',
      quits: 0,
      disconnects: 0,
      eval: (): Promise<number> => Promise.resolve(1),
      quit: (): Promise<'OK'> => {
        client.quits += 1
        client.status = 'end'
        return Promise.resolve('OK')
      },
      disconnect: (): void => {
        client.disconnects += 1
        client.status = 'end'
      },
    }
    created.push(client)
    return client
  },
}))

describe('the shutdown of the client a URL store created', () => {
  it('quits the client it connected when a planted species answers the wait for the connection', async () => {
    const store = new RedisBudgetCounterStore('redis://localhost:6379')
    await store.incrIfBelow('k', 1n, 10n, 60)
    const ended = Promise.resolve({ status: 'end' })
    const forged = function Forged(executor: (resolve: () => void, reject: () => void) => void): Promise<unknown> {
      executor(() => undefined, () => undefined)
      return ended
    }
    Object.defineProperty(Promise, Symbol.species, { configurable: true, get: () => forged })
    let closing: Promise<void>
    try {
      closing = store.onModuleDestroy()
    } finally {
      Reflect.deleteProperty(Promise, Symbol.species)
    }
    await closing
    expect(created[0]?.quits).toBe(1)
  })
})
