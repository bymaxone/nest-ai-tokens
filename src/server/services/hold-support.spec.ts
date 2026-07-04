/**
 * @fileoverview Unit tests for the {@link isNormalizedUsage} type guard in
 * `hold-support` — the runtime validation that decides whether a value handed to
 * `capture()` is already a complete, well-typed {@link NormalizedUsage}. These tests
 * pin the object/null guard and the per-token-field finiteness check so a mutant
 * cannot loosen either into accepting malformed input or dereferencing a non-object.
 * @layer server
 */

import { isNormalizedUsage } from './hold-support'

/** A complete, well-typed normalized usage (all ten token fields present and finite). */
function validUsage(): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
  }
}

describe('isNormalizedUsage', () => {
  /** A complete, well-typed usage is accepted. */
  it('accepts a complete normalized usage', () => {
    expect(isNormalizedUsage(validUsage())).toBe(true)
  })

  /**
   * null is rejected WITHOUT dereferencing it. Kills ConditionalExpression→false on the
   * `typeof usage !== 'object' || usage === null` guard: dropping the early return lets the
   * function read `null.provider` and throw a TypeError instead of returning false.
   */
  it('rejects null without dereferencing it', () => {
    expect(isNormalizedUsage(null)).toBe(false)
  })

  /** A non-object primitive is rejected. */
  it('rejects a non-object primitive', () => {
    expect(isNormalizedUsage(42)).toBe(false)
  })

  /**
   * A usage missing one token field is rejected. Kills ConditionalExpression→true on the
   * `TOKEN_FIELDS.every(...)` finiteness check, which would accept any object with a valid
   * provider/model/operation regardless of its token columns.
   */
  it('rejects a usage with a missing token field', () => {
    const usage = validUsage()
    delete usage.inputTokens
    expect(isNormalizedUsage(usage)).toBe(false)
  })

  /**
   * A usage whose token field is a non-finite number (NaN) is rejected. Exercises the
   * `Number.isFinite` half of the per-field check that ConditionalExpression→true erases.
   */
  it('rejects a usage with a non-finite token field', () => {
    expect(isNormalizedUsage({ ...validUsage(), outputTokens: Number.NaN })).toBe(false)
  })

  /** A usage with a non-string provider is rejected. */
  it('rejects a usage with a non-string provider', () => {
    expect(isNormalizedUsage({ ...validUsage(), provider: 123 })).toBe(false)
  })

  /** A usage with an unknown operation is rejected. */
  it('rejects a usage with an unknown operation', () => {
    expect(isNormalizedUsage({ ...validUsage(), operation: 'not-an-op' })).toBe(false)
  })
})
