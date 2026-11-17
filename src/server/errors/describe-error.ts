/**
 * @fileoverview The one way a caught error is written to a log line: its `name` and, when it is a typed error, its code, or else
 * a `code` that has the shape of one. Never its message, whose text a driver or a host may have written, and never the full
 * object, whose fields may carry connection details.
 * @layer server
 */

import { AiTokensException } from './ai-tokens-exception'
import { isCodeShaped } from './error-code-shape'

/**
 * Summarise a caught error for a log line.
 *
 * @param error The caught value, not necessarily an `Error`.
 * @returns `name=… code=…`, or a fixed marker for a value that is not an `Error`.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'non-Error rejection'
  const code = error instanceof AiTokensException ? (error.getResponse() as { error: { code: string } }).error.code : (error as { code?: unknown }).code
  return `name=${error.name}${isCodeShaped(code) ? ` code=${code}` : ''}`
}
