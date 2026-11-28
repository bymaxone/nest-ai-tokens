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
 * exception, a failed command rejects without the client's error, and an error event
 * of a client the store created is logged by its code alone.
 * @layer redis
 */

import type { Redis } from 'ioredis'
import type { IBudgetCounterStore } from '../server'
// By package specifier, not by relative path: entry points are separate bundles, so a relative import would copy the
// class into this one and the server's `instanceof AiTokensException` guards would stop matching what this store throws.
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { Logger } from '@nestjs/common'
import { types } from 'node:util'
import { refusesPromise } from '../shared/utils/native-promise'
import { codeOf, commandFailure } from './command-errors'

/** The log key of an error event of a client the store created. */
const CLIENT_ERROR_LOG_KEY = 'ai_tokens.redis_counter.client_error'

/**
 * The client, in an object with no prototype. A client reached through a promise is read for `then` by the engine, on its class chain,
 * which a host can plant; an object with no prototype has none to read, and the client is taken from it after the wait.
 */
interface ClientBox {
  readonly client: Redis
}

/** Put `client` in a {@link ClientBox}. */
function boxed(client: Redis): ClientBox {
  return Object.assign(Object.create(null) as object, { client })
}

/**
 * Wait for what a command of the client returned with a native `await`, once the promise is known to run no `constructor` or `then` of the
 * host: a one-shot plant of either, while the command ran, would make the wait answer for Redis. A rejected command is answered by the
 * store's own error.
 */
async function reply<T>(pending: Promise<T>): Promise<T> {
  if (refusesPromise(pending, true, types.isProxy)) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'a promise the Redis client returned reads a constructor or then of its own' })
  try {
    return await pending
  } catch (error) {
    throw commandFailure(error)
  }
}

/** Construction options for {@link RedisBudgetCounterStore}. */
export interface RedisBudgetCounterStoreOptions {
  /** Prepended to every counter key (namespacing a shared Redis). */
  keyPrefix?: string
  /**
   * How long `onModuleDestroy` waits for a graceful `quit()` of a client this store created before it drops the
   * connection with `disconnect()`. A whole number of milliseconds from 1 to 2,147,483,647, default 2000; anything else is
   * refused with `AI_TOKENS_INVALID_CONFIG`. A client passed in by the host is never closed.
   */
  closeTimeoutMs?: number
  /**
   * How long a command on a client this store created waits for Redis before it fails, which the budget service answers with
   * the database path. A whole number of milliseconds from 1 to 2,147,483,647, default 500; anything else is refused with
   * `AI_TOKENS_INVALID_CONFIG`. A client passed in by the host keeps the host's own settings.
   */
  commandTimeoutMs?: number
}

/** The default bound on a graceful `quit()` of an owned client, in milliseconds. */
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000

/** The default bound on one command of an owned client, in milliseconds. Against a stopped server a command then fails in at most about 500 ms, where the ioredis defaults held it for over a minute. */
const DEFAULT_COMMAND_TIMEOUT_MS = 500

/** The longest delay `setTimeout` runs: 2^31-1 milliseconds, a longer one fires after a millisecond. */
const MAX_CLOSE_TIMEOUT_MS = 2_147_483_647

