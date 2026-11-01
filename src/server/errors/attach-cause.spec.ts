/**
 * @fileoverview Pins how a failure's original error rides on the typed exception: as the standard
 * `cause`, readable by a server-side log and never part of the response body.
 * @layer server
 */
import { AiTokensException } from './ai-tokens-exception'
import { attachCause } from './attach-cause'

describe('attachCause', () => {
  /** The original error is readable as `cause`, and the same exception is returned. */
  it('attaches the original error as the cause and returns the exception', () => {
    const original = new Error('connect ECONNREFUSED db.internal:5432')
    const exception = new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {})
    expect(attachCause(exception, original)).toBe(exception)
    expect(exception.cause).toBe(original)
  })

  /** The response body and the serialized exception carry no trace of the cause. */
  it('keeps the cause out of the response body and out of JSON', () => {
    const exception = attachCause(new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {}), new Error('SELECT secret FROM wallets'))
    expect(JSON.stringify(exception.getResponse())).not.toContain('secret')
    expect(JSON.stringify(exception)).not.toContain('secret')
    expect(Object.keys(exception)).not.toContain('cause')
  })

  /** A value that is not an Error (a string, null) is kept as it was thrown. */
  it.each([['driver text'], [null], [42]])('keeps a non-error cause %p as thrown', (value) => {
    expect(attachCause(new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {}), value).cause).toBe(value)
  })
})
