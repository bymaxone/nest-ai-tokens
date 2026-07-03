import { HttpStatus } from '@nestjs/common'
import { AI_TOKENS_ERROR_CODES } from '../../shared'
import type { AiTokensErrorResponse } from '../../shared'
import { AiTokensException } from './ai-tokens-exception'

/** The expected HTTP status per code, transcribed from spec §16.2. */
const EXPECTED_STATUS: Record<keyof typeof AI_TOKENS_ERROR_CODES, number> = {
  AI_TOKENS_NOT_CONFIGURED: 503,
  AI_TOKENS_INVALID_CONFIG: 500,
  AI_TOKENS_UNKNOWN_PROVIDER: 400,
  AI_TOKENS_USAGE_MALFORMED: 422,
  AI_TOKENS_PRICE_NOT_FOUND: 422,
  AI_TOKENS_FX_REQUIRED: 500,
  AI_TOKENS_BUDGET_EXCEEDED: 402,
  AI_TOKENS_QUOTA_EXCEEDED: 429,
  AI_TOKENS_INSUFFICIENT_CREDITS: 402,
  AI_TOKENS_HOLD_NOT_FOUND: 404,
  AI_TOKENS_HOLD_EXPIRED: 410,
  AI_TOKENS_HOLD_ALREADY_SETTLED: 409,
  AI_TOKENS_IDEMPOTENCY_CONFLICT: 409,
  AI_TOKENS_STREAM_USAGE_MISSING: 422,
  AI_TOKENS_STORE_ERROR: 502,
}

describe('AiTokensException', () => {
  const codes = Object.keys(AI_TOKENS_ERROR_CODES) as (keyof typeof AI_TOKENS_ERROR_CODES)[]

  /** Every code maps to its §16.2 status and produces the canonical body shape. */
  it.each(codes)('maps %s to its status and message', (code) => {
    const exception = new AiTokensException(code)
    expect(exception.getStatus()).toBe(EXPECTED_STATUS[code])
    const body = exception.getResponse() as AiTokensErrorResponse
    expect(body.error.code).toBe(code)
    expect(typeof body.error.message).toBe('string')
    expect(body.error.message.length).toBeGreaterThan(0)
  })

  /** The details object is carried through when provided. */
  it('includes details in the response body', () => {
    const exception = new AiTokensException('AI_TOKENS_BUDGET_EXCEEDED', undefined, { budgetId: 'b1' })
    const body = exception.getResponse() as AiTokensErrorResponse
    expect(body.error.code).toBe('AI_TOKENS_BUDGET_EXCEEDED')
    expect(body.error.details).toEqual({ budgetId: 'b1' })
  })

  /** Without details, the serialized body omits the field entirely. */
  it('omits details from the serialized body when not provided', () => {
    const exception = new AiTokensException('AI_TOKENS_STORE_ERROR')
    const body = exception.getResponse() as AiTokensErrorResponse
    expect(body.error.code).toBe('AI_TOKENS_STORE_ERROR')
    expect(JSON.stringify(body)).not.toContain('details')
  })

  /** An explicit status overrides the default mapping. */
  it('honors an explicit status override', () => {
    const exception = new AiTokensException('AI_TOKENS_STORE_ERROR', HttpStatus.I_AM_A_TEAPOT)
    expect(exception.getStatus()).toBe(418)
  })
})
