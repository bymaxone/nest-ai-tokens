/**
 * @fileoverview Optional fields of an object the library builds, left out when they have no value.
 * @layer server
 */

/** The fields of `T`, each optional and never `undefined`. */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> }

/**
 * The own fields of an object the library built, without those whose value is `undefined`, to be spread into another object: a field
 * left out neither overwrites an earlier one nor shows as a key.
 *
 * @param fields An object literal of the library's own.
 * @returns A copy without the `undefined` fields.
 */
export function defined<T extends object>(fields: T): Defined<T> {
  const copy: Record<string, unknown> = { ...(fields as Record<string, unknown>) }
  for (const key in copy) if (copy[key] === undefined) Reflect.deleteProperty(copy, key)
  return copy as Defined<T>
}
