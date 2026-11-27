/**
 * @fileoverview The error a `RedisBudgetCounterStore` rejects with when a command of the client fails. The client's error is
 * not passed on: its message can echo the arguments of the command, and it keeps the command and its arguments as fields.
 * @layer redis
 */

import { isCodeShaped } from '../server/errors/error-code-shape'

/** A fixed message and, when the failure has one, its `code`. */
class CounterStoreError extends Error {
  declare readonly code?: string

  constructor(code: string | undefined) {
    super('counter command failed')
    this.name = 'CounterStoreError'
    if (code !== undefined) Object.assign(this, { code })
  }
}

/** The code of a failure: the first word of a reply of the server, else its `code`, kept only when it has the shape of a code. */
function codeOf(failure: unknown): string | undefined {
  let word: unknown
  try {
    const { name, message, code } = failure as { name?: unknown; message?: unknown; code?: unknown }
    word = name === 'ReplyError' ? String(message).split(' ', 1)[0] : code
  } catch {
    // A failure that cannot be read has no code.
  }
  return isCodeShaped(word) ? word : undefined
}

/**
 * The store's own error for a failed command.
 *
 * @param failure What the client rejected with.
 * @returns An error that carries nothing of `failure` but its code.
 */
export function commandFailure(failure: unknown): Error {
  return new CounterStoreError(codeOf(failure))
}
