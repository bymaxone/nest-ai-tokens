/**
 * @fileoverview What the refusals of `hold-support` carry in `details`, and which values its usage guard turns away.
 * @layer test
 */

import type { AiTokensException } from '../errors'
import { assertCaller, isNormalizedUsage, normalizeCaptureUsage } from './hold-support'

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
})
