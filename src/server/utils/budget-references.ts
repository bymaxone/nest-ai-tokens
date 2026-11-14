/**
 * @fileoverview The reference name that marks a budget movement as held by a ledger row.
 * @layer server
 */

/**
 * The name of the reference the call whose ledger row stands holds on a budget movement. Every other reference is
 * named by the attempt that took it and is dropped when the attempt fails.
 */
export const COMMITTED_REFERENCE = 'row'

/** The prefix of a hold's budget reservation key. */
export const RESERVE_KEY_PREFIX = 'reserve:'

/** The prefix of an enforced record's budget consumption key. */
export const RECORD_KEY_PREFIX = 'record:'

/** The application key of a hold's budget reservation: one per hold key, so every attempt at the hold shares it. */
export function reserveKey(ledgerKey: string): string {
  return `${RESERVE_KEY_PREFIX}${ledgerKey}`
}

/** The application key of a `record({ enforce: true })` call's budget consumption: one per call key. */
export function recordKey(callKey: string): string {
  return `${RECORD_KEY_PREFIX}${callKey}`
}

/** The prefix of the application a capture's settlement moves, followed by the record id. */
export const CAPTURE_KEY_PREFIX = 'capture:'

/** The prefix of the application a reversal moves, followed by the id of the record it reverses. */
export const REVERSE_KEY_PREFIX = 'reverse:'

/** The prefix of the application of a hold's reservation released without one, followed by the reservation's own key. */
export const RELEASE_KEY_PREFIX = 'release:reserve:'
