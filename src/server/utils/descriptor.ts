/**
 * @fileoverview The descriptor of a property, built with no prototype. `Object.defineProperty` reads `get`, `set`, `value` and the flags of the
 * object it is given through its prototype chain, so a descriptor literal answers a key that another library put on `Object.prototype` as part
 * of the property, and a planted `get` or `set` makes every definition throw.
 * @layer server
 */

/**
 * A descriptor with no prototype.
 *
 * @param fields What the property is: a value and its flags, or an accessor.
 * @returns The descriptor, safe to hand to `Object.defineProperty`.
 */
export function descriptor(fields: PropertyDescriptor): PropertyDescriptor {
  return Object.assign(Object.create(null) as PropertyDescriptor, fields)
}
