/**
 * @fileoverview Pins the wallet entry keys the store keeps for itself: the key of the entry that credits a
 * grant, and which caller keys are in that namespace.
 * @layer server
 */
import { ACTIVATION_KEY_PREFIX, RESERVED_KEY_REASON, activationKey, isReservedWalletKey } from './wallet-keys'

describe('wallet keys', () => {
  /** The activation key is the prefix and the grant id, so the store can look it up from the grant alone. */
  it('builds the activation key from the prefix and the grant id', () => {
    expect(ACTIVATION_KEY_PREFIX).toBe('activate:')
    expect(activationKey('grant-1')).toBe('activate:grant-1')
  })

  /** Every key that starts with the prefix is reserved, including the bare prefix. */
  it.each(['activate:grant-1', 'activate:', 'activate:activate:x'])('reserves the key %s', (key) => {
    expect(isReservedWalletKey(key)).toBe(true)
  })

  /** Only a key that starts with the prefix is reserved; similar keys belong to the caller. */
  it.each(['activate', 'xactivate:grant-1', 'expiry:grant-1', 'allowance:u1:2026-11', ' activate:grant-1', 'Activate:grant-1'])(
    'leaves the caller key %s alone',
    (key) => {
      expect(isReservedWalletKey(key)).toBe(false)
    },
  )

  /** The refusal names the prefix, so a caller can see which keys are the store's. */
  it('names the prefix in the reason', () => {
    expect(RESERVED_KEY_REASON).toContain('"activate:"')
  })
})
