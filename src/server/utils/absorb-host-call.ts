/**
 * @fileoverview The one way a call into the host's own code that must not fail the library's operation is made: a sink, a callback.
 * A host function that throws, returns a promise that rejects, or hands back a thenable whose `then` throws would otherwise end a
 * metering call whose record is already written, or leave a rejection nobody handles. The failure is written as one log line
 * that carries the error's name and code and never its message, and the operation goes on.
 * @layer server
 */

import type { Logger } from '@nestjs/common'
import { describeError } from '../errors/describe-error'

/**
 * Write the line of an absorbed failure. The logger is the host's too (a `LoggerService` of Nest can throw), and a line that cannot be
 * written is dropped: the failure it reports has already been absorbed, and nothing else may fail on its account.
 *
 * @param logger The logger that writes the line.
 * @param key The stable log key of the line.
 * @param error What the host's call threw or rejected with.
 */
function warnFailure(logger: Logger, key: string, error: unknown): void {
  try {
    logger.warn(`${key} ${describeError(error)}`)
  } catch {
    // The line is dropped.
  }
}

/**
 * Call a host function without letting its failure escape, and without waiting for it.
 *
 * @param logger The logger that writes the line of a failure.
 * @param key The stable log key of the line.
 * @param call The call into the host, which may throw or return a promise or thenable.
 */
export function absorbHostCall(logger: Logger, key: string, call: () => unknown): void {
  try {
    // A value that is not a thenable resolves at once; one whose `then` getter throws or whose `then` rejects is a rejected promise.
    Promise.resolve(call()).catch((error: unknown) => {
      warnFailure(logger, key, error)
    })
  } catch (error) {
    warnFailure(logger, key, error)
  }
}

/**
 * Call a host function and wait for it, without letting its failure escape.
 *
 * @param logger The logger that writes the line of a failure.
 * @param key The stable log key of the line.
 * @param call The call into the host, which may throw or return a promise or thenable.
 * @returns A promise that always resolves, once the host function has finished or failed.
 */
export async function absorbHostCallAndWait(logger: Logger, key: string, call: () => unknown): Promise<void> {
  try {
    await call()
  } catch (error) {
    warnFailure(logger, key, error)
  }
}

/**
 * Call a method of a host object without letting its failure escape, and without waiting for it. The method is looked up and called
 * inside the guard, so a getter that throws is absorbed too.
 *
 * @param logger The logger that writes the line of a failure.
 * @param key The stable log key of the line.
 * @param target The host object.
 * @param method The name of its method.
 * @param args The arguments of the call.
 * @param optional Whether the host may leave the method out, in which case nothing is called.
 */
export function absorbHostMethod(logger: Logger, key: string, target: object, method: string, args: readonly unknown[], optional = false): void {
  absorbHostCall(logger, key, () => {
    const fn = Reflect.get(target, method) as (() => unknown) | undefined
    return optional && fn === undefined ? undefined : Reflect.apply(fn as () => unknown, target, args)
  })
}
