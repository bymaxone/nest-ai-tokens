/**
 * @fileoverview The shape of an error code that may be repeated: an upper-case identifier of at most 32 characters, anchored at
 * both ends, and nothing else.
 * @layer server
 */

import { isCodeShaped } from './error-code-shape'

describe('isCodeShaped', () => {
  it.each(['P', 'P2010', 'ECONNREFUSED', 'AI_TOKENS_STORE_ERROR', `P${'X'.repeat(31)}`])('accepts %p', (code) => {
    expect(isCodeShaped(code)).toBe(true)
  })

  /** A value around a code, a lower-case or digit start, a 33-character code and a non-string are not codes. */
  it.each(['', 'p2010', '2010', 'P2010 x', 'x P2010', 'P2010\nx', `P${'X'.repeat(32)}`, 57, null, undefined, {}])('refuses %p', (code) => {
    expect(isCodeShaped(code)).toBe(false)
  })
})
