/**
 * @fileoverview Specs of what a `RedisBudgetCounterStore` rejects with when the client fails: a fixed message and at most the
 * error code, never the client's message, command, arguments or cause, and never the connection URL. Replies come from a
 * loopback server through the installed `ioredis`; a client stub covers errors of a shape that client does not produce.
 * @layer redis
 */

import { createServer, type Socket } from 'node:net'
import { inspect } from 'node:util'
import { Logger } from '@nestjs/common'
import RedisClient, { type Redis } from 'ioredis'
import { RedisBudgetCounterStore } from './index'

/** A stand-in secret that must appear on no rejection. */
const PASSWORD = 'dummy-pw-3f9a'

/** A stand-in counter key that must appear on no rejection. */
const KEY = 'dummy-counter-key-77'

/** The three counter operations. */
const OPERATIONS: readonly (readonly [string, (store: RedisBudgetCounterStore) => Promise<unknown>])[] = [
  ['incrIfBelow', (store) => store.incrIfBelow(KEY, 5n, 10n, 60)],
  ['decr', (store) => store.decr(KEY, 5n)],
  ['reset', (store) => store.reset(KEY)],
]

/** The rejection of a promise that must reject. */
async function rejectionOf(pending: Promise<unknown>): Promise<Error & { code?: unknown }> {
  try {
    await pending
  } catch (error) {
    return error as Error & { code?: unknown }
  }
  throw new Error('expected a rejection')
}

/** Assert that an error is the store's own, with the given code, and carries nothing of the call. */
function expectOwnError(error: Error & { code?: unknown; cause?: unknown }, code: string | undefined): void {
  expect(error.name).toBe('CounterStoreError')
  expect(error.message).toBe('counter command failed')
  expect(error.code).toBe(code)
  expect(error.cause).toBeUndefined()
  expect(Object.keys(error).sort()).toEqual(code === undefined ? ['name'] : ['code', 'name'])
  const rendered = `${inspect(error, { depth: 8, showHidden: true })}\n${JSON.stringify(error)}`
  for (const secret of [PASSWORD, KEY, 'redis.call', 'dummy message']) expect(rendered).not.toContain(secret)
}

/** A client whose commands reject with `failure`. */
function failingClient(failure: unknown): Redis {
  // A client may reject with anything; the cast only satisfies the rule about rejection reasons.
  const reason = failure as Error
  const fail = (): Promise<never> => Promise.reject(reason)
  return { status: 'ready', eval: fail, del: fail } as unknown as Redis
}

/** The `ioredis` shape of a reply error, with the command it answered. */
function replyError(message: string, command: { name: string; args: string[] }): Error {
  return Object.assign(new Error(message), { name: 'ReplyError', command })
}

