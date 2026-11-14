/**
 * @fileoverview E2E: the library closes the Redis client it creates and leaves a host-passed client alone, through the
 * module's own shutdown on a real Redis. A store configured with a URL owns its connection, so closing the application
 * releases the socket and lets the process exit; a store given a client never closes it.
 * @layer test
 */

import { RedisBudgetCounterStore } from '@bymax-one/nest-ai-tokens/redis'
import { bootMeteringModule, startPostgres, startRedis, upsertBudget, e2eContext, type PostgresFixture, type RedisFixture } from './harness'

let pg: PostgresFixture
let redis: RedisFixture
beforeAll(async () => {
  pg = await startPostgres()
  redis = await startRedis()
}, 240_000)
afterAll(async () => {
  await redis.stop()
  await pg.stop()
})

/** How many connections the Redis server holds open, asked over the host's own client. */
async function serverConnections(): Promise<number> {
  const list = (await redis.client.client('LIST')) as string
  return list.split('\n').filter((line) => line.trim() !== '').length
}

/** The connection URL of the Redis container. */
const url = (): string => `redis://${redis.container.getHost()}:${redis.container.getMappedPort(6379)}`

describe('who closes the Redis client', () => {
  /**
   * The store created the client from the URL, so closing the application quits it: its connection is released (the server's
   * connection count returns to what it was before the first counter call) and the process has nothing left of it to wait for.
   */
  it('releases the socket of a client the store created when the application closes', async () => {
    const before = await serverConnections()
    const booted = await bootMeteringModule({ store: pg.store, counter: new RedisBudgetCounterStore(url()) })
    await upsertBudget(booted.budgets, { id: 'owned', scope: { type: 'user', id: 'u1' }, limitNanoUsd: 1_000_000_000n })
    await booted.budgets.consume(e2eContext(), { nanoUsd: 1n, tokens: 0, count: 1 }).catch(() => undefined)
    expect(await serverConnections()).toBeGreaterThan(before)
    await booted.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await serverConnections()).toBe(before)
  })

  /** The host owns a client it passed in: closing the application leaves it connected and usable. */
  it('leaves a client the host passed in connected', async () => {
    const booted = await bootMeteringModule({ store: pg.store, counter: redis.counter })
    await booted.close()
    expect(redis.client.status).toBe('ready')
    await expect(redis.client.ping()).resolves.toBe('PONG')
  })
})
