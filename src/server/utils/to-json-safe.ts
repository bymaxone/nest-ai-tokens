/**
 * @fileoverview `toJsonSafe` — the bigint-at-the-JSON-boundary helper (spec §15.5).
 * `bigint` does not survive `JSON.stringify`, so any library value returned from a
 * controller or shipped through an out-of-process `IEventSink` is first deep-cloned
 * with every `bigint` rendered as an exact decimal string (e.g. `5000000n` →
 * `"5000000"`). Token counts stay plain `number`; `Date` values are cloned and
 * serialize to ISO strings via the standard JSON rules. In-process delivery keeps
 * `bigint` intact — this helper is only for the JSON boundary.
 * @layer server
 */

/** The result of {@link toJsonSafe}: every `bigint` replaced by a decimal string. */
export type JsonSafe<T> = T extends bigint
  ? string
  : T extends Date
    ? Date
    : T extends readonly (infer U)[]
      ? JsonSafe<U>[]
      : T extends object
        ? { [K in keyof T]: JsonSafe<T[K]> }
        : T

/** Recursively clone a value, converting every `bigint` to a decimal string. */
function convert(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return new Date(value.getTime())
  if (Array.isArray(value)) return value.map((element: unknown) => convert(element))
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) output[key] = convert(member)
    return output
  }
  return value
}

/**
 * Deep-clone a value into a JSON-safe form, serializing every `bigint` as a
 * decimal string so the result survives `JSON.stringify` losslessly.
 *
 * @param value The value to make JSON-safe (e.g. a `UsageRecord` or event envelope).
 * @returns A structural clone with `bigint` fields rendered as decimal strings.
 * @example
 * toJsonSafe({ billedCostNanoUsd: 5_000_000n }) // { billedCostNanoUsd: '5000000' }
 */
export function toJsonSafe<T>(value: T): JsonSafe<T> {
  return convert(value) as JsonSafe<T>
}
