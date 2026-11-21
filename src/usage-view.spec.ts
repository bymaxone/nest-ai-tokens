/**
 * @fileoverview The view of a raw provider response that a normalizer reads: it answers each field with the value of the first read,
 * hands the objects in it on as views of their own, never lets a failure of the host's object reach its reader as the host's own error,
 * and refuses to list an object that is a Proxy and lists nothing.
 * @layer server
 */

import { AiTokensException } from './server/errors'
import { viewOf } from './server/utils/usage-view'

/** The reason of the typed refusal `read` raises, or `undefined` when it returns. */
function refusalOf(read: () => unknown): string | undefined {
  try {
    read()
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    const { error: body } = error.getResponse() as { error: { code: string; details?: { reason?: string } } }
    return `${body.code} ${body.details?.reason ?? ''}`
  }
  return undefined
}

describe('the view of a raw provider response', () => {
  it('answers a field with the value of its first read, and an object in it with a view that does the same', () => {
    let reads = 0
    const host = { get count(): number { reads += 1; return reads }, inner: { get tokens(): number { reads += 10; return reads } } }
    const view = viewOf(host)
    expect([view.count, view.count, view.inner.tokens, view.inner.tokens]).toEqual([1, 1, 11, 11])
    expect(reads).toBe(11)
  })

  it('reads like the object: its keys, its entries, a field that is missing and a field that is there', () => {
    const view = viewOf({ a: 1, b: { c: 2 } })
    expect(Object.keys(view)).toEqual(['a', 'b'])
    expect(Object.entries(view.b)).toEqual([['c', 2]])
    expect('a' in view).toBe(true)
    expect('z' in view).toBe(false)
    expect(Object.getOwnPropertyDescriptor(view, 'a')?.enumerable).toBe(true)
    expect(Object.getOwnPropertyDescriptor(view, 'z')).toBeUndefined()
  })

  it('has one view for an object, whichever way it is reached, a cycle included', () => {
    const shared = { n: 1 }
    const cyclic: Record<string, unknown> = { shared, again: shared }
    cyclic.self = cyclic
    const views = new WeakMap<object, object>()
    const view = viewOf(cyclic, views) as { shared: object; again: object; self: object }
    expect(view.shared).toBe(view.again)
    expect(view.self).toBe(view)
    expect(viewOf(cyclic, views)).toBe(view)
  })

  it('keeps nothing of one call for the next: the same response, changed between two reads, answers its new value', () => {
    const raw = { input_tokens: 1 }
    expect(viewOf(raw).input_tokens).toBe(1)
    raw.input_tokens = 2
    expect(viewOf(raw).input_tokens).toBe(2)
    const views = new WeakMap<object, object>()
    expect(viewOf(raw, views)).toBe(viewOf(raw, views))
  })

  it('reports a field as the library lists it: own, hidden and defined by a class are enumerable and redefinable, and what is not there is not', () => {
    class Tools {
      get counted(): number {
        return Number('5')
      }
      *[Symbol.iterator](): Generator<number> {
        yield Number('1')
      }
    }
    const hidden = Object.defineProperty({ plain: 1 }, 'secret', { value: 2, enumerable: false, configurable: false, writable: false })
    const own = viewOf(hidden)
    expect(Object.getOwnPropertyDescriptor(own, 'plain')).toEqual({ value: 1, writable: true, enumerable: true, configurable: true })
    expect(Object.getOwnPropertyDescriptor(own, 'secret')).toEqual({ value: 2, writable: false, enumerable: true, configurable: true })
    expect(Object.keys(own)).toEqual(['plain', 'secret'])
    const tools = viewOf(new Tools())
    expect(Object.getOwnPropertyDescriptor(tools, 'counted')).toEqual({ value: undefined, writable: true, enumerable: true, configurable: true })
    expect(Object.getOwnPropertyDescriptor(tools, 'missing')).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(tools, Symbol.iterator)).toBeUndefined()
    expect(Object.entries(tools)).toEqual([['counted', 5]])
    expect(Object.getOwnPropertyDescriptor(viewOf([1]), '9')).toBeUndefined()
    const tag = Symbol('tag')
    expect(Object.getOwnPropertyDescriptor(viewOf({ [tag]: 1 }), tag)).toEqual({ value: 1, writable: true, enumerable: true, configurable: true })
  })

  it('is a list when the object is a list, with its length, its elements and its iteration', () => {
    const view = viewOf([{ ttl: '1h' }, { ttl: '5m' }])
    expect(Array.isArray(view)).toBe(true)
    expect(view).toHaveLength(2)
    expect([...view].map((item) => item.ttl)).toEqual(['1h', '5m'])
    expect(Object.getOwnPropertyDescriptor(view, 'length')?.configurable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(view, '0')?.configurable).toBe(true)
  })

  it('hands a date, a Buffer and a function on as they are', () => {
    const date = new Date(0)
    const buffer = Buffer.alloc(8)
    const fn = (): number => 1
    const view = viewOf({ date, buffer, fn })
    expect([view.date, view.buffer, view.fn]).toEqual([date, buffer, fn])
    expect(view.buffer).toBe(buffer)
  })

  it('reads a prototype as the object has it, and as none when the host cannot say', () => {
    class Response {}
    expect(Object.getPrototypeOf(viewOf(new Response()))).toBe(Response.prototype)
    const hostile = new Proxy({}, { getPrototypeOf: (): never => { throw new Error('host-private-text') } })
    expect(viewOf(hostile) instanceof Object).toBe(false)
    expect(Object.getPrototypeOf(viewOf(hostile))).toBeNull()
  })

  it('answers a failure of the host with the typed refusal, which carries nothing the host wrote', () => {
    const throwing = (): never => { throw new Error('host-private-text') }
    const view = viewOf(new Proxy({}, { get: throwing, has: throwing, getOwnPropertyDescriptor: throwing, ownKeys: throwing }))
    for (const read of [() => (view as Record<string, unknown>).tokens, () => 'tokens' in view, () => Object.getOwnPropertyDescriptor(view, 'tokens'), () => Reflect.ownKeys(view)]) {
      expect(refusalOf(read)).toBe('AI_TOKENS_USAGE_MALFORMED the usage could not be read')
    }
  })

  it('refuses to list a Proxy that lists nothing, and lists an empty object and a Proxy that lists', () => {
    expect(refusalOf(() => Object.entries(viewOf(new Proxy({}, { get: () => 5 }))))).toBe('AI_TOKENS_USAGE_MALFORMED the usage holds an object that lists no field')
    expect(Object.entries(viewOf({}))).toEqual([])
    expect(Object.entries(viewOf(new Proxy({ a: 1 }, {})))).toEqual([['a', 1]])
  })
})
