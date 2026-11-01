/**
 * @fileoverview The wallet entry keys the store writes for itself. The entry that credits a grant that
 * was not due as it was appended carries the key `activate:<grantId>`, and the store treats the existence
 * of that key as the proof that the grant was credited, so a caller's entry may not use the namespace. Only
 * this prefix is reserved: an `expiry:` key is never taken as proof of anything, and refusing it as well
 * would refuse keys that hosts may already use.
 * @layer server
 */

import { AiTokensException } from '../errors'

/** The prefix of the key of the entry that credits a grant that was not due as it was appended. */
export const ACTIVATION_KEY_PREFIX = 'activate:'

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
 * Refuse a caller's entry whose key is in the namespace the store writes for itself.
 *
 * @param idempotencyKey The key the caller chose for the entry.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the key starts with the activation prefix.
 */
export function assertCallerKey(idempotencyKey: string): void {
  if (!idempotencyKey.startsWith(ACTIVATION_KEY_PREFIX)) return
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason text are internal diagnostics; tests check the error code only
  throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: `wallet entry keys starting with "${ACTIVATION_KEY_PREFIX}" are reserved` })
}
