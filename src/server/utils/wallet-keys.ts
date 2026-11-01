/**
 * @fileoverview The wallet entry keys the store writes for itself. The entry that credits a grant that
 * was not due as it was appended carries the key `activate:<grantId>`, and the entry that removes an
 * expired grant's remainder carries `expiry:<grantId>`. The store takes the existence of the first as
 * proof that the grant was credited and writes the second once per grant, so a caller's entry may use
 * neither namespace: a caller entry holding the key would hide the credit, or stop the expiry from
 * leaving the balance. This module imports nothing from the server: the PostgreSQL entry point is
 * bundled on its own and takes the error class from the package root, so the class that refuses a key is
 * built by the store that calls this predicate.
 * @layer server
 */


/** The prefix of the key of the entry that credits a grant that was not due as it was appended. */
export const ACTIVATION_KEY_PREFIX = 'activate:'

/** The prefix of the key of the entry that removes the remainder of an expired grant. */
export const EXPIRY_KEY_PREFIX = 'expiry:'

/** Why a caller's entry key is refused. */
export const RESERVED_KEY_REASON = `wallet entry keys starting with "${ACTIVATION_KEY_PREFIX}" or "${EXPIRY_KEY_PREFIX}" are reserved`

/** The reason of the entry that credits a grant that was not due as it was appended. */
export const ACTIVATION_REASON = 'grant activated'

/** Why a debit is refused when an entry the store did not write holds a key the store needs. */
export const RESERVED_KEY_HELD_REASON = 'a reserved wallet entry key is held by an entry the store did not write'

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
 * The key of the entry that expires a grant.
 *
 * @param grantId The id of the grant entry.
 * @returns The idempotency key of its expiry entry.
 */
export function expiryKey(grantId: string): string {
  return `${EXPIRY_KEY_PREFIX}${grantId}`
}

/**
 * Whether a caller's entry key is in the namespace the store writes for itself.
 *
 * @param idempotencyKey The key the caller chose for the entry.
 * @returns `true` when the key starts with the activation or the expiry prefix.
 */
export function isReservedWalletKey(idempotencyKey: string): boolean {
  return idempotencyKey.startsWith(ACTIVATION_KEY_PREFIX) || idempotencyKey.startsWith(EXPIRY_KEY_PREFIX)
}