/** A loopback server that answers `error` to every command named in `refused`, and `OK` to the rest of the handshake. */
async function loopbackServer(error: (parts: string[]) => string, refused: readonly string[] = ['eval', 'del']): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.on('error', () => undefined)
    socket.on('data', (data) => {
      buffer += data.toString()
      for (let parts = take(); parts !== null; parts = take()) {
        const name = parts[0]?.toLowerCase()
        if (name !== undefined && refused.includes(name)) socket.write(`-${error(parts)}\r\n`)
        else if (name === 'info') socket.write('$11\r\nloading:0\r\n\r\n')
        else socket.write('+OK\r\n')
      }
    })
    /** The next whole command in the buffer, or `null` when it has not all arrived. */
    function take(): string[] | null {
      const head = /^\*(\d+)\r\n/.exec(buffer)
      if (head === null) return null
      let at = head[0].length
      const parts: string[] = []
      for (let index = 0; index < Number(head[1]); index += 1) {
        const length = /^\$(\d+)\r\n/.exec(buffer.slice(at))
        if (length === null) return null
        const start = at + length[0].length
        const end = start + Number(length[1])
        if (buffer.length < end + 2) return null
        parts.push(buffer.slice(start, end))
        at = end + 2
      }
      buffer = buffer.slice(at)
      return parts
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

describe('a failed command of the client the store created', () => {
  const replies: readonly (readonly [string, (parts: string[]) => string, string])[] = [
    ['out of memory', () => "OOM command not allowed when used memory > 'maxmemory'.", 'OOM'],
    ['an unknown command that echoes its arguments', (parts) => `ERR unknown command 'AUTH', with args beginning with: '${PASSWORD}' '${parts.join("' '").replace(/[\r\n]+/g, ' ')}'`, 'ERR'],
  ]

  it.each(replies)('rejects %s with the reply code only', async (_name, error, code) => {
    const server = await loopbackServer(error)
    const store = new RedisBudgetCounterStore(`redis://:${PASSWORD}@127.0.0.1:${String(server.port)}`)
    try {
      for (const [, operation] of OPERATIONS) expectOwnError(await rejectionOf(operation(store)), code)
    } finally {
      await store.onModuleDestroy()
      server.close()
    }
  })

  /** A URL that cannot be parsed is rejected without repeating it, on every call. */
  it.each([`redis://:${PASSWORD}@127.0.0.1:notaport`, `redis://:${PASSWORD}@[bad`])('rejects a malformed URL without it', async (url) => {
    const store = new RedisBudgetCounterStore(url)
    for (const [, operation] of OPERATIONS) {
      const error = await rejectionOf(operation(store))
      expect(error.message).toBe('invalid connection URL')
      expect(error.cause).toBeUndefined()
      expect(Object.keys(error)).toEqual([])
      expect(`${inspect(error, { depth: 8, showHidden: true })}\n${JSON.stringify(error)}`).not.toContain(PASSWORD)
    }
    await store.onModuleDestroy()
  })
})

describe('an error event of the client the store created', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  /**
   * The error a refused login raises holds the login command with its arguments. The store listens, so the client writes nothing itself,
   * and every line the store writes is the key with the reply code: no argument of the command reaches a log.
   */
  it('logs the key and the reply code, and no argument of the refused command', async () => {
    const server = await loopbackServer(() => 'WRONGPASS dummy message', ['hello', 'auth'])
    const url = `redis://:${PASSWORD}@127.0.0.1:${String(server.port)}`
    const control = new RedisClient(url, { maxRetriesPerRequest: 0 })
    const raised = await new Promise<{ command?: { args?: unknown[] } }>((done) => control.once('error', done))
    control.on('error', () => undefined)
    control.disconnect()
    expect(JSON.stringify(raised.command?.args)).toContain(PASSWORD)

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const others = (['log', 'error', 'debug', 'verbose', 'fatal'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined))
    const printed = (['log', 'error', 'warn', 'info', 'debug'] as const).map((level) => jest.spyOn(console, level).mockImplementation(() => undefined))
    const store = new RedisBudgetCounterStore(url)
    try {
      await rejectionOf(store.reset(KEY))
    } finally {
      await store.onModuleDestroy()
      server.close()
    }
    expect(warn.mock.calls.length).toBeGreaterThan(0)
    for (const call of warn.mock.calls) expect(call).toEqual(['ai_tokens.redis_counter.client_error code=WRONGPASS'])
    for (const spy of [...others, ...printed]) expect(spy).not.toHaveBeenCalled()
  })
})

describe('a failed command of a client the host passed in', () => {
  /** A rejected login keeps its reply code, whatever else the error of the client holds. */
  it.each(OPERATIONS)('%s keeps the code of a rejected login and nothing else', async (_name, operation) => {
    const failure = replyError('WRONGPASS dummy message', { name: 'hello', args: ['3', 'AUTH', 'default', PASSWORD] })
    expectOwnError(await rejectionOf(operation(new RedisBudgetCounterStore(failingClient(failure)))), 'WRONGPASS')
  })

  const failures: readonly (readonly [string, unknown, string | undefined])[] = [
    ['a socket error keeps its code', Object.assign(new Error('dummy message'), { code: 'ECONNREFUSED', cause: PASSWORD }), 'ECONNREFUSED'],
    ['a reply with no code word has none', replyError('dummy message', { name: 'del', args: [KEY] }), undefined],
    ['an error that is no reply gives no code by its message', new Error(`DUMMY message ${PASSWORD}`), undefined],
    ['a code that is not code-shaped is dropped', Object.assign(new Error('dummy message'), { code: PASSWORD }), undefined],
    ['a reply code wins over a code property', Object.assign(replyError('NOSCRIPT dummy message', { name: 'eval', args: [] }), { code: 'OTHER' }), 'NOSCRIPT'],
    ['a rejection that is not an object has none', PASSWORD, undefined],
    ['a rejection of nothing has none', undefined, undefined],
    ['null has none', null, undefined],
    ['an error that throws when read has none', Object.defineProperty(new Error('dummy message'), 'name', { get: () => { throw new Error(PASSWORD) } }), undefined],
  ]

  it.each(failures)('%s', async (_name, failure, code) => {
    expectOwnError(await rejectionOf(new RedisBudgetCounterStore(failingClient(failure)).reset(KEY)), code)
  })
})
