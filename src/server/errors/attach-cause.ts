/**
 * @fileoverview Attaches the failure that produced a typed exception as its standard `cause`. The
 * response body of an `AiTokensException` is what a client receives, so the original error (which
 * can name a host, a statement or a row) rides only on the property a server-side log reads. This
 * module imports no class: the PostgreSQL entry point is bundled on its own and copies whatever it
 * imports by a relative path.
 * @layer server
 */

/**
 * Set `error.cause` to `cause` without making it enumerable, so it is not serialized with the exception.
 *
 * @param error The typed exception being thrown.
 * @param cause The failure that made it necessary, as it was thrown.
 * @returns `error`, for use in a `throw` expression.
 */
export function attachCause<T extends Error>(error: T, cause: unknown): T {
  Object.defineProperty(error, 'cause', { value: cause, enumerable: false, configurable: true, writable: true })
  return error
}
