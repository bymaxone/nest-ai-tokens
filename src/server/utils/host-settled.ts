/**
 * @fileoverview The one way a promise a host store returned is waited for on a decision path. A chain on it (`.then`, `.catch`, `.finally`)
 * returns a promise built by `Promise[Symbol.species]`, which is read live on every call, so a host that plants it decides what the chain
 * resolves to. The wait here is a native `await`, between two checks of the realm: the library does not go on beside a polluted one.
 * @layer server
 */

import { assertCleanRealm } from './prototype-guard'

/**
 * Waits for a host promise.
 *
 * @param pending What the host returned.
 * @returns What it resolved with.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the realm is polluted before or after the wait; what the host rejected with, unchanged.
 */
export async function settled<T>(pending: PromiseLike<T>): Promise<T> {
  assertCleanRealm()
  const value = await pending
  assertCleanRealm()
  return value
}
