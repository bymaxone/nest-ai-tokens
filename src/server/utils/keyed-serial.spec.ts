/**
 * @fileoverview Pins the per-key serializer: work under one key runs one piece at a time in order,
 * work under another key never waits, a piece neither inherits the previous value nor its failure,
 * and a key is held only while work under it is in flight.
 * @layer server
 */
import { KeyedSerial } from './keyed-serial'

/** A promise settled from outside, so a test controls when a piece of work finishes. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('KeyedSerial', () => {
  /** Work under one key runs in submission order and never overlaps. */
  it('runs work under one key one piece at a time, in order', async () => {
    const serial = new KeyedSerial()
    const log: string[] = []
    const first = deferred<undefined>()
    const a = serial.run('k', async () => {
      log.push('a:start')
      await first.promise
      log.push('a:end')
      return undefined
    })
    const b = serial.run('k', () => {
      log.push('b:start')
      return Promise.resolve(undefined)
    })

    await Promise.resolve()
    expect(log).toEqual(['a:start'])
    first.resolve(undefined)
    await Promise.all([a, b])
    expect(log).toEqual(['a:start', 'a:end', 'b:start'])
  })

  /** A different key never waits behind a held one. */
  it('lets work under another key run while one key is held', async () => {
    const serial = new KeyedSerial()
    const held = deferred<undefined>()
    const a = serial.run('a', () => held.promise)

    await expect(serial.run('b', () => Promise.resolve('b done'))).resolves.toBe('b done')
    expect(serial.size).toBe(1)
    held.resolve(undefined)
    await a
    expect(serial.size).toBe(0)
  })

  /** The next piece runs on its own and does not see the failure of the one before it. */
  it('runs the next piece after a failure, which it does not inherit', async () => {
    const serial = new KeyedSerial()
    const failure = new Error('first failed')
    const a = serial.run('k', () => Promise.reject(failure))
    const b = serial.run('k', () => Promise.resolve('second'))

    await expect(a).rejects.toBe(failure)
    await expect(b).resolves.toBe('second')
  })

  /** Each piece returns its own value. */
  it('returns each piece its own value', async () => {
    const serial = new KeyedSerial()
    const results = await Promise.all([serial.run('k', () => Promise.resolve(1)), serial.run('k', () => Promise.resolve(2))])
    expect(results).toEqual([1, 2])
  })

  /** A key is held only while work is in flight, however the work ends. */
  it.each([
    ['succeeds', () => Promise.resolve('ok')],
    ['rejects', () => Promise.reject(new Error('boom'))],
    [
      'throws synchronously',
      (): Promise<string> => {
        throw new Error('sync boom')
      },
    ],
  ])('holds no key once work that %s has settled', async (_name, work) => {
    const serial = new KeyedSerial()
    await serial.run('k', work).catch(() => undefined)
    expect(serial.size).toBe(0)
  })

  /** A later piece keeps the key held until it settles too; only the newest settlement releases it. */
  it('keeps the key held until the newest piece settles', async () => {
    const serial = new KeyedSerial()
    const gate = deferred<undefined>()
    const a = serial.run('k', () => Promise.resolve(undefined))
    const b = serial.run('k', () => gate.promise)

    await a
    expect(serial.size).toBe(1)
    gate.resolve(undefined)
    await b
    expect(serial.size).toBe(0)
  })
})
