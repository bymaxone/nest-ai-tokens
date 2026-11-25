/**
 * @fileoverview The two refusals the wallet statements raise are typed configuration errors whose body is fixed, and a reserved-key refusal
 * keeps the wallet, key and grant on its cause only, so what a client receives never names them.
 * @layer prisma
 */

import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { RESERVED_KEY_HELD_MESSAGE, RESERVED_KEY_HELD_REASON } from '../server/utils/wallet-keys'
import { reservedKeyHeld, sourceRefusal } from './wallet-refusals'

/** The error body of an exception, as a client receives it. */
function bodyOf(error: AiTokensException): { code: string; message: string; details: unknown } {
  return (error.getResponse() as { error: { code: string; message: string; details: unknown } }).error
}

describe('sourceRefusal', () => {
  it('is an AI_TOKENS_INVALID_CONFIG exception that carries the reason it was given', () => {
    /**
     * Arrange: a reason text.
     * Act: build the refusal.
     * Assert: it is the library exception, with the invalid-config code and exactly that reason.
     * Why: the services map this code to a client refusal, and a driver error here would be a 500.
     */
    const error = sourceRefusal('a reason')
    expect(error).toBeInstanceOf(AiTokensException)
    expect(bodyOf(error).code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(bodyOf(error).details).toEqual({ reason: 'a reason' })
  })
})

describe('reservedKeyHeld', () => {
  it('names the code, the fixed reason and the fixed message in the body', () => {
    /**
     * Arrange: a wallet, a key and a grant.
     * Act: build the refusal.
     * Assert: the code is invalid-config, the details hold the fixed reason, and the message is the fixed one.
     * Why: the body is what a client receives.
     */
    const error = reservedKeyHeld('w-1', 'activation:g-1', 'g-1')
    expect(error).toBeInstanceOf(AiTokensException)
    expect(bodyOf(error).code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(bodyOf(error).details).toEqual({ reason: RESERVED_KEY_HELD_REASON })
    expect(error.message).toBe(RESERVED_KEY_HELD_MESSAGE)
  })

  it('keeps the wallet, key and grant on the non-enumerable cause and out of the body', () => {
    /**
     * Arrange: identifiers that are easy to find in a serialized body.
     * Act: build the refusal and serialize it.
     * Assert: the cause names all three, and the JSON form names none of them.
     * Why: the identifiers are for the server-side log only.
     */
    const error = reservedKeyHeld('wallet-77', 'key-88', 'grant-99')
    expect(error.cause).toBeInstanceOf(Error)
    const text = (error.cause as Error).message
    expect(text).toContain('wallet-77')
    expect(text).toContain('key-88')
    expect(text).toContain('grant-99')
    const body = JSON.stringify(error.getResponse()) + error.message
    expect(body).not.toMatch(/wallet-77|key-88|grant-99/)
  })
})
