/**
 * @fileoverview Pins the wallet entry keys the store keeps for itself: the key of the entry that credits a
 * grant, and which caller keys are in that namespace.
 * @layer server
 */
import {
  ACTIVATION_KEY_PREFIX,
  ACTIVATION_REASON,
  EXPIRY_KEY_PREFIX,
  RESERVED_KEY_HELD_REASON,
  RESERVED_KEY_REASON,
  activationKey,
  expiryKey,
  isReservedWalletKey,
} from './wallet-keys'

describe('wallet keys', () => {
  /** The activation key is the prefix and the grant id, so the store can look it up from the grant alone. */
  it('builds the activation key from the prefix and the grant id', () => {
    expect(ACTIVATION_KEY_PREFIX).toBe('activate:')
    expect(activationKey('grant-1')).toBe('activate:grant-1')
  })

  /** The expiry key is the prefix and the grant id, the identity the sweep writes once per grant. */
  it('builds the expiry key from the prefix and the grant id', () => {
    expect(EXPIRY_KEY_PREFIX).toBe('expiry:')
    expect(expiryKey('grant-1')).toBe('expiry:grant-1')
  })

  /** Every key that starts with either prefix is reserved, including the bare prefix. */
  it.each(['activate:grant-1', 'activate:', 'activate:activate:x', 'expiry:grant-1', 'expiry:', 'expiry:activate:x'])('reserves the key %s', (key) => {
    expect(isReservedWalletKey(key)).toBe(true)
  })

  /** Only a key that starts with the prefix is reserved; similar keys belong to the caller. */
  it.each(['activate', 'xactivate:grant-1', 'xexpiry:grant-1', 'expiry', 'allowance:u1:2026-11', ' activate:grant-1', 'Activate:grant-1', 'Expiry:grant-1'])(
    'leaves the caller key %s alone',
    (key) => {
      expect(isReservedWalletKey(key)).toBe(false)
    },
  )

  /** The refusal names both prefixes, so a caller can see which keys are the store's. */
  it('names the prefixes in the reason', () => {
    expect(RESERVED_KEY_REASON).toContain('"activate:"')
    expect(RESERVED_KEY_REASON).toContain('"expiry:"')
  })

  /**
   * The activation reason is part of the stored contract: the store recognises its own activation entry by it, and
   * the query that finds foreign rows matches on the same text, so the exact value is pinned.
   */
  it('pins the reason of the activation entry by value', () => {
    expect(ACTIVATION_REASON).toBe('grant activated')
  })

  /** The reason in the body of the refusal for a held key is fixed text with no identifier in it. */
  it('pins the reason of the held-key refusal by value', () => {
    expect(RESERVED_KEY_HELD_REASON).toBe('a reserved wallet entry key is held by an entry the store did not write')
  })
})
