/**
 * @fileoverview The copy of a value that holds only what it has: its own keys and, for an instance of a class, the fields its class chain
 * defines, never a key found only on the `Object.prototype` of its realm. A reader that asks an object for a name it lacks is otherwise
 * answered by that root, where another library, or prototype pollution, may have put a key, and a class instance is no exception: an absent
 * field resolves through its class to the same root. The copy has no prototype, so a name it lacks is `undefined` however it is read, and a
 * getter of a class is read once and counts as a field; a field defined as not enumerable is a field, and the class itself is not kept, so
 * `instanceof` of the copy is false. Plain objects, instances of classes and arrays are copied to the depth of {@link MAX_DEPTH} levels, and
 * a record nested deeper is refused, never handed on uncopied: a subtree that kept its prototype would read the root again. A `Date`, a `Map`,
 * a typed array and the other built-in objects, known by their internal slot and not by the tag they claim, a `bigint` and a function are
 * handed on as they are.
 * @layer server
 */

import { types } from 'node:util'
import { mapList } from '../../shared/utils/native-promise'
import { fieldNamesOf, fieldOf } from './field-names'

/** The deepest level copied: a record a store takes or returns has a record or a list in it, never a long chain; a record nested deeper is refused. */
const MAX_DEPTH = 8

/** Whether `value` is a plain object of any realm, or one with no prototype: its prototype is none or the root that ends every chain. */
export function isPlain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

/**
 * The tests of the built-in objects that are handed on whole. Each reads the internal slot of the value through `util.types` and runs nothing
 * on it, which a call such as `RegExp.prototype.test` would (it changes the `lastIndex` of a global RegExp), and none consults the tag the
 * value claims: an own `Symbol.toStringTag`, or one planted on `Object.prototype`, names any record a Date or a Map.
 */
const BUILT_INS: readonly ((value: object) => boolean)[] = [
  types.isDate,
  types.isRegExp,
  types.isMap,
  types.isSet,
  types.isWeakMap,
  types.isWeakSet,
  types.isAnyArrayBuffer,
  types.isArrayBufferView,
  types.isPromise,
  types.isBoxedPrimitive,
  types.isGeneratorObject,
  types.isMapIterator,
  types.isSetIterator,
]

/** Whether `value` is one of the {@link BUILT_INS}. A plain object is none, so only the other objects are tested. */
function isBuiltIn(value: object): boolean {
  return BUILT_INS.some((is) => is(value))
}

/**
 * A copy of a value in which every object that is a record (a plain object or an instance of a class) has no prototype and holds its own
 * fields and its class's, and every array is copied element by element.
 *
 * @param value Any value; an input a store takes or a row it returns.
 * @param depth The level of the value inside the record, for the limit.
 * @returns The copy, or the value itself when it is not a record or an array.
 * @throws {RangeError} When a record or a list is nested deeper than {@link MAX_DEPTH} levels, or the prototype chain of a class instance is longer than a class hierarchy; whatever a getter of the value throws.
 */
export function ownCopy<T>(value: T, depth = 0): T {
  if (typeof value !== 'object' || value === null) return value
  // Stryker disable next-line StringLiteral: error text is internal diagnostics
  if (depth > MAX_DEPTH) throw new RangeError('a record is nested deeper than a store takes or returns')
  if (Array.isArray(value)) return mapList(value as unknown[], (element: unknown) => ownCopy(element, depth + 1)) as T
  const plain = isPlain(value)
  // A Date, a Map, a typed array and the like are not records, and their methods live on a prototype that must stay.
  if (!plain && isBuiltIn(value)) return value
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of plain ? Object.getOwnPropertyNames(value) : fieldNamesOf(value)) copy[key] = ownCopy(fieldOf(value, key), depth + 1)
  return copy as T
}
