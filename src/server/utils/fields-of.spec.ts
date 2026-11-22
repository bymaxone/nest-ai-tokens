/**
 * What `fieldsOf` keeps of an object a host supplied: the named fields it has, read as fields, in an object with no prototype. A field the
 * host left out, or set to `undefined` or `null`, is absent from the copy (not present with that value), and every other value, `false`,
 * `0` and the empty string included, is kept.
 * @layer server
 */
import { fieldsOf } from './field-names'

interface Shape {
  a?: unknown
  b?: unknown
  c?: unknown
  d?: unknown
  e?: unknown
}

const NAMES: { readonly [K in keyof Required<Shape>]: true } = { a: true, b: true, c: true, d: true, e: true }

describe('fieldsOf', () => {
  /** No object, no copy: a handler without metadata stays without. */
  it('returns undefined for no object', () => {
    expect(fieldsOf<Shape>(undefined, NAMES)).toBeUndefined()
  })

  /** A field set to `undefined` or `null` is as absent as one left out: the key is not on the copy at all. */
  it('leaves out a field the host omitted or set to undefined or null', () => {
    const copy = fieldsOf<Shape>({ a: undefined, b: null, c: 1 }, NAMES) as Record<string, unknown>
    expect(Object.keys(copy)).toEqual(['c'])
    expect('a' in copy).toBe(false)
    expect('b' in copy).toBe(false)
    expect('d' in copy).toBe(false)
  })

  /** A falsy value the host chose is a value: a declared `false` must stay `false`, never fall back to the default. */
  it('keeps false, 0 and the empty string', () => {
    const copy = fieldsOf<Shape>({ a: false, b: 0, c: '' }, NAMES) as Record<string, unknown>
    expect(Object.keys(copy)).toEqual(['a', 'b', 'c'])
    expect(copy).toEqual(expect.objectContaining({ a: false, b: 0, c: '' }))
  })

  /** The copy has no prototype, so a later read of it cannot find a key planted on `Object.prototype`. */
  it('holds the fields in an object with no prototype, and reads nothing planted', () => {
    Object.defineProperty(Object.prototype, 'e', { value: 'planted', configurable: true, writable: true, enumerable: false })
    try {
      const copy = fieldsOf<Shape>({ a: 1 }, NAMES) as Record<string, unknown>
      expect(Object.getPrototypeOf(copy)).toBeNull()
      expect(copy.e).toBeUndefined()
      expect(Object.keys(copy)).toEqual(['a'])
    } finally {
      Reflect.deleteProperty(Object.prototype, 'e')
    }
  })
})
