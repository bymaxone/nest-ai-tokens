/**
 * @fileoverview The names of the fields of an object a host built: its own, enumerable or not, and those its class or prototype chain
 * defines, up to the root of the chain. Shared by the guards that read an argument and by the view of a raw provider response, so that a
 * field a class defines as a getter, or a field defined as not enumerable, is a field wherever the library lists them.
 * @layer server
 */

/** The longest prototype chain read as the fields of an object: a class hierarchy is a handful of levels, so a longer chain is refused. */
export const MAX_PROTOTYPE_DEPTH = 32

/**
 * Whether `value` is the `Object.prototype` of some realm: the object that ends every ordinary chain, whose own `constructor` is a function
 * whose `prototype` is that object. A null-prototype object a host built is not, so its fields are the host's own.
 *
 * @param value A prototype of an object.
 * @returns `true` for the root of a chain.
 */
export function isRealmRoot(value: object): boolean {
  const constructor = Object.getOwnPropertyDescriptor(value, 'constructor')?.value as { prototype?: unknown } | undefined
  return typeof constructor === 'function' && constructor.prototype === value
}

/**
 * The names of the fields of an object: its own, enumerable or not, and the accessors and data its class or prototype chain defines up
 * to the root of the chain, without `constructor`.
 *
 * @param value The object.
 * @returns The names.
 * @throws {RangeError} When the prototype chain is longer than a class hierarchy; whatever a Proxy trap of the host throws.
 */
export function fieldNamesOf(value: object): string[] {
  const keys = new Set(Object.getOwnPropertyNames(value))
  let proto = Object.getPrototypeOf(value) as object | null
  for (let depth = 0; proto !== null; depth += 1) {
    // A chain this long is no class hierarchy: it is refused, not walked, which also ends a Proxy whose prototype loops.
    if (depth === MAX_PROTOTYPE_DEPTH) throw new RangeError()
    const next = Object.getPrototypeOf(proto) as object | null
    // The `Object.prototype` of whichever realm adds nothing; a null-prototype object of the host's own that ends the chain does.
    if (next === null && isRealmRoot(proto)) break
    for (const key of Object.getOwnPropertyNames(proto)) if (key !== 'constructor') keys.add(key)
    proto = next
  }
  return [...keys]
}
