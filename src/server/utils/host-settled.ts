/**
 * @fileoverview The one way a promise a host store returned is waited for on a decision path. A chain on it (`.then`, `.catch`, `.finally`)
 * returns a promise built by `Promise[Symbol.species]`, which is read live on every call, so a host that plants it decides what the chain
 * resolves to. The wait here is a native `await`, between two checks of the realm, and after a synchronous check of the promise itself
 * ({@link refusesPromise}): a native `await` reads the `constructor` of a native promise, which a host can plant for the one read.
 * @layer server
 */

import { AiTokensException } from '../errors'
import { refusesPromise } from '../../shared/utils/native-promise'
import { assertCleanRealm } from './prototype-guard'

/**
 * Waits for a host promise.
 *
 * @param pending What the host returned.
 * @returns What it resolved with.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the realm is polluted before or after the wait, or the promise is not one a native `await` runs alone; what the host rejected with, unchanged.
 */
export async function settled<T>(pending: PromiseLike<T>): Promise<T> {
  assertCleanRealm()
  // Stryker disable next-line ObjectLiteral,StringLiteral: error reason is an internal diagnostic; tests check the code
  if (refusesPromise(pending)) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'a promise a host returned reads a constructor or then of its own' })
  const value = await pending
  assertCleanRealm()
  return value
}
