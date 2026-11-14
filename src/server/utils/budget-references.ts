/**
 * @fileoverview The reference name that marks a budget movement as held by a ledger row.
 * @layer server
 */

/**
 * The name of the reference the call whose ledger row stands holds on a budget movement. Every other reference is
 * named by the attempt that took it and is dropped when the attempt fails.
 */
export const COMMITTED_REFERENCE = 'row'
