/**
 * @fileoverview Gives one typed exception a message of its own, in its body and in the `message` a log
 * prints. The body's message of an `AiTokensException` comes from its code, and a few refusals need
 * words the code's message does not have. The constructor stays as it is, so nothing is added to the
 * public surface; the instance's own body and `message` are edited instead. This module imports no class: the PostgreSQL entry point is bundled on its own
 * and copies whatever it imports by a relative path.
 * @layer server
 */

/**
 * Set `error.message` in the body that `exception.getResponse()` returns, and the exception's `message`.
 *
 * @param exception A typed exception whose body is the canonical `{ error: { code, message, details } }`.
 * @param message The message for this case: fixed text, never an identifier or request data.
 * @returns `exception`, for use in a `throw` expression.
 */
export function setErrorMessage<T extends { getResponse(): unknown; message: string }>(exception: T, message: string): T {
  const body = exception.getResponse() as { error: { message: string } }
  body.error.message = message
  exception.message = message
  return exception
}
