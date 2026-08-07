/**
 * @fileoverview Host-side derivation of a stable idempotency key from request
 * content (spec §8.4). The payload is serialized to canonical JSON — object keys
 * sorted recursively, array order preserved, `undefined` dropped, `bigint`
 * encoded as a QUOTED, type-tagged string (e.g. `42n` → `"42n"`), `Date` as its
 * ISO string — then hashed with a pure synchronous SHA-256. The `n`-suffixed
 * quoted form makes a `bigint` unambiguous: it can never serialize to the same
 * text as the number `42` (`42`) or a numeric string `"42"` (`"42"`), so
 * `deriveIdempotencyKey(42)` and `deriveIdempotencyKey(42n)` never collide.
 * Deriving the key from content means a retry after a 429/network failure reuses
 * the same key and is deduplicated.
 * @layer shared
 */

import { sha256Hex } from './sha256'

/**
 * Serialize a value to a canonical JSON string: object keys are sorted so
 * `{a,b}` and `{b,a}` produce identical output; arrays keep their order;
 * `undefined` object members are dropped; `undefined` array elements become
 * `null`; `bigint` is encoded as an `n`-suffixed quoted string (`42n` → `"42n"`)
 * so it can never collide with a number or a numeric string; `Date` is its ISO
 * string.
 */
function canonicalize(value: unknown): string {
  // Stryker disable next-line ConditionalExpression: `value === undefined → false` is equivalent: dropping the operand leaves `value === null`, and a top-level `undefined` (or an `undefined` array element) that no longer short-circuits here falls through every type check to the final `return 'null'`, producing the identical canonical form
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`)
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())

  if (Array.isArray(value)) {
    return `[${value.map((element: unknown) => canonicalize(element)).join(',')}]`
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    // Stryker disable next-line StringLiteral: object member separator is behavior-preserving: every member is self-delimited by its quoted key, so dropping the ',' keeps canonicalize injective and key-order-stable — no two distinct payloads can be made to collide
    return `{${members.join(',')}}`
  }

  // Functions and symbols carry no serializable content.
  return 'null'
}

/**
 * Derive a stable idempotency key from a request payload. Equal payloads (up to
 * object-key order) yield the same key; distinct payloads yield distinct keys.
 * Pure, synchronous, and edge-safe.
 *
 * @param payload Any JSON-like request content.
 * @returns A 64-character lowercase hex SHA-256 digest.
 * @example
 * deriveIdempotencyKey({ a: 1, b: 2 }) === deriveIdempotencyKey({ b: 2, a: 1 }) // true
 */
export function deriveIdempotencyKey(payload: unknown): string {
  return sha256Hex(canonicalize(payload))
}
