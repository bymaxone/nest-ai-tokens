import type { AiTokensErrorResponse } from '../../shared'
import type { IMarkupPolicy } from '../interfaces'
import { AiTokensException } from '../errors'
import { MarkupResolver, type MarkupContext } from './markup.resolver'

/** A representative resolve context. */
const CONTEXT: MarkupContext = {
  scope: { type: 'user', id: 'u1' },
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
  serviceTier: 'standard',
  feature: 'chat.reply',
}

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: AiTokensException): string {
  return (error.getResponse() as AiTokensErrorResponse).error.code
}

describe('MarkupResolver', () => {
  /** A static multiplier resolves and applies exactly in bigint nano-USD. */
  it('resolves a static multiplier', async () => {
    const resolver = new MarkupResolver({ markup: 4 })
    const resolved = await resolver.resolve(CONTEXT)
    expect(resolved.multiplier).toBe(4)
    expect(resolved.apply(5_000_000n)).toBe(20_000_000n)
  })

  /** An async policy resolves and receives the full context (incl. serviceTier). */
  it('resolves an async policy with the full context', async () => {
    let received: MarkupContext | undefined
    const policy: IMarkupPolicy = {
      resolve: (ctx) => {
        received = ctx
        return Promise.resolve(2)
      },
    }
    const resolved = await new MarkupResolver({ markup: policy }).resolve(CONTEXT)
    expect(resolved.multiplier).toBe(2)
    expect(received?.serviceTier).toBe('standard')
    expect(received?.feature).toBe('chat.reply')
  })

  /** A synchronous policy return is supported too. */
  it('resolves a synchronous policy', async () => {
    const policy: IMarkupPolicy = { resolve: () => 3 }
    expect((await new MarkupResolver({ markup: policy }).resolve(CONTEXT)).multiplier).toBe(3)
  })

  /** A policy value is rounded to 4 dp and applied/persisted as that exact value. */
  it('rounds a policy value to 4 dp and applies it', async () => {
    const policy: IMarkupPolicy = { resolve: () => 1.23456 }
    const resolved = await new MarkupResolver({ markup: policy }).resolve(CONTEXT)
    expect(resolved.multiplier).toBe(1.2346)
    expect(resolved.apply(10_000_000n)).toBe(12_346_000n)
  })

  /** Provider-reported mode: markup composes on top of an OpenRouter cost. */
  it('applies markup on a provider-reported cost', async () => {
    const providerReportedCostNanoUsd = 5_000_000n
    const resolved = await new MarkupResolver({ markup: 4 }).resolve(CONTEXT)
    expect(resolved.apply(providerReportedCostNanoUsd)).toBe(20_000_000n)
  })

  /** A throwing policy fails the call — no silent 1.0 fallback. */
  it('wraps a throwing policy as an invalid-config error', async () => {
    const policy: IMarkupPolicy = {
      resolve: () => {
        throw new Error('policy exploded')
      },
    }
    const error = await new MarkupResolver({ markup: policy }).resolve(CONTEXT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AiTokensException)
    expect(codeOf(error as AiTokensException)).toBe('AI_TOKENS_INVALID_CONFIG')
    expect((error as AiTokensException).getStatus()).toBe(500)
  })

  /** A policy returning an invalid multiplier fails the call. */
  it('rejects an invalid policy multiplier', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy: IMarkupPolicy = { resolve: () => bad }
      const error = await new MarkupResolver({ markup: policy }).resolve(CONTEXT).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AiTokensException)
      expect(codeOf(error as AiTokensException)).toBe('AI_TOKENS_INVALID_CONFIG')
    }
  })
})
