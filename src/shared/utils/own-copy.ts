/**
 * @fileoverview The copy of an input that holds only what it has of its own. A store reads the optional names of an input with `??` (a
 * limit, a rate, a feature list), and a name the input lacks is then answered by the `Object.prototype` of its realm, where another
 * library, or prototype pollution, may have put a key. The copy has no prototype, so a name it lacks is `undefined` however it is read, and
 * nothing is read from the realm root to make it. Plain objects and arrays are copied to any depth a record has; a `Date`, a `bigint`
 * and an instance of a class are handed on as they are. It uses no Node built-in.
 * @layer shared
 */

/** The deepest level copied: an input of a store is a record with a record or a list in it, never a long chain. */
const MAX_DEPTH = 8

/** Whether `value` is a plain object of any realm, or one with no prototype: its prototype is none or the root that ends every chain. */
function isPlain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

/**
 * A copy of a value in which every plain object has no prototype and keeps its own enumerable string keys, and every array is copied
 * element by element.
 *
 * @param value Any value; an input a store takes.
 * @param depth The level of the value inside the input, for the limit.
 * @returns The copy, or the value itself when it is not a plain object or an array.
 */
export function ownCopy<T>(value: T, depth = 0): T {
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((element: unknown) => ownCopy(element, depth + 1)) as T
  if (!isPlain(value)) return value
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) copy[key] = ownCopy((value as Record<string, unknown>)[key], depth + 1)
  return copy as T
}
