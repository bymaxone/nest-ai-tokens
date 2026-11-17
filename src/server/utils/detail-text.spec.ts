/**
 * @fileoverview The bound on a supplied value that an error's details may carry: a string of at most 256 characters is kept as it
 * is, and a missing, non-string or longer value is left out rather than truncated or converted.
 * @layer server
 */

import { MAX_DETAIL_CHARS, suppliedDetails } from './detail-text'

describe('suppliedDetails', () => {
  it('keeps a string of up to the bound, and the bound itself', () => {
    expect(suppliedDetails({ a: 'x', b: 'y'.repeat(MAX_DETAIL_CHARS) })).toEqual({ a: 'x', b: 'y'.repeat(MAX_DETAIL_CHARS) })
  })

  it('leaves out a string one character over the bound', () => {
    expect(suppliedDetails({ a: 'x'.repeat(MAX_DETAIL_CHARS + 1) })).toEqual({})
  })

  it.each([undefined, null, 5, 5n, true, {}, [], () => 'x'])('leaves out a value that is not a string: %p', (value) => {
    expect(suppliedDetails({ a: value })).toEqual({})
  })

  it('keeps the empty string and leaves the other fields alone', () => {
    expect(suppliedDetails({ a: '', b: 5, c: 'z' })).toEqual({ a: '', c: 'z' })
  })

  it('is 256 characters', () => {
    expect(MAX_DETAIL_CHARS).toBe(256)
  })
})
