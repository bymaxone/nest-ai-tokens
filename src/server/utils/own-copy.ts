/**
 * @fileoverview The copy of a value that holds only what it has: its own keys and, for an instance of a class, the fields its class chain
 * defines, never a key found only on the `Object.prototype` of its realm. A reader that asks an object for a name it lacks is otherwise
 * answered by that root, where another library, or prototype pollution, may have put a key, and a class instance is no exception: an absent
 * field resolves through its class to the same root. The copy has no prototype, so a name it lacks is `undefined` however it is read, and a
 * getter of a class is read once and counts as a field. Plain objects, instances of classes and arrays are copied to any depth a record has;
 * a `Date`, a `Map`, a typed array and the other built-in objects, a `bigint` and a function are handed on as they are.
 * @layer server
 */

import { fieldNamesOf, fieldOf } from './field-names'

/** The deepest level copied: a record a store takes or returns has a record or a list in it, never a long chain. */
const MAX_DEPTH = 8

/** Whether `value` is a plain object of any realm, or one with no prototype: its prototype is none or the root that ends every chain. */
function isPlain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

/**
 * A copy of a value in which every object that is a record (a plain object or an instance of a class) has no prototype and holds its own
 * fields and its class's, and every array is copied element by element.
 *
 * @param value Any value; an input a store takes or a row it returns.
 * @param depth The level of the value inside the record, for the limit.
 * @returns The copy, or the value itself when it is not a record or an array.
 * @throws {RangeError} When the prototype chain of a class instance is longer than a class hierarchy; whatever a getter of the value throws.
 */
export function ownCopy<T>(value: T, depth = 0): T {
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((element: unknown) => ownCopy(element, depth + 1)) as T
  // A Date, a Map, a typed array, a Promise and the like are not records, and their methods live on a prototype that must stay.
  if (Object.prototype.toString.call(value) !== '[object Object]') return value
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of isPlain(value) ? Object.keys(value) : fieldNamesOf(value)) copy[key] = ownCopy(fieldOf(value, key), depth + 1)
  return copy as T
}
