/**
 * @fileoverview The view of a raw provider response that a normalizer reads. A normalizer takes the response as it is and reads the fields
 * of the provider by name, so the response is not copied: a copy that lists its keys drops what an object that answers by a `get` trap
 * holds. The view hands the normalizer each field the first time it is asked for, and the same value every time after, so a getter that
 * answers differently the second time cannot make a check pass on one value and a sum use another; an object whose key list is empty and
 * that is a Proxy is refused where a normalizer lists the keys of a map it does not know, a server-tool-use count, where an empty
 * list would price a tool as free.
 * @layer server
 */

import { types } from 'node:util'
import { AiTokensException } from '../errors'
import { isDate } from '../../shared/utils/is-date'
import { fieldNamesOf, fieldOf } from './field-names'

/** The typed refusal of a map that cannot be listed, which names nothing the host wrote. */
function unlistable(): AiTokensException {
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check the code and that the usage is refused
  return new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'the usage holds an object that lists no field' })
}

/** The views this module made: a view is a Proxy, and the test of a Proxy that lists nothing must not take the library's own for a host's. */
const views = new WeakSet()

/**
 * Whether `value` is a view this module made.
 *
 * @param value Any value.
 * @returns `true` for a view of a response, or of an object in it.
 */
export function isView(value: object): boolean {
  return views.has(value)
}

/** Whether a field is handed on through a view of its own: an object that is no list of bytes, no date and not a function. */
function isViewable(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !ArrayBuffer.isView(value) && !isDate(value)
}

/**
 * Run a read of the host's object, and answer a failure of it with the typed refusal, which names nothing the host wrote: the host's own
 * error never reaches whoever reads the view.
 *
 * @param read The read of the host's object.
 * @returns What the read answered.
 * @throws {AiTokensException} `AI_TOKENS_USAGE_MALFORMED` when the read throws.
 */
function guarded<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof AiTokensException) throw error
    // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check the code and that the usage is refused
    throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'the usage could not be read' })
  }
}

/**
 * A view of `raw` that answers every field with the value it answered the first time, and the objects in it with views of their own, one
 * view for each object.
 * The Proxy stands on an empty object of its own, never on the host's object: the engine checks the answer of a trap against its target,
 * and that check would call the host's own traps, whose errors would escape the view.
 *
 * @param raw The response, or an object in it.
 * @param viewed The views of this call, so that an object reached twice, or one that contains itself, has the one view; a view is never kept beyond its call.
 * @returns The view, which a normalizer reads like the object itself.
 */
export function viewOf<T extends object>(raw: T, viewed = new WeakMap<object, object>()): T {
  const known = viewed.get(raw)
  if (known !== undefined) return known as T
  const answered = new Map<string | symbol, unknown>()
  const isList = Array.isArray(raw)
  const view = new Proxy((isList ? [] : {}) as T, {
    get: (_target, key) =>
      guarded(() => {
        if (answered.has(key)) return answered.get(key)
        // A key that only the root of the prototype chain holds is not a field of the response.
        const value: unknown = typeof key === 'string' ? fieldOf(raw, key) : Reflect.get(raw, key)
        const answer = isViewable(value) ? viewOf(value, viewed) : value
        answered.set(key, answer)
        return answer
      }),
    getPrototypeOf: () => {
      // An object whose prototype cannot be read is read as one with none, so that testing the view with `instanceof` cannot fail.
      try {
        return Reflect.getPrototypeOf(raw)
      } catch {
        return null
      }
    },
    has: (_target, key) => guarded(() => Reflect.has(raw, key)),
    getOwnPropertyDescriptor: (_target, key) =>
      guarded(() => {
        const found = Reflect.getOwnPropertyDescriptor(raw, key)
        // The length of a list is the one property its stand-in cannot give up; every other property is reported as one that can be redefined.
        if (isList) return found === undefined ? undefined : { ...found, configurable: key === 'length' ? false : true }
        // A field of an object is listed whichever way it is defined, so it is reported as enumerable; one a class defines has no descriptor of its own.
        return found === undefined && !(typeof key === 'string' && Reflect.has(raw, key)) ? undefined : { ...(found ?? { value: undefined, writable: true }), enumerable: true, configurable: true }
      }),
    ownKeys: () =>
      guarded(() => {
        const keys = isList ? Reflect.ownKeys(raw) : fieldNamesOf(raw)
        if (keys.length === 0 && types.isProxy(raw)) throw unlistable()
        return keys
      }),
  })
  views.add(view)
  viewed.set(raw, view)
  return view
}
