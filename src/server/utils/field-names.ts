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

/**
 * The value of a field of an object, by its name: the object's own, or one its class or prototype chain defines up to the root of the
 * chain. A key found solely on the root (the `Object.prototype` of whichever realm, which another library may have added a key to) is not a
 * field; a key found nowhere is still asked of the object, which a Proxy answers by its `get` trap.
 *
 * @param value The object.
 * @param key The name of the field.
 * @returns The value of the field, or `undefined` when the object has none.
 * @throws {RangeError} When the prototype chain is longer than a class hierarchy; whatever the object's own traps and getters throw.
 */
export function fieldOf(value: object, key: string): unknown {
  let holder: object = value
  for (let depth = 0; ; depth += 1) {
    if (depth === MAX_PROTOTYPE_DEPTH) throw new RangeError()
    const next = Object.getPrototypeOf(holder) as object | null
    if (next === null) return depth > 0 && isRealmRoot(holder) && Object.hasOwn(holder, key) ? undefined : Reflect.get(value, key)
    if (Object.hasOwn(holder, key)) return Reflect.get(value, key)
    holder = next
  }
}

/**
 * A copy of the named fields of an object the host supplied, read as fields (see {@link fieldOf}) and held by an object with no
 * prototype: a field the host left out, or set to `undefined` or `null`, is absent, and a key planted on `Object.prototype` is neither
 * read nor found by a later read of the copy.
 *
 * @param source The object, or `undefined`.
 * @param names Every field of `T`, mapped to `true` so that the compiler keeps the list complete.
 * @returns The copy, or `undefined` when there was no object.
 * @throws {RangeError} When the prototype chain is longer than a class hierarchy; whatever the object's own traps and getters throw.
 */
export function fieldsOf<T extends object>(source: T | undefined, names: { readonly [K in keyof Required<T>]: true }): T | undefined {
  if (source === undefined) return undefined
  const kept = Object.create(null) as Record<string, unknown>
  for (const name of Object.keys(names)) {
    const value = fieldOf(source, name)
    if (value !== undefined && value !== null) kept[name] = value
  }
  return kept as T
}

