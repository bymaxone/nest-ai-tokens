/**
 * @fileoverview The token by which the interceptor learns that the row of its own `record()` call reached the ledger.
 * @layer server
 */

/** Told once the row of the call it was passed to is in the ledger. Only {@link appendWatch} makes one. */
class AppendWatch {
  #appended = false

  /** Whether the row is in the ledger. */
  get appended(): boolean {
    return this.#appended
  }

  /** Note that the row is in the ledger. */
  mark(): void {
    this.#appended = true
  }

  /** A brand test, so that a value that is not a watch is neither read nor called. */
  static is(value: unknown): value is AppendWatch {
    return typeof value === 'object' && value !== null && #appended in value
  }
}

/**
 * A watch to hand to one `record()` call.
 *
 * @returns A watch whose row is not yet in the ledger.
 */
export function appendWatch(): AppendWatch {
  return new AppendWatch()
}

/** Whether a value is a watch made by {@link appendWatch}. */
export function isAppendWatch(value: unknown): value is AppendWatch {
  return AppendWatch.is(value)
}
