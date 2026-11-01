/**
 * @fileoverview Lets `record()` tell the ledger which model the idempotency payload hash is
 * computed over when the stored model differs from the one the response carried. The model a
 * response did not name is filled in from `baseModel` before the row is stored, but the hash keeps
 * the response's own (empty) model, so a retry finds a row stored without the fill and two
 * different calls under one key still conflict. The value travels beside the append input, not in
 * it, so no public signature or stored field carries it.
 * @layer server
 */

const hashedModels = new WeakMap<object, string>()

/**
 * Mark an append input with the model its payload hash is computed over.
 *
 * @param input The ledger append input about to be stored.
 * @param model The model the response carried (possibly empty).
 * @returns The same input.
 */
export function withHashedModel<T extends object>(input: T, model: string): T {
  hashedModels.set(input, model)
  return input
}

/**
 * Read the model an append input's payload hash is computed over.
 *
 * @param input The ledger append input.
 * @returns The marked model, or `undefined` when the stored model is the hashed one.
 */
export function hashedModelOf(input: object): string | undefined {
  return hashedModels.get(input)
}
