/**
 * @fileoverview Pins the wallet entry keys the store keeps for itself: the key of the entry that credits a
 * grant, and the refusal of a caller's entry whose key is in that namespace.
 * @layer server
 */
import { AiTokensException } from '../errors'
import { ACTIVATION_KEY_PREFIX, activationKey, assertCallerKey } from './wallet-keys'

describe('wallet keys', () => {
  /** The activation key is the prefix and the grant id, so the store can look it up from the grant alone. */
  it('builds the activation key from the prefix and the grant id', () => {
    expect(ACTIVATION_KEY_PREFIX).toBe('activate:')
    expect(activationKey('grant-1')).toBe('activate:grant-1')
  })

  /** Every key that starts with the prefix is refused, including the bare prefix. */
  it.each(['activate:grant-1', 'activate:', 'activate:activate:x'])('refuses the caller key %s', (key) => {
    expect(() => assertCallerKey(key)).toThrow(AiTokensException)
  })

  /** The refusal is a typed configuration error a caller can read. */
  it('refuses with AI_TOKENS_INVALID_CONFIG', () => {
    try {
      assertCallerKey('activate:grant-1')
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(AiTokensException)
      expect((error as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_INVALID_CONFIG' } })
    }
  })

  /** Only a key that starts with the prefix is reserved; similar keys belong to the caller. */
  it.each(['activate', 'xactivate:grant-1', 'expiry:grant-1', 'allowance:u1:2026-11', ' activate:grant-1', 'Activate:grant-1'])(
    'accepts the caller key %s',
    (key) => {
      expect(() => assertCallerKey(key)).not.toThrow()
    },
  )
})
