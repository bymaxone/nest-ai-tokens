/**
 * @fileoverview The rating of a call that is only compared with a stored one, and the reason a usage without the provider's cost is refused.
 * @layer test
 */

import type { AiTokensErrorResponse, NormalizedUsage } from '../../shared'
import type { ReplayBasis } from '../utils/replay-match'
import { requireReportedCost, unratedFor } from './record-replay'

const USAGE: NormalizedUsage = {
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningTokens: 0,
  audioInTokens: 0,
  audioOutTokens: 0,
  imageInTokens: 0,
  imageOutTokens: 0,
}

const BASIS: ReplayBasis = { providerReported: false, occurredAtSupplied: false, responseModel: 'gpt-5' }

/** The body of the error a call throws. */
function errorOf(call: () => unknown): AiTokensErrorResponse['error'] {
  try {
    call()
  } catch (error) {
    return ((error as { getResponse(): unknown }).getResponse() as AiTokensErrorResponse).error
  }
  throw new Error('expected the call to throw')
}

describe('requireReportedCost', () => {
  /** The refusal names what is missing. */
  it('refuses a usage without a provider-reported cost, naming it', () => {
    expect(errorOf(() => requireReportedCost(USAGE))).toMatchObject({
      code: 'AI_TOKENS_USAGE_MALFORMED',
      details: { reason: 'provider-reported rating requires providerReportedCostNanoUsd' },
    })
  })
})

describe('unratedFor', () => {
  /** Nothing is priced: no surcharge, no price version, and no missing price is reported. */
  it('rates nothing for a call that is only compared', () => {
    expect(unratedFor(USAGE, BASIS)).toStrictEqual({ rawCostNanoUsd: 0n, surchargeNanoUsd: 0n, priceVersionId: null, priceMissing: false })
  })

  /** A provider-reported cost is part of the request, so it is carried. */
  it('carries the provider-reported cost', () => {
    const rated = unratedFor({ ...USAGE, providerReportedCostNanoUsd: 7n }, { ...BASIS, providerReported: true })
    expect(rated.rawCostNanoUsd).toBe(7n)
  })
})
