/**
 * @fileoverview A plant on `Promise.prototype` that a host driver makes while its call runs and that undoes itself when it is first read: the
 * `constructor` getter answers `Object` once, and the `then` answers `forged` once, so a later check of the realm finds nothing.
 */

const prototype = Object.getPrototypeOf((async (): Promise<void> => undefined)()) as {
  constructor: unknown
  then: (...args: unknown[]) => unknown
}
const nativeThen = prototype.then
const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor') as PropertyDescriptor

/** Plant a `constructor` and `then` that hand `forged` to the next native `await` of a promise, the constructor answering for `reads` reads before it restores itself. */
export function plantOnce(forged: unknown, reads = 1): void {
  let left = reads
  Object.defineProperty(prototype, 'constructor', {
    configurable: true,
    get() {
      left -= 1
      if (left <= 0) Object.defineProperty(prototype, 'constructor', constructorDescriptor)
      return Object
    },
  })
  prototype.then = function (onFulfilled: unknown, onRejected: unknown): unknown {
    prototype.then = nativeThen
    return nativeThen.call(Promise.resolve(forged), onFulfilled, onRejected)
  }
}

/** Undo whatever of {@link plantOnce} the awaiting code did not read. */
export function unplant(): void {
  Object.defineProperty(prototype, 'constructor', constructorDescriptor)
  prototype.then = nativeThen
}
