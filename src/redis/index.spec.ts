import type { Redis } from 'ioredis'
import { RedisBudgetCounterStore } from './index'

/** A minimal in-memory Redis that interprets the two shipped Lua scripts. */
class FakeRedis {
  readonly values = new Map<string, bigint>()
  readonly ttls = new Map<string, number>()
  readonly deleted: string[] = []

  eval(script: string, _numKeys: number, key: string, ...args: string[]): Promise<number> {
    if (script.includes('PEXPIRE')) {
      const [amount, limit, ttl] = args as [string, string, string]
      const next = (this.values.get(key) ?? 0n) + BigInt(amount)
      if (next > BigInt(limit)) return Promise.resolve(0)
      this.values.set(key, next)
      this.ttls.set(key, Number(ttl))
      return Promise.resolve(1)
    }
    const [amount] = args as [string]
    const next = (this.values.get(key) ?? 0n) - BigInt(amount)
    this.values.set(key, next < 0n ? 0n : next)
    return Promise.resolve(1)
  }

  del(key: string): Promise<number> {
    this.deleted.push(key)
    this.values.delete(key)
    return Promise.resolve(1)
  }
}

/** Cast a FakeRedis to the ioredis surface the store consumes. */
function asRedis(fake: FakeRedis): Redis {
  return fake as unknown as Redis
}

describe('RedisBudgetCounterStore', () => {
  /** incrIfBelow accepts within-limit increments, sets the TTL, and rejects over-limit ones. */
  it('increments within the limit and rejects beyond it', async () => {
    const redis = new FakeRedis()
    const store = new RedisBudgetCounterStore(asRedis(redis))
    expect(await store.incrIfBelow('k', 60n, 100n, 3600)).toBe(true)
    expect(redis.values.get('k')).toBe(60n)
    expect(redis.ttls.get('k')).toBe(3_600_000) // seconds → ms
    expect(await store.incrIfBelow('k', 60n, 100n, 3600)).toBe(false) // 120 > 100
    expect(redis.values.get('k')).toBe(60n) // unchanged
  })

  /** A consume exactly at the limit is accepted. */
  it('accepts an increment to exactly the limit', async () => {
    const redis = new FakeRedis()
    const store = new RedisBudgetCounterStore(asRedis(redis))
    expect(await store.incrIfBelow('k', 100n, 100n, 60)).toBe(true)
  })

  /** decr subtracts and floors the stored value at zero. */
  it('decrements with a zero floor', async () => {
    const redis = new FakeRedis()
    const store = new RedisBudgetCounterStore(asRedis(redis))
    await store.incrIfBelow('k', 50n, 100n, 60)
    await store.decr('k', 30n)
    expect(redis.values.get('k')).toBe(20n)
    await store.decr('k', 100n)
    expect(redis.values.get('k')).toBe(0n) // floored
  })

  /** reset deletes the key. */
  it('resets a key', async () => {
    const redis = new FakeRedis()
    const store = new RedisBudgetCounterStore(asRedis(redis))
    await store.incrIfBelow('k', 10n, 100n, 60)
    await store.reset('k')
    expect(redis.deleted).toContain('k')
  })

  /** The key prefix namespaces every operation. */
  it('applies the key prefix', async () => {
    const redis = new FakeRedis()
    const store = new RedisBudgetCounterStore(asRedis(redis), { keyPrefix: 'app:' })
    await store.incrIfBelow('k', 10n, 100n, 60)
    expect(redis.values.has('app:k')).toBe(true)
  })

  /** A connection URL is lazily connected via a dynamic ioredis import (mocked). */
  it('lazily connects a URL', async () => {
    const store = new RedisBudgetCounterStore('redis://user:secret@localhost:6379')
    expect(await store.incrIfBelow('k', 1n, 100n, 60)).toBe(true)
    expect(await store.incrIfBelow('k', 1n, 100n, 60)).toBe(true) // reuses the cached client
  })
})

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class MockRedis {
    eval(): Promise<number> {
      return Promise.resolve(1)
    }
    del(): Promise<number> {
      return Promise.resolve(1)
    }
  },
}))
