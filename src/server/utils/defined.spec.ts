/**
 * @fileoverview The copy without `undefined` fields that optional spreads are built with.
 * @layer server
 */
import { defined } from './defined'

describe('defined', () => {
  /** An `undefined` field is no key at all; every other value, however falsy, stays. */
  it('leaves out the undefined fields and keeps every other value', () => {
    const copy = defined({ gone: undefined, nil: null, zero: 0, empty: '', no: false })
    expect(Object.keys(copy)).toEqual(['nil', 'zero', 'empty', 'no'])
    expect(copy).toStrictEqual({ nil: null, zero: 0, empty: '', no: false })
  })

  /** Spread over an object that has the field, a left-out field does not overwrite it. */
  it('does not overwrite an earlier field when spread', () => {
    expect({ preset: 'kept', ...defined({ preset: undefined }) }).toStrictEqual({ preset: 'kept' })
  })

  /** The caller's object is left as it was. */
  it('does not change the object it was given', () => {
    const fields = { gone: undefined, here: 1 }
    defined(fields)
    expect(Object.keys(fields)).toEqual(['gone', 'here'])
  })
})
