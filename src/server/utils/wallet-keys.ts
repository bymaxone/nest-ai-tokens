/**
 * @fileoverview The wallet entry keys the store writes for itself. The entry that credits a grant that
 * was not due as it was appended carries the key `activate:<grantId>`, and the store treats the existence
 * of that key as the proof that the grant was credited, so a caller's entry may not use the namespace. Only
 * this prefix is reserved: an `expiry:` key is never taken as proof of anything, and refusing it as well
 * would refuse keys that hosts may already use. This module imports nothing from the server: the
 * PostgreSQL entry point is bundled on its own and takes the error class from the package root, so the
 * class that refuses a key is built by the store that calls this predicate.
 * @layer server
 */

/** The prefix of the key of the entry that credits a grant that was not due as it was appended. */
export const ACTIVATION_KEY_PREFIX = 'activate:'

/** Why a caller's entry key is refused. */
export const RESERVED_KEY_REASON = `wallet entry keys starting with "${ACTIVATION_KEY_PREFIX}" are reserved`

/**
 * The key of the entry that credits a grant.
 *
 * @param grantId The id of the grant entry.
 * @returns The idempotency key of its activation entry.
 */
export function activationKey(grantId: string): string {
  return `${ACTIVATION_KEY_PREFIX}${grantId}`
}

/**
 * Whether a caller's entry key is in the namespace the store writes for itself.
 *
 * @param idempotencyKey The key the caller chose for the entry.
 * @returns `true` when the key starts with the activation prefix.
 */
export function isReservedWalletKey(idempotencyKey: string): boolean {
  return idempotencyKey.startsWith(ACTIVATION_KEY_PREFIX)
}
