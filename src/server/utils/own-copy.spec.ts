/**
 * @fileoverview What `ownCopy` keeps: the own keys of every plain object and the fields an instance of a class defines, in objects with no
 * prototype, to a bounded depth, and nothing the root of the realm supplies. Dates, Maps, bigints and the values past the depth are handed
 * on as they are.
 * @layer server
 */

import { runInNewContext } from 'node:vm'
import { ownCopy } from './own-copy'

describe('ownCopy', () => {
  /** The copy has no prototype, so a name it lacks is undefined however it is read. */
  it('copies a plain object into one with no prototype and keeps its own keys', () => {
    const copy = ownCopy({ a: 1, b: 'x', c: 2n })
    expect(Object.getPrototypeOf(copy)).toBeNull()
    expect(Object.keys(copy)).toEqual(['a', 'b', 'c'])
    expect(copy).toEqual(expect.objectContaining({ a: 1, b: 'x', c: 2n }))
  })

  it('copies the plain objects and the arrays inside it, element by element', () => {
    const copy = ownCopy({ scope: { type: 'user', id: 'u1' }, tags: [{ k: 1 }, 'x'] })
    expect(Object.getPrototypeOf(copy.scope)).toBeNull()
    expect(Array.isArray(copy.tags)).toBe(true)
    expect(Object.getPrototypeOf(copy.tags[0])).toBeNull()
    expect(copy.tags[1]).toBe('x')
  })

  it('does not copy a key inherited from the prototype of a plain object', () => {
    Object.defineProperty(Object.prototype, 'planted', { value: 1, configurable: true, writable: true, enumerable: true })
    try {
      const copy = ownCopy({ a: 1 }) as Record<string, unknown>
      expect(Object.keys(copy)).toEqual(['a'])
      expect(copy.planted).toBeUndefined()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'planted')
    }
  })

  /** A Date, a Map, a function and a primitive are not records: they are handed on as they are. */
  it('hands on a Date, a Map, a function and the primitives', () => {
    const date = new Date(0)
    const map = new Map([['k', 1]])
    const fn = (): number => 1
    expect(ownCopy(date)).toBe(date)
    expect(ownCopy(map)).toBe(map)
    expect(ownCopy(fn)).toBe(fn)
    expect(ownCopy(5)).toBe(5)
    expect(ownCopy(null)).toBeNull()
    expect(ownCopy(undefined)).toBeUndefined()
    expect(ownCopy('s')).toBe('s')
    expect(ownCopy(3n)).toBe(3n)
  })

  /** An instance of a class is a record too: its absent fields resolve through the class to the same root, so it is copied by its fields. */
  it('copies an instance of a class by its own fields and the getters and methods its class defines', () => {
    class Row {
      readonly id = 'r1'
      get derived(): number {
        return this.id.length
      }

      method(): number {
        return 1
      }
    }
    const copy = ownCopy(new Row()) as unknown as Record<string, unknown>
    expect(Object.getPrototypeOf(copy)).toBeNull()
    expect(copy.id).toBe('r1')
    expect(copy.derived).toBe(2)
    expect('method' in copy).toBe(true)
    expect(Object.keys(copy).sort()).toEqual(['derived', 'id', 'method'])
  })

  it('does not find a key planted on Object.prototype on the copy of an instance of a class', () => {
    class Row {
      readonly id = 'r1'
    }
    Object.defineProperty(Object.prototype, 'planted', { value: 1, configurable: true, writable: true, enumerable: false })
    try {
      const copy = ownCopy(new Row()) as unknown as Record<string, unknown>
      expect(copy.planted).toBeUndefined()
      expect(Object.keys(copy)).toEqual(['id'])
    } finally {
      Reflect.deleteProperty(Object.prototype, 'planted')
    }
  })

  it('copies a plain object of another realm and one with no prototype', () => {
    const foreign = runInNewContext('({ a: 1, nested: { b: 2 } })') as { a: number; nested: { b: number } }
    const copy = ownCopy(foreign)
    expect(Object.getPrototypeOf(copy)).toBeNull()
    expect(Object.getPrototypeOf(copy.nested)).toBeNull()
    const bare = Object.assign(Object.create(null) as object, { inner: { x: 1 } })
    expect(ownCopy(bare)).not.toBe(bare)
    expect(Object.getPrototypeOf(ownCopy(bare).inner)).toBeNull()
  })

  /** A record is a few levels deep: what is deeper is handed on as it is, which also ends a chain that loops. */
  it('copies to a bounded depth and hands on what is deeper', () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let level = 0; level < 12; level += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    let copy: Record<string, unknown> = ownCopy(deep)
    let depth = 0
    while (Object.getPrototypeOf(copy) === null && copy.next !== undefined) {
      copy = copy.next as Record<string, unknown>
      depth += 1
    }
    expect(depth).toBeGreaterThan(5)
    expect(depth).toBeLessThan(12)
  })
})

describe('ownCopy and a spoofed type tag', () => {
  /** The tag a value claims is no brand: a row that names itself a Date is still a record, and a tag planted on the root is on every row. */
  it('copies a row that claims to be a Date, whether it says so itself or the root does', () => {
    const own = { id: 'r1', [Symbol.toStringTag]: 'Date' }
    expect(Object.getPrototypeOf(ownCopy(own))).toBeNull()
    Object.defineProperty(Object.prototype, Symbol.toStringTag, { value: 'Map', configurable: true, writable: true, enumerable: false })
    try {
      const copy = ownCopy({ id: 'r2' })
      expect(Object.getPrototypeOf(copy)).toBeNull()
      expect(copy.id).toBe('r2')
      class Row {
        readonly id = 'r3'
      }
      expect(Object.getPrototypeOf(ownCopy(new Row()))).toBeNull()
    } finally {
      Reflect.deleteProperty(Object.prototype, Symbol.toStringTag)
    }
  })

  /** The built-in objects are recognised by what they are, not by what they say: each is handed on whatever the root says. */
  it('hands on a Date, a Map, a Set, a typed array and a buffer, of this realm and of another', () => {
    const values = [new Date(0), new Map(), new Set(), new WeakMap(), new WeakSet(), new Uint8Array(2), new ArrayBuffer(2), /x/u, runInNewContext('new Date(0)') as Date, runInNewContext('new Map()') as Map<unknown, unknown>]
    for (const value of values) expect(ownCopy(value)).toBe(value)
  })
})

describe('ownCopy and the state of a built-in it hands on', () => {
  /** Telling a RegExp from a record must not run it: a global RegExp keeps the `lastIndex` its owner set. */
  it('keeps the lastIndex of a global RegExp that crosses it', () => {
    const pattern = /x/g
    pattern.lastIndex = 3
    const copy = ownCopy({ pattern })
    expect(copy.pattern).toBe(pattern)
    expect(pattern.lastIndex).toBe(3)
  })
})
