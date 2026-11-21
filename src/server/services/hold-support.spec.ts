/**
 * @fileoverview Unit tests for the {@link isNormalizedUsage} type guard in
 * `hold-support` — the runtime validation that decides whether a value handed to
 * `capture()` is already a complete, well-typed {@link NormalizedUsage}. These tests
 * pin the object/null guard and the per-token-field finiteness check so a mutant
 * cannot loosen either into accepting malformed input or dereferencing a non-object.
 * @layer server
 */

import type { NormalizedUsage, PriceVersion } from '../../shared'
import type { AiTokensException } from '../errors'
import { isNormalizedUsage, normalizeCaptureUsage, unpricedUnits } from './hold-support'

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

/** The code and reason of the typed refusal `run` raises, or `undefined` when it does not refuse. */
function refusalOf(run: () => unknown): { code: string; reason: string | undefined } | undefined {
  try {
    run()
  } catch (error) {
    const { error: body } = (error as AiTokensException).getResponse() as { error: { code: string; details?: { reason?: string } } }
    return { code: body.code, reason: body.details?.reason }
  }
  return undefined
}

describe('normalizeCaptureUsage', () => {
  /**
   * A negative token count in an already-normalized usage, or in a normalizer's output (a `prompt - cached` subtraction can produce one),
   * is refused: left alone it flows into the signed settlement leg and credits back more than was reserved.
   */
  it('refuses a negative count in an already-normalized usage and in the output of a normalizer', () => {
    const reason = 'every token and tool unit count of a usage must be a whole number from 0 to the largest safe integer, and a reported cost must not be negative'
    expect(refusalOf(() => normalizeCaptureUsage({ ...validUsage(), outputTokens: -500 }))).toEqual({ code: 'AI_TOKENS_USAGE_MALFORMED', reason })
    const normalizer = (): NormalizedUsage => ({ ...validUsage(), reasoningTokens: -10 }) as unknown as NormalizedUsage
    expect(refusalOf(() => normalizeCaptureUsage({ raw: 'payload' }, normalizer))).toEqual({ code: 'AI_TOKENS_USAGE_MALFORMED', reason })
  })

  /** A non-negative usage passes through with its counts intact. */
  it('leaves non-negative counts unchanged', () => {
    const result = normalizeCaptureUsage(validUsage())

    expect(result.inputTokens).toBe(1000)
    expect(result.outputTokens).toBe(500)
  })

  /**
   * A negative `providerReportedCostNanoUsd` is refused. Provider-reported rating uses it directly as the raw cost, so a negative value
   * (OpenRouter preserves a negative `usage.cost`) would credit the wallet and the budget on capture.
   */
  it('refuses a negative providerReportedCostNanoUsd', () => {
    expect(refusalOf(() => normalizeCaptureUsage({ ...validUsage(), providerReportedCostNanoUsd: -1_000n }))?.code).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** A non-negative provider-reported cost passes through untouched. */
  it('leaves a non-negative providerReportedCostNanoUsd unchanged', () => {
    const result = normalizeCaptureUsage({
      ...validUsage(),
      providerReportedCostNanoUsd: 5_000n,
    })

    expect(result.providerReportedCostNanoUsd).toBe(5_000n)
  })
})

describe('unpricedUnits', () => {
  const rate: PriceVersion = { unitRates: { web_search_requests: 1n } } as never
  const usage = (serverToolUse?: Record<string, number>): NormalizedUsage => ({ ...validUsage(), ...(serverToolUse === undefined ? {} : { serverToolUse }) }) as never

  /** Only a unit with a count above 0 and no rate of its own is unpriced, and a usage with no units has none. */
  it('lists the units that have a count and no rate of their own', () => {
    expect(unpricedUnits(usage(), rate)).toEqual([])
    expect(unpricedUnits(usage({ web_search_requests: 3, code_run: 2, idle: 0, constructor: 1 }), rate)).toEqual(['code_run', 'constructor'])
    expect(unpricedUnits(usage({ code_run: 2 }), {} as never)).toEqual(['code_run'])
  })
})
