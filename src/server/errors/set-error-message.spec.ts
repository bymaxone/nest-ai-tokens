/**
 * @fileoverview Pins how a typed exception takes a message of its own: in its body and in the `message` a
 * log prints, on that instance only, with the code, the details and every other exception left alone.
 * @layer server
 */
import { AiTokensException } from './ai-tokens-exception'
import { setErrorMessage } from './set-error-message'

const DEFAULT_INVALID_CONFIG_MESSAGE = 'The AI tokens module configuration is invalid; check markup, limits, currency/fx, and store port methods.'

/** The `error.message` of the body an exception returns. */
function bodyMessage(exception: AiTokensException): string {
  return (exception.getResponse() as { error: { message: string } }).error.message
}

describe('setErrorMessage', () => {
  /** The body carries the new message, and the code and the details are untouched. */
  it('replaces the message in the body and keeps the code and the details', () => {
    const exception = new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'fixed reason' })
    expect(setErrorMessage(exception, 'A message for this case')).toBe(exception)
    expect(exception.getResponse()).toEqual({
      error: { code: 'AI_TOKENS_INVALID_CONFIG', message: 'A message for this case', details: { reason: 'fixed reason' } },
    })
  })

  /** What a log prints for the exception matches the body, instead of a name derived from the class. */
  it('sets the message a log prints to the same text as the body', () => {
    const exception = setErrorMessage(new AiTokensException('AI_TOKENS_INVALID_CONFIG'), 'A message for this case')
    expect(exception.message).toBe('A message for this case')
    expect(exception.message).toBe(bodyMessage(exception))
  })

  /** The body object is built per instance, so an exception made after one was edited keeps the code's own message. */
  it('leaves an exception built before or after it, with the same code, on the default message', () => {
    const before = new AiTokensException('AI_TOKENS_INVALID_CONFIG')
    setErrorMessage(new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'r' }), 'A message for this case')
    const after = new AiTokensException('AI_TOKENS_INVALID_CONFIG')
    expect(bodyMessage(before)).toBe(DEFAULT_INVALID_CONFIG_MESSAGE)
    expect(bodyMessage(after)).toBe(DEFAULT_INVALID_CONFIG_MESSAGE)
    expect(after.message).not.toBe('A message for this case')
  })

  /** The details object the caller passed is not the body's, so editing the message never edits it. */
  it('does not touch the details object the caller passed', () => {
    const details = { reason: 'fixed reason' }
    setErrorMessage(new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, details), 'A message for this case')
    expect(details).toEqual({ reason: 'fixed reason' })
  })
})
