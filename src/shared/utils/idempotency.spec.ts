import fc from 'fast-check'
import { deriveIdempotencyKey } from './idempotency'

describe('deriveIdempotencyKey', () => {
  /** The key is a lowercase hex SHA-256 digest. */
  it('returns a 64-character hex digest', () => {
    expect(deriveIdempotencyKey({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  /** Top-level key order must not change the derived key (the §8.4 stability rule). */
  it('is stable under top-level key order', () => {
    expect(deriveIdempotencyKey({ a: 1, b: 2 })).toBe(deriveIdempotencyKey({ b: 2, a: 1 }))
  })

  /** Nested key order must also not change the derived key. */
  it('is stable under nested key order', () => {
    const left = { outer: { a: 1, b: { c: 3, d: 4 } } }
    const right = { outer: { b: { d: 4, c: 3 }, a: 1 } }
    expect(deriveIdempotencyKey(left)).toBe(deriveIdempotencyKey(right))
  })

  /** Distinct payloads yield distinct keys. */
  it('is distinct for distinct payloads', () => {
    expect(deriveIdempotencyKey({ a: 1 })).not.toBe(deriveIdempotencyKey({ a: 2 }))
    expect(deriveIdempotencyKey({ a: 1 })).not.toBe(deriveIdempotencyKey({ b: 1 }))
  })

  /** Array order is significant (unlike object keys). */
  it('treats array order as significant', () => {
    expect(deriveIdempotencyKey([1, 2])).not.toBe(deriveIdempotencyKey([2, 1]))
  })

  /** bigint, Date, undefined members, and non-finite numbers serialize without throwing. */
  it('serializes bigint, Date, null, and drops undefined members', () => {
    const payload = {
      big: 42n,
      when: new Date('2026-07-01T00:00:00.000Z'),
      nothing: undefined,
      empty: null,
      flag: true,
      note: 'x',
    }
    expect(deriveIdempotencyKey(payload)).toMatch(/^[0-9a-f]{64}$/)
    // Dropping an undefined member equals omitting it entirely.
    expect(deriveIdempotencyKey({ a: 1, b: undefined })).toBe(deriveIdempotencyKey({ a: 1 }))
  })

  /** Arrays render undefined holes as null, and non-finite numbers as null. */
  it('normalizes undefined array elements and non-finite numbers to null', () => {
    expect(deriveIdempotencyKey([1, undefined, 3])).toBe(deriveIdempotencyKey([1, null, 3]))
    expect(deriveIdempotencyKey({ n: Number.NaN })).toBe(deriveIdempotencyKey({ n: null }))
  })

  /** Non-serializable values (functions, symbols) collapse to null rather than throwing. */
  it('collapses functions and symbols to null', () => {
    expect(deriveIdempotencyKey({ fn: () => 1 })).toBe(deriveIdempotencyKey({ fn: null }))
    expect(deriveIdempotencyKey(Symbol('x'))).toBe(deriveIdempotencyKey(undefined))
  })

  /** Shuffling object keys never changes the key, for any generated JSON object. */
  it('is invariant to key order for arbitrary objects', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (object) => {
        const shuffled = Object.fromEntries(Object.entries(object).reverse())
        expect(deriveIdempotencyKey(object)).toBe(deriveIdempotencyKey(shuffled))
      }),
    )
  })
})
