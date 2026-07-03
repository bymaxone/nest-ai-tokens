import { toJsonSafe } from './to-json-safe'

describe('toJsonSafe', () => {
  /** A top-level bigint becomes an exact decimal string. */
  it('serializes a bigint as a decimal string', () => {
    expect(toJsonSafe(5_000_000n)).toBe('5000000')
  })

  /** Nested bigints inside objects and arrays are converted recursively. */
  it('converts bigints nested in objects and arrays', () => {
    const input = { billedCostNanoUsd: 24_100_000n, parts: [1n, 2n], meta: { rawCostNanoUsd: 6_025_000n } }
    expect(toJsonSafe(input)).toEqual({
      billedCostNanoUsd: '24100000',
      parts: ['1', '2'],
      meta: { rawCostNanoUsd: '6025000' },
    })
  })

  /** Non-bigint primitives and null pass through unchanged. */
  it('passes through numbers, strings, booleans, and null', () => {
    expect(toJsonSafe({ tokens: 42, feature: 'chat', flag: true, missing: null })).toEqual({
      tokens: 42,
      feature: 'chat',
      flag: true,
      missing: null,
    })
  })

  /** Dates are cloned (a new instance) and preserve their instant. */
  it('clones Date values without mutating the source reference', () => {
    const occurredAt = new Date('2026-06-01T00:00:00.000Z')
    const cloned = toJsonSafe({ occurredAt }).occurredAt
    expect(cloned).toBeInstanceOf(Date)
    expect(cloned).not.toBe(occurredAt)
    expect(cloned.getTime()).toBe(occurredAt.getTime())
  })

  /** The result round-trips through JSON.stringify with bigints as strings. */
  it('round-trips losslessly through JSON', () => {
    const envelope = { id: 'evt-1', data: { billedCostNanoUsd: 9_999_999_999n } }
    const parsed = JSON.parse(JSON.stringify(toJsonSafe(envelope))) as {
      id: string
      data: { billedCostNanoUsd: string }
    }
    expect(parsed.data.billedCostNanoUsd).toBe('9999999999')
    expect(BigInt(parsed.data.billedCostNanoUsd)).toBe(9_999_999_999n)
  })
})
