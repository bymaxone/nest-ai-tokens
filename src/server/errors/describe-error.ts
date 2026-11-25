/**
 * @fileoverview The one way a caught error is written to a log line: its `name` and, when it is a typed error, its code, or else
 * a `code` that has the shape of one. Never its message, whose text a driver or a host may have written, and never the full
 * object, whose fields may carry connection details.
 * @layer server
 */

import { AiTokensException } from './ai-tokens-exception'
import { isCodeShaped } from './error-code-shape'

/** The code-shaped code of an `Error`; the reads throw when the error's own do. */
function readCode(error: Error): string | undefined {
  const code = error instanceof AiTokensException ? (error.getResponse() as { error: { code: string } }).error.code : (error as { code?: unknown }).code
  return isCodeShaped(code) ? code : undefined
}

/**
 * The code of a caught error when it has one: a typed error's own code, else a `code` of the shape of one.
 *
 * @param error The caught value, not necessarily an `Error`.
 * @returns The code, or `undefined` for a value without one or that cannot be read.
 */
export function errorCodeOf(error: unknown): string | undefined {
  // A host's error may hold accessors, or be a Proxy, whose reads throw.
  try {
    return error instanceof Error ? readCode(error) : undefined
  } catch {
    return undefined
  }
}

/**
 * Summarise a caught error for a log line.
 *
 * @param error The caught value, not necessarily an `Error`.
 * @returns `name=… code=…`, or a fixed marker for a value that is not an `Error` or cannot be read.
 */
export function describeError(error: unknown): string {
  // A host's error may hold accessors, or be a Proxy, whose reads throw; the line that describes it must never be the thing that fails.
  try {
    if (!(error instanceof Error)) return 'non-Error rejection'
    const code = readCode(error)
    return `name=${error.name}${code !== undefined ? ` code=${code}` : ''}`
  } catch {
    return 'unreadable error'
  }
}