/** Throw unless `value`, when given, is a whole number of milliseconds a timer honours, naming the option; `fallback` when it is not given. */
function requireMillis(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > MAX_CLOSE_TIMEOUT_MS) {
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: `${name} must be an integer from 1 to ${String(MAX_CLOSE_TIMEOUT_MS)}` })
  }
  return value
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
  private readonly logger = new Logger('RedisBudgetCounterStore')
  private readonly keyPrefix: string
  private readonly closeTimeoutMs: number

  /** The command timeout of a client this store creates. */
  private readonly commandTimeoutMs: number
  /**
   * The live client or the connection URL it is opened from.
   *
   * An ECMAScript private field rather than a TypeScript `private` one, which is
   * erased at runtime: a connection URL carries the Redis password inline, and an
   * ioredis instance carries `options.password` as a plain field. Leaving either
   * enumerable would let anything that serializes this store — a structured
   * logger rendering its arguments, an error reporter capturing the scope of a
   * throw — emit the credentials in plaintext.
   */
  readonly #source: Redis | string

  /** The in-flight lazy connection, which resolves to the same credentialed client. */
  #connecting: Promise<ClientBox> | null = null

  /** Set once the store has closed the client it created: later calls fail instead of opening a new connection. */
  #closed = false

  /** The client this store created, kept as soon as it exists so that shutdown closes it even when the wait for the connection is refused. */
  #owned: Redis | null = null

  /**
   * @param redis A live `ioredis` client, or a connection URL to lazily connect.
   * @param options Optional key prefix.
   */
  constructor(redis: Redis | string, options: RedisBudgetCounterStoreOptions = {}) {
    // The options are read as the host's own: an option left out is not answered by a key planted on `Object.prototype`.
    const own = <K extends keyof RedisBudgetCounterStoreOptions>(key: K): RedisBudgetCounterStoreOptions[K] | undefined => (Object.hasOwn(options, key) ? options[key] : undefined)
    this.keyPrefix = own('keyPrefix') ?? ''
    this.closeTimeoutMs = requireMillis('closeTimeoutMs', own('closeTimeoutMs'), DEFAULT_CLOSE_TIMEOUT_MS)
    this.commandTimeoutMs = requireMillis('commandTimeoutMs', own('commandTimeoutMs'), DEFAULT_COMMAND_TIMEOUT_MS)
    this.#source = redis
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
    const { client } = await this.resolve()
    const result = await reply(
      client.eval(INCR_IF_BELOW_LUA, 1, this.prefixed(key), amount.toString(), limit.toString(), Math.ceil(ttlSeconds * 1_000).toString()),
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
    const { client } = await this.resolve()
    await reply(client.eval(DECR_FLOOR_LUA, 1, this.prefixed(key), amount.toString()))
  }

  /**
   * Reset (delete) `key` — used on window rotation.
   *
   * @param key The dimension counter key.
   */
  async reset(key: string): Promise<void> {
    const { client } = await this.resolve()
    await reply(client.del(this.prefixed(key)))
  }

  /**
   * Close the client this store created from a connection URL, so the process can exit after the application closes.
   * The host owns a client it passed in: that one is never touched. The owned client gets a graceful `quit()` bounded by
   * `closeTimeoutMs`, then `disconnect()`, and nothing at all when it has already ended (a second teardown timer would
   * keep the process alive). Called by Nest on shutdown; safe to call twice.
   */
  async onModuleDestroy(): Promise<void> {
    this.#closed = true
    const client = this.#owned
    if (client === null || client.status === 'end') return
    await this.quitWithin(client)
  }

  /** Quit gracefully within the bound, falling back to `disconnect()` when the quit is late or fails; leaves no timer behind. */
  private async quitWithin(client: Redis): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const outcome = { quit: false }
    await new Promise<void>((done) => {
      timer = setTimeout(done, this.closeTimeoutMs)
      // The wait for the quit is a native `await` in its own function, not a race: the timer above ends the wait whatever the quit does.
      void (async (): Promise<void> => {
        try {
          await reply(client.quit())
          outcome.quit = true
        } catch {
          // A failed quit is answered by the disconnect below.
        }
        done()
      })()
    })
    clearTimeout(timer)
    if (!outcome.quit && client.status !== 'end') client.disconnect()
  }

  /** Prepend the configured key prefix. */
  private prefixed(key: string): string {
    return `${this.keyPrefix}${key}`
  }

  /** Resolve the live client, lazily connecting a URL via a dynamic `ioredis` import. */
  private async resolve(): Promise<ClientBox> {
    if (typeof this.#source !== 'string') return boxed(this.#source)
    if (this.#closed) throw new Error('counter store is closed')
    this.#connecting ??= this.connect(this.#source)
    const connecting = this.#connecting
    // Stryker disable next-line BooleanLiteral: equivalent: `connecting` is always the intrinsic promise of the async connect(), which refusesPromise answers before it reads `thenables`
    if (refusesPromise(connecting, false, types.isProxy)) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'the connection reads a constructor or then of its own' })
    return await connecting
  }

  /** Dynamically import `ioredis` and connect the given URL. */
  private async connect(url: string): Promise<ClientBox> {
    const { default: RedisClient } = await import('ioredis')
    // One retry per command and a command timeout, so a stopped Redis answers in the time of the timeout; the offline queue stays on, so a command issued while the connection is still opening waits for it.
    // A store closed while the client was loading opens none, so no connection outlives the shutdown.
    if (this.#closed) throw new Error('counter store is closed')
    let client: Redis
    try {
      client = new RedisClient(url, { maxRetriesPerRequest: 1, enableOfflineQueue: true, commandTimeout: this.commandTimeoutMs })
    } catch {
      // The error of a URL that cannot be parsed keeps the URL as a field.
      throw new Error('invalid connection URL')
    }
    this.#owned = client
    // A client with no listener of its own writes its errors to stderr itself. Its error object can hold a command and the command's arguments.
    client.on('error', (failure: unknown) => {
      this.warnClientError(failure)
    })
    return boxed(client)
  }

  /** Log an error event of the owned client: the key and at most the code, never the error. */
  private warnClientError(failure: unknown): void {
    const code = codeOf(failure)
    try {
      this.logger.warn(code === undefined ? CLIENT_ERROR_LOG_KEY : `${CLIENT_ERROR_LOG_KEY} code=${code}`)
    } catch {
      // The line is dropped: a logger of the host that throws here would throw out of the client's event.
    }
  }
}
