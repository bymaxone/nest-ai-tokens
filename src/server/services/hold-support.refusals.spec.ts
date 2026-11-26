/**
 * @fileoverview What the refusals of `hold-support` carry in `details`, and which values its usage guard turns away.
 * @layer test
 */

import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { AiTokensException } from '../errors'
import type { HoldEstimate, MeteringContext } from '../interfaces'
import { assertCaller, assertHoldEstimate, isNormalizedUsage, normalizeCaptureUsage, resolveHoldEstimate } from './hold-support'
import { PricingService } from './pricing.service'

const FIELDS = {
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
  serviceTier: 'standard',
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

/** A pricing service over an empty store. */
function pricingService(): PricingService {
  const options = { pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} } } as ResolvedAiTokensOptions
  return new PricingService(options, new InMemoryPricingStore())
}

/** The response body of the refusal `act` throws. */
function refusalOf(act: () => unknown): { code: string; details: unknown } {
  try {
    act()
  } catch (error) {
    return ((error as AiTokensException).getResponse() as { error: { code: string; details: unknown } }).error
  }
  throw new Error('accepted')
}

describe('hold-support refusals', () => {
  /** A function carrying every field is not a usage object. */
  it('turns away a function that carries the usage fields', () => {
    expect(isNormalizedUsage(Object.assign(() => undefined, FIELDS))).toBe(false)
  })

  /** A normalizer that returns something unreadable is named as the cause. */
  it('says the normalizer could not read the usage', () => {
    const refusal = refusalOf(() =>
      normalizeCaptureUsage({}, () => {
        throw new TypeError('raw')
      }),
    )
    expect(refusal.details).toEqual({ reason: 'the normalizer could not read the usage token fields' })
  })

  /** Raw usage with no preset says what capture needs. */
  it('says what capture requires', () => {
    expect(refusalOf(() => normalizeCaptureUsage({})).details).toEqual({ reason: 'capture requires an already-normalized usage or a preset normalizer' })
  })

  /** The caller refusal carries its message in the response, not only on the Error. */
  it('puts the caller message in details.reason', () => {
    let message = ''
    try {
      assertCaller(undefined, 'capture(hold, caller, usage)')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('capture(hold, caller, usage)')
    expect(refusalOf(() => assertCaller(undefined, 'capture(hold, caller, usage)')).details).toEqual({ reason: message })
  })

  /** `Number.isFinite` does not coerce, so a count written as text is not a count. */
  it('turns away a token count written as a string', () => {
    expect(isNormalizedUsage({ ...FIELDS, inputTokens: '1' })).toBe(false)
  })

  /** Each refused estimate says which field and what it must be. */
  it.each([
    [{ tokens: -1 }, 'tokens of a hold estimate must be a whole number of 0 or more'],
    [{ amountNanoUsd: -1n }, 'amountNanoUsd of a hold estimate must be a bigint from 0 to 9223372036854775807'],
  ])('says what is wrong with the estimate %p', (estimate, reason) => {
    const refusal = refusalOf(() => assertHoldEstimate(estimate))
    expect(refusal).toMatchObject({ code: 'AI_TOKENS_INVALID_CONFIG', details: { reason } })
  })

  /** A `{ tokens }` estimate with no preset says what is missing. */
  it('says a token estimate needs a preset', async () => {
    const context: MeteringContext = { tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }
    await expect(resolveHoldEstimate(pricingService(), context, { tokens: 1 }, new Date(0))).rejects.toMatchObject({
      response: { error: { code: 'AI_TOKENS_INVALID_CONFIG', details: { reason: 'a { tokens } hold estimate requires context.preset to identify the provider' } } },
    })
  })
})

describe('the rate a named estimate asks for', () => {
  const estimate: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1, maxOutputTokens: 1 }
  const context: MeteringContext = { tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }

  /** The base model is passed on only when the context names one, with no empty key in its place. */
  it.each([
    [{}, {}],
    [{ baseModel: 'gpt-4o' }, { baseModel: 'gpt-4o' }],
  ])('asks with the context %p', async (named, passed) => {
    const pricing = pricingService()
    const resolveRate = jest.spyOn(pricing, 'resolveRate').mockResolvedValue(null)
    await resolveHoldEstimate(pricing, { ...context, ...named }, estimate, new Date(0))
    expect(resolveRate.mock.calls[0]?.[0]).toStrictEqual({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', at: new Date(0), ...passed })
  })
})
