/**
 * @fileoverview The one way a promise a host store returned is waited for on a decision path. A chain on it (`.then`, `.catch`, `.finally`)
 * returns a promise built by `Promise[Symbol.species]`, which is read live on every call, so a host that plants it decides what the chain
 * resolves to. The wait here is a native `await`, between two checks of the realm, and after a synchronous check of the promise itself
 * ({@link refusesPromise}): a native `await` reads the `constructor` of a native promise, which a host can plant for the one read.
 * @layer server
 */

import { types } from 'node:util'
import { AiTokensException } from '../errors'
import { absorbRejection, refusesPromise } from '../../shared/utils/native-promise'
import { assertCleanRealm } from './prototype-guard'

/**
 * Waits for a host promise.
 *
 * @param pending What the host returned: a promise, or a value that is no promise.
 * @param refuseProxyAnswer `true` for the function `meter()` runs, whose answer may not be a Proxy: resolving it reads a `then` through a trap, which is code of the host. Every other call takes the answer as 1.1.22 did.
 * @returns What it resolved with.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the realm is polluted before or after the wait, or the promise is a native one with a `constructor` or `then` of its own, or a Proxy; what the host rejected with, unchanged.
 */
export async function settled<T>(pending: T | PromiseLike<T>, refuseProxyAnswer = false): Promise<T> {
  try {
    assertCleanRealm()
  } catch (error) {
    // The host's promise exists already and nothing will wait for it: its rejection is marked handled, or it would end the process.
    absorbRejection(pending, true, types.isProxy)
    throw error
  }
  // Stryker disable next-line ObjectLiteral,StringLiteral: error reason is an internal diagnostic; tests check the code
  if (refusesPromise(pending, true, types.isProxy)) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'what a host returned reads a constructor or then of its own, or the arrays the library reads were replaced' })
  const value = await pending
  assertCleanRealm()
  // The value is resolved into the promise this function returns, which reads its `then`: nothing of the host runs between this check and that read.
  // Stryker disable next-line ObjectLiteral,StringLiteral: error reason is an internal diagnostic; tests check the code
  if (refusesPromise(value, false, refuseProxyAnswer ? types.isProxy : () => false)) throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'what a host resolved with has a then of its own, or the arrays the library reads were replaced' })
  return value
}
