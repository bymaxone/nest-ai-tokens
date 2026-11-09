import { inspect } from 'node:util'
import type { Redis } from 'ioredis'
import { CounterValueOutOfRangeError, RedisBudgetCounterStore } from './index'

/** The largest integer the shipped Lua script treats as safe (`2^53 − 1`). */
const SAFE_MAX = 9_007_199_254_740_991n

/** A minimal in-memory Redis that interprets the two shipped Lua scripts. */
class FakeRedis {
  readonly values = new Map<string, bigint>()
  readonly ttls = new Map<string, number>()
  readonly deleted: string[] = []
  readonly scripts: string[] = []

  eval(script: string, _numKeys: number, key: string, ...args: string[]): Promise<number> {
    this.scripts.push(script)
    if (script.includes('PEXPIRE')) {
      const [amount, limit, ttl] = args as [string, string, string]
      const amt = BigInt(amount)
      const lim = BigInt(limit)
      const next = (this.values.get(key) ?? 0n) + amt
      if (outOfSafeRange(amt) || outOfSafeRange(lim) || outOfSafeRange(next)) return Promise.resolve(-1)
      if (next > lim) return Promise.resolve(0)
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

/** Whether a value falls outside the Lua safe-integer range (`±(2^53 − 1)`). */
function outOfSafeRange(value: bigint): boolean {
  return value > SAFE_MAX || value < -SAFE_MAX
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

  /** An operand beyond the safe-integer range throws so the service falls back to the DB. */
  it('throws when an operand exceeds the safe-integer range', async () => {
    const redis = new FakeRedis()
    const store = new RedisBudgetCounterStore(asRedis(redis))
    await expect(store.incrIfBelow('k', 9_007_199_254_740_993n, 9_007_199_254_740_999n, 60)).rejects.toBeInstanceOf(
      CounterValueOutOfRangeError,
    )
    expect(redis.values.get('k') ?? 0n).toBe(0n) // nothing persisted
  })

  /** An in-range increment that would push the accumulated counter out of range also throws. */
  it('throws when the accumulated counter exceeds the safe-integer range', async () => {
    const redis = new FakeRedis()
    const store = new RedisBudgetCounterStore(asRedis(redis))
    expect(await store.incrIfBelow('k', 5_000_000_000_000_000n, 9_000_000_000_000_000n, 60)).toBe(true) // 5e15 ≤ limit
    await expect(store.incrIfBelow('k', 5_000_000_000_000_000n, 9_000_000_000_000_000n, 60)).rejects.toBeInstanceOf(
      CounterValueOutOfRangeError,
    )
    expect(redis.values.get('k')).toBe(5_000_000_000_000_000n) // second increment undone
  })

  /** The out-of-range signal is structurally branded for cross-bundle detection. */
  it('brands the out-of-range signal', () => {
    expect(new CounterValueOutOfRangeError().isCounterValueOutOfRange).toBe(true)
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

describe('RedisBudgetCounterStore serialization', () => {
  it('keeps the connection source out of every serialization path', () => {
    // A connection URL carries the password inline and an ioredis instance
    // carries `options.password` as a plain field, so a store that exposes
    // either leads a logger or an error reporter straight to the credentials.
    // `showHidden` is asserted because it is what defeats a merely
    // non-enumerable property.
    const password = 'r3d1s-canary'
    const store = new RedisBudgetCounterStore(`redis://default:${password}@127.0.0.1:6379`)

    expect(JSON.stringify(store)).not.toContain(password)
    // `Object.assign` rather than a spread: it copies the same enumerable own
    // properties, and this repository forbids spreading a class instance.
    expect(JSON.stringify(Object.assign({}, store))).not.toContain(password)
    expect(inspect(store, { depth: null, showHidden: true })).not.toContain(password)
  })
})

describe('RedisBudgetCounterStore scripts and errors', () => {
  /** The increment script is sent verbatim: every comparison names the safe-integer bound, and the TTL is set last. */
  it('sends the increment script with the safe-integer bound in every comparison', async () => {
    const redis = new FakeRedis()
    await new RedisBudgetCounterStore(asRedis(redis)).incrIfBelow('k', 1n, 10n, 60)
    expect(redis.scripts).toEqual([
      [
        '',
        'local amount = tonumber(ARGV[1])',
        'local limit = tonumber(ARGV[2])',
        'if amount > 9007199254740991 or amount < -9007199254740991 or limit > 9007199254740991 or limit < -9007199254740991 then',
        '  return -1',
        'end',
        "local newValue = redis.call('INCRBY', KEYS[1], ARGV[1])",
        'if newValue > 9007199254740991 or newValue < -9007199254740991 then',
        "  redis.call('DECRBY', KEYS[1], ARGV[1])",
        '  return -1',
        'end',
        'if newValue > limit then',
        "  redis.call('DECRBY', KEYS[1], ARGV[1])",
        '  return 0',
        'end',
        "redis.call('PEXPIRE', KEYS[1], ARGV[3])",
        'return 1',
        '',
      ].join('\n'),
    ])
  })

  /** The decrement script is sent verbatim: it decrements, then clamps a negative result to zero. */
  it('sends the decrement script that floors the counter at zero', async () => {
    const redis = new FakeRedis()
    await new RedisBudgetCounterStore(asRedis(redis)).decr('k', 1n)
    expect(redis.scripts).toEqual([
      ['', "local newValue = redis.call('DECRBY', KEYS[1], ARGV[1])", 'if newValue < 0 then', "  redis.call('SET', KEYS[1], '0')", 'end', 'return 1', ''].join('\n'),
    ])
  })

  /** The out-of-range signal names itself and says why, so a log line identifies it. */
  it('names the out-of-range signal and its cause', () => {
    const error = new CounterValueOutOfRangeError()
    expect(error.name).toBe('CounterValueOutOfRangeError')
    expect(error.message).toBe('counter operand or result exceeds the safe-integer range')
    expect(error).toBeInstanceOf(Error)
  })
})
