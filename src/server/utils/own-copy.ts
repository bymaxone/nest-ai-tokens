/**
 * @fileoverview The copy of a value that holds only what it has: its own keys and, for an instance of a class, the fields its class chain
 * defines, never a key found only on the `Object.prototype` of its realm. A reader that asks an object for a name it lacks is otherwise
 * answered by that root, where another library, or prototype pollution, may have put a key, and a class instance is no exception: an absent
 * field resolves through its class to the same root. The copy has no prototype, so a name it lacks is `undefined` however it is read, and a
 * getter of a class is read once and counts as a field. Plain objects, instances of classes and arrays are copied to any depth a record has;
 * a `Date`, a `Map`, a typed array and the other built-in objects, known by their internal slot and not by the tag they claim, a `bigint` and a function are handed on as they are.
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

/** The brand tests of the built-in objects a record is never: each calls an intrinsic that throws unless its receiver has the internal slot. */
const BRANDS: readonly ((value: object) => unknown)[] = [
  (value) => Date.prototype.getTime.call(value),
  (value) => Map.prototype.has.call(value, 0),
  (value) => Set.prototype.has.call(value, 0),
  (value) => WeakMap.prototype.has.call(value, BRANDS),
  (value) => WeakSet.prototype.has.call(value, BRANDS),
  (value) => RegExp.prototype.test.call(value, ''),
  (value) => ArrayBuffer.prototype.slice.call(value, 0, 0),
  (value) => {
    if (!ArrayBuffer.isView(value)) throw new TypeError()
  },
]

/**
 * Whether `value` is a built-in object that is handed on whole. It is known by its internal slot, never by the tag it claims: an own
 * `Symbol.toStringTag`, or one planted on `Object.prototype`, names any record a Date or a Map. A plain object is none, so only the other
 * objects are tested.
 */
function isBuiltIn(value: object): boolean {
  return BRANDS.some((brand) => {
    try {
      brand(value)
      return true
    } catch {
      return false
    }
  })
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
  const plain = isPlain(value)
  // A Date, a Map, a typed array and the like are not records, and their methods live on a prototype that must stay.
  if (!plain && isBuiltIn(value)) return value
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of plain ? Object.keys(value) : fieldNamesOf(value)) copy[key] = ownCopy(fieldOf(value, key), depth + 1)
  return copy as T
}
