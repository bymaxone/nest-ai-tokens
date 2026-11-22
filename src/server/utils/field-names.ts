/**
 * @fileoverview The names of the fields of an object a host built: its own, enumerable or not, and those its class or prototype chain
 * defines, up to the root of the chain. Shared by the guards that read an argument and by the view of a raw provider response, so that a
 * field a class defines as a getter, or a field defined as not enumerable, is a field wherever the library lists them.
 * @layer server
 */

/** The longest prototype chain read as the fields of an object: a class hierarchy is a handful of levels, so a longer chain is refused. */
export const MAX_PROTOTYPE_DEPTH = 32

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
    // The object that ends the chain is never read, whichever it is: the `Object.prototype` of any realm, which another library may have
    // planted keys on and whose `constructor` it may have overwritten, or a null-prototype object of the host's own, whose keys are given up.
    if (next === null) break
    for (const key of Object.getOwnPropertyNames(proto)) if (key !== 'constructor') keys.add(key)
    proto = next
  }
  return [...keys]
}

/**
 * The value of a field of an object, by its name: the object's own, or one its class or prototype chain defines. The walk goes to the first
 * holder of the key; when that holder is not the object itself and has no prototype, it is the object that ends the chain (the
 * `Object.prototype` of whichever realm, which another library may have added a key to) and the key is not read, and no property of that
 * object is read to tell it, because pollution can overwrite or delete its `constructor`. The cost is that a key held only by a
 * null-prototype object of the host's own, at the end of the chain, is not read either. A key found nowhere is still asked of the object,
 * which a Proxy answers by its `get` trap.
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
    if (Object.hasOwn(holder, key)) return depth > 0 && next === null ? undefined : Reflect.get(value, key)
    if (next === null) return Reflect.get(value, key)
    holder = next
  }
}

/**
 * A method of an object the host supplied, bound to it: the object's own or one its class defines (see {@link fieldOf}). A function of
 * that name found only on the `Object.prototype` of a realm is not a method, and a field that is not a function is none either.
 *
 * @param host The object.
 * @param name The name of the method.
 * @returns The bound method, which the caller narrows to the type the port declares, or `undefined` when the host has none.
 * @throws {RangeError} When the prototype chain is longer than a class hierarchy; whatever the object's own traps and getters throw.
 */
export function methodOf(host: object, name: string): ((...args: never[]) => unknown) | undefined {
  const method = fieldOf(host, name)
  return typeof method === 'function' ? (method as (...args: never[]) => unknown).bind(host) : undefined
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
export function fieldsOf<T extends object>(source: T, names: { readonly [K in keyof Required<T>]: true }): T
/** An object that may be absent: the copy, or `undefined` when there was none. */
export function fieldsOf<T extends object>(source: T | undefined, names: { readonly [K in keyof Required<T>]: true }): T | undefined
/** The implementation of the two signatures above. */
export function fieldsOf<T extends object>(source: T | undefined, names: { readonly [K in keyof Required<T>]: true }): T | undefined {
  if (source === undefined) return undefined
  const kept = Object.create(null) as Record<string, unknown>
  for (const name of Object.keys(names)) {
    const value = fieldOf(source, name)
    if (value !== undefined && value !== null) kept[name] = value
  }
  return kept as T
}

