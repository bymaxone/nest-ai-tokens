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

  /** A bigint must never canonicalize to the same text as the equal number (exactly-once). */
  it('distinguishes a bigint from the equal number', () => {
    expect(deriveIdempotencyKey(42n)).not.toBe(deriveIdempotencyKey(42))
    expect(deriveIdempotencyKey({ v: 42n })).not.toBe(deriveIdempotencyKey({ v: 42 }))
  })

  /** A bigint must never canonicalize to the same text as the equal numeric string. */
  it('distinguishes a bigint from the equal numeric string', () => {
    expect(deriveIdempotencyKey(42n)).not.toBe(deriveIdempotencyKey('42'))
    expect(deriveIdempotencyKey({ v: 42n })).not.toBe(deriveIdempotencyKey({ v: '42' }))
  })

  /** A bigint round-trips deterministically: equal bigints derive equal keys. */
  it('derives a stable key for equal bigints', () => {
    fc.assert(
      fc.property(fc.bigInt(), (value) => {
        expect(deriveIdempotencyKey({ v: value })).toBe(deriveIdempotencyKey({ v: BigInt(value.toString()) }))
      }),
    )
  })

  /** Distinct bigints derive distinct keys (no cross-magnitude collision). */
  it('derives distinct keys for distinct bigints', () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt(), (a, b) => {
        fc.pre(a !== b)
        expect(deriveIdempotencyKey({ v: a })).not.toBe(deriveIdempotencyKey({ v: b }))
      }),
    )
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

  /** null and undefined both canonicalize to 'null' but must NOT match a real string. */
  it('distinguishes null from the string null', () => {
    // CE→false on the null/undefined guard would throw (null falls into the object branch);
    // this test catches the failure as an unhandled TypeError.
    expect(() => deriveIdempotencyKey({ v: null })).not.toThrow()
    // The canonical form of null must differ from the string "null".
    expect(deriveIdempotencyKey({ v: null })).not.toBe(deriveIdempotencyKey({ v: 'null' }))
  })

  /** Strings produce distinct hashes from null (kills CE→false on the string/boolean guard). */
  it('distinguishes a string value from null', () => {
    expect(deriveIdempotencyKey({ s: 'hello' })).not.toBe(deriveIdempotencyKey({ s: null }))
    expect(deriveIdempotencyKey({ s: '' })).not.toBe(deriveIdempotencyKey({ s: null }))
  })

  /**
   * A boolean value must canonicalize distinctly from null and from the other boolean.
   * Kills the surviving CE `typeof value === 'boolean' → false` on the string/boolean guard:
   * dropping the boolean operand makes a boolean fall through to the final `return 'null'`,
   * so `true`, `false`, and `null` would all collapse to the same canonical form and collide.
   */
  it('distinguishes boolean values from null and from each other', () => {
    expect(deriveIdempotencyKey({ flag: true })).not.toBe(deriveIdempotencyKey({ flag: null }))
    expect(deriveIdempotencyKey({ flag: true })).not.toBe(deriveIdempotencyKey({ flag: false }))
  })

  /** Array and object delimiters must be present so items cannot be confused with their joined form. */
  it('distinguishes multi-element arrays from single concatenated-string elements', () => {
    // If the comma separator in arrays is dropped, [1, 2] → "12" which could equal [12].
    expect(deriveIdempotencyKey([1, 2])).not.toBe(deriveIdempotencyKey([12]))
    // If the comma separator in objects is dropped, { a:1, b:2 } merges into an ambiguous form.
    expect(deriveIdempotencyKey({ a: 1, b: 2 })).not.toBe(deriveIdempotencyKey({ ab: '12' }))
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
