/**
 * @fileoverview The log summary of a caught error carries its name and a code that is safe to repeat, and never its message or
 * any other text a driver or a host wrote.
 * @layer server
 */

import { AiTokensException } from './ai-tokens-exception'
import { describeError } from './describe-error'

const SECRET = 'password=s3cr3t-token'

describe('describeError', () => {
  /** The name and a code of the shape of one are kept; the message with the secret is not. */
  it.each([
    [Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED' }), 'name=Error code=ECONNREFUSED'],
    [Object.assign(new TypeError(SECRET), { code: 'P2010' }), 'name=TypeError code=P2010'],
    [new Error(SECRET), 'name=Error'],
  ])('keeps the name and a code-shaped code of %#', (error, expected) => {
    expect(describeError(error)).toBe(expected)
  })

  /** A code that is a sentence, carries a value, is a number or is an object is left out. */
  it.each(['ECONNREFUSED 10.0.0.5', `P2010 ${SECRET}`, 'p2010', '57P01', 57, { host: 'db' }, undefined])('leaves out the code %p', (code) => {
    expect(describeError(Object.assign(new Error(SECRET), { code }))).toBe('name=Error')
  })

  /** A typed error is described by its own code, not by its message or its details. */
  it('describes a typed error by its code', () => {
    const typed = new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, { reason: SECRET, code: 'P2010' })
    expect(describeError(typed)).toBe('name=AiTokensException code=AI_TOKENS_STORE_ERROR')
  })

  /** A value that is not an error is not dumped. */
  it.each([{ password: 'secret' }, SECRET, null, 5])('does not dump %p', (value) => {
    expect(describeError(value)).toBe('non-Error rejection')
  })
})
