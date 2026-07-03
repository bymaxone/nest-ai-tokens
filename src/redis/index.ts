/**
 * @fileoverview `RedisBudgetCounterStore` — the optional live cross-replica budget
 * counter (`./redis` subpath, spec §10.8, §15.1). It makes budget enforcement cheap
 * under high concurrency: `incrIfBelow` is a SINGLE atomic Lua script (increment,
 * then undo and reject when the result would exceed the limit), so two racing
 * replicas can never both pass a nearly-full budget. The DB conditional consume
 * stays authoritative — this counter is the fast path, not the source of truth.
 * Values are int64 (Redis native) written/compared as decimal strings; keys carry
 * the caller's optional prefix. `ioredis` is an OPTIONAL peer: the constructor
 * accepts a live `Redis` instance, or a connection URL that is lazily connected via
 * a DYNAMIC import so the base library never statically depends on the client.
 * Connection URLs (which may embed credentials) are never logged or placed on an
 * exception.
 * @layer redis
 */

import type { Redis } from 'ioredis'
import type { IBudgetCounterStore } from '../server'

/** Construction options for {@link RedisBudgetCounterStore}. */
export interface RedisBudgetCounterStoreOptions {
  /** Prepended to every counter key (namespacing a shared Redis). */
  keyPrefix?: string
}

/** The largest integer Redis Lua's IEEE-754 doubles represent exactly (`2^53 − 1`), as a Lua literal. */
const SAFE_INTEGER_MAX = '9007199254740991'

/**
 * Atomically increment `KEYS[1]` by `ARGV[1]`, but undo and return `0` when the new
 * value would exceed the limit `ARGV[2]`; otherwise set the TTL `ARGV[3]` (ms) and
 * return `1`. The increment-then-undo keeps the whole check-and-set in ONE atomic
 * script — no other command interleaves between the read and the write.
 *
 * Redis Lua compares with IEEE-754 doubles, which lose precision above `2^53 − 1`.
 * When an operand OR the resulting counter falls outside that safe-integer range the
 * script undoes any increment and returns `-1` so the caller signals the counter as
 * unavailable and falls back to the authoritative DB conditional consume, which
 * compares int64 nano-USD exactly — a fail-safe to the source of truth.
 */
const INCR_IF_BELOW_LUA = `
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if amount > ${SAFE_INTEGER_MAX} or amount < -${SAFE_INTEGER_MAX} or limit > ${SAFE_INTEGER_MAX} or limit < -${SAFE_INTEGER_MAX} then
  return -1
end
local newValue = redis.call('INCRBY', KEYS[1], ARGV[1])
if newValue > ${SAFE_INTEGER_MAX} or newValue < -${SAFE_INTEGER_MAX} then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return -1
end
if newValue > limit then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 0
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`

/** Atomically decrement `KEYS[1]` by `ARGV[1]`, flooring the stored value at `0`. */
const DECR_FLOOR_LUA = `
local newValue = redis.call('DECRBY', KEYS[1], ARGV[1])
if newValue < 0 then
  redis.call('SET', KEYS[1], '0')
end
return 1
`

/**
 * Signals that a counter operand or result falls outside the IEEE-754 safe-integer
 * range (`±(2^53 − 1)`), where the Lua/Redis double arithmetic the fast path relies
 * on would silently lose precision. It is thrown so `BudgetService` treats the counter
 * as unavailable and falls back to the authoritative DB conditional consume, which
 * compares int64 nano-USD exactly.
 */
export class CounterValueOutOfRangeError extends Error {
  readonly isCounterValueOutOfRange = true
  constructor() {
    super('counter operand or result exceeds the safe-integer range')
    this.name = 'CounterValueOutOfRangeError'
  }
}

/** The official Redis adapter for the live budget counter port. */
export class RedisBudgetCounterStore implements IBudgetCounterStore {
  private readonly keyPrefix: string
  private readonly source: Redis | string
  private connecting: Promise<Redis> | null = null

  /**
   * @param redis A live `ioredis` client, or a connection URL to lazily connect.
   * @param options Optional key prefix.
   */
  constructor(redis: Redis | string, options: RedisBudgetCounterStoreOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? ''
    this.source = redis
  }

  /**
   * Atomically increment `key` by `amount` iff the result stays `<= limit`, setting
   * the TTL. Returns `false` when the increment would exceed the limit.
   *
   * @param key The dimension counter key.
   * @param amount The amount to add (int64 nano-USD or token/count units).
   * @param limit The dimension limit.
   * @param ttlSeconds The key TTL (window length + grace).
   * @returns `true` when incremented within the limit, `false` when it would exceed it.
   * @throws {CounterValueOutOfRangeError} when an operand or the resulting counter exceeds the safe-integer range.
   */
  async incrIfBelow(key: string, amount: bigint, limit: bigint, ttlSeconds: number): Promise<boolean> {
    const client = await this.resolve()
    const result = await client.eval(
      INCR_IF_BELOW_LUA,
      1,
      this.prefixed(key),
      amount.toString(),
      limit.toString(),
      Math.ceil(ttlSeconds * 1_000).toString(),
    )
    if (result === -1) throw new CounterValueOutOfRangeError()
    return result === 1
  }

  /**
   * Decrement `key` by `amount`, flooring the stored value at zero (release/reverse).
   *
   * @param key The dimension counter key.
   * @param amount The amount to subtract.
   */
  async decr(key: string, amount: bigint): Promise<void> {
    const client = await this.resolve()
    await client.eval(DECR_FLOOR_LUA, 1, this.prefixed(key), amount.toString())
  }

  /**
   * Reset (delete) `key` — used on window rotation.
   *
   * @param key The dimension counter key.
   */
  async reset(key: string): Promise<void> {
    const client = await this.resolve()
    await client.del(this.prefixed(key))
  }

  /** Prepend the configured key prefix. */
  private prefixed(key: string): string {
    return `${this.keyPrefix}${key}`
  }

  /** Resolve the live client, lazily connecting a URL via a dynamic `ioredis` import. */
  private resolve(): Promise<Redis> {
    if (typeof this.source !== 'string') return Promise.resolve(this.source)
    this.connecting ??= this.connect(this.source)
    return this.connecting
  }

  /** Dynamically import `ioredis` and connect the given URL. */
  private async connect(url: string): Promise<Redis> {
    const { default: RedisClient } = await import('ioredis')
    return new RedisClient(url)
  }
}
