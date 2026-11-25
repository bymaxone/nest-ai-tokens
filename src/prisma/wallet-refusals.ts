/**
 * @fileoverview The two typed refusals the wallet statements raise: a reserved entry key that another entry holds, and a refund to its
 * source that the debit or the amount cannot take. Pure constructors with no query and no transaction, kept out of `./wallet-writes`
 * so that file holds only what PostgreSQL judges and these are mutated and unit tested.
 * @layer prisma
 */

// By package specifier, as the store does: see the note on its own import.
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { attachCause } from '../server/errors/attach-cause'
import { setErrorMessage } from '../server/errors/set-error-message'
import { RESERVED_KEY_HELD_MESSAGE, RESERVED_KEY_HELD_REASON } from '../server/utils/wallet-keys'

/**
 * The refusal for a reserved key that another entry holds. The body names the code and a fixed reason; the wallet,
 * key and grant ride on the cause, for the server-side log, because the body is what a client receives.
 */
export function reservedKeyHeld(walletId: string, key: string, grantId: string): AiTokensException {
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and cause text are internal diagnostics; tests check the code and the identifiers
  return attachCause(
    setErrorMessage(new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: RESERVED_KEY_HELD_REASON }), RESERVED_KEY_HELD_MESSAGE),
    new Error(`wallet ${walletId}: the reserved key ${key} of grant ${grantId} is held by an entry the store did not write`),
  )
}

/** The refusal of a refund to its source that the debit, or the amount, cannot take: a typed configuration error, never a driver error. */
export function sourceRefusal(reason: string): AiTokensException {
  return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
}
