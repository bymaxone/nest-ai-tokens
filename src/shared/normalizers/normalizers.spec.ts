import fc from 'fast-check'
import type { NormalizedUsage } from '../types/normalized-usage'
import { floatUsdToNanoUsd } from '../pricing/money'
import {
  normalizeAnthropicUsage,
  normalizeBedrockConverseUsage,
  normalizeGeminiUsage,
  normalizeMistralUsage,
  normalizeOpenAiChatUsage,
  normalizeOpenAiCompatibleUsage,
  normalizeOpenAiResponsesUsage,
  normalizeOpenRouterUsage,
  normalizeVercelAiSdkUsage,
} from './index'

/** Assert the spec §5.5 input-side reconciliation invariant. */
function expectInputInvariant(usage: NormalizedUsage, providerTotalInput: number): void {
  const sum =
    usage.inputTokens +
    usage.cacheReadTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens +
    usage.audioInTokens +
    usage.imageInTokens
  expect(sum).toBe(providerTotalInput)
}

/** Assert the spec §5.5 output-side reconciliation invariant. */
function expectOutputInvariant(usage: NormalizedUsage, providerTotalOutput: number): void {
  expect(usage.outputTokens + usage.reasoningTokens).toBe(providerTotalOutput)
}

const nat = fc.nat({ max: 1_000_000 })

describe('normalizeOpenAiChatUsage', () => {
  /** A realistic non-streaming payload with cache + reasoning + audio details. */
  it('normalizes a full payload and subtracts reasoning from output', () => {
    const usage = normalizeOpenAiChatUsage({
      model: 'gpt-5.2',
      service_tier: 'default',
      usage: {
        prompt_tokens: 130,
        completion_tokens: 90,
        prompt_tokens_details: { cached_tokens: 20, audio_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 30, audio_tokens: 5 },
      },
    })
    expect(usage).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.2',
      operation: 'chat',
      serviceTier: 'standard',
      inputTokens: 100,
      outputTokens: 60,
      cacheReadTokens: 20,
      reasoningTokens: 30,
      audioInTokens: 10,
      audioOutTokens: 5,
    })
  })

  /** The streaming-final chunk carries usage with an empty choices array. */
  it('normalizes a streaming-final chunk (empty choices)', () => {
    const usage = normalizeOpenAiChatUsage({
      model: 'gpt-5.2',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    })
    expect(usage.inputTokens).toBe(10)
    expect(usage.outputTokens).toBe(4)
    expect(usage.serviceTier).toBeUndefined()
  })

  /** Both §5.5 invariants hold for any generated payload. */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, nat, nat, nat, nat, (input, cached, audioIn, out, reasoning, audioOut) => {
        // No model field here exercises the empty-model fallback.
        const usage = normalizeOpenAiChatUsage({
          usage: {
            prompt_tokens: input + cached + audioIn,
            completion_tokens: out + reasoning,
            prompt_tokens_details: { cached_tokens: cached, audio_tokens: audioIn },
            completion_tokens_details: { reasoning_tokens: reasoning, audio_tokens: audioOut },
          },
        })
        expectInputInvariant(usage, input + cached + audioIn)
        expectOutputInvariant(usage, out + reasoning)
        expect(usage.outputTokens + usage.reasoningTokens).toBe(out + reasoning)
      }),
    )
  })

  /** Malformed input throws a plain Error the server layer will wrap. */
  it('throws on malformed usage', () => {
    expect(() => normalizeOpenAiChatUsage({ model: 'm' })).toThrow(Error)
    expect(() => normalizeOpenAiChatUsage({ usage: { prompt_tokens: 1 } })).toThrow(Error)
  })

  /** When the response carries no model field, model defaults to an empty string (not undefined or a placeholder). */
  it('defaults model to empty string when model is absent', () => {
    const usage = normalizeOpenAiChatUsage({ usage: { prompt_tokens: 5, completion_tokens: 3 } })
    expect(usage.model).toBe('')
  })
})

describe('normalizeOpenAiResponsesUsage', () => {
  /** The Responses API renames the fields but keeps the reasoning subtraction. */
  it('normalizes the input/output-token naming', () => {
    const usage = normalizeOpenAiResponsesUsage({
      model: 'gpt-5.2',
      service_tier: 'priority',
      usage: {
        input_tokens: 120,
        output_tokens: 70,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 25 },
      },
    })
    expect(usage).toMatchObject({
      operation: 'responses',
      serviceTier: 'priority',
      inputTokens: 100,
      outputTokens: 45,
      cacheReadTokens: 20,
      reasoningTokens: 25,
    })
  })

  /** Both §5.5 invariants hold for any generated payload. */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, nat, nat, (input, cached, out, reasoning) => {
        const usage = normalizeOpenAiResponsesUsage({
          usage: {
            input_tokens: input + cached,
            output_tokens: out + reasoning,
            input_tokens_details: { cached_tokens: cached },
            output_tokens_details: { reasoning_tokens: reasoning },
          },
        })
        expectInputInvariant(usage, input + cached)
        expectOutputInvariant(usage, out + reasoning)
      }),
    )
  })

  /** Malformed input throws. */
  it('throws on malformed usage', () => {
    expect(() => normalizeOpenAiResponsesUsage({ usage: {} })).toThrow(Error)
  })

  /** Provider is always 'openai' regardless of the raw object content. */
  it('sets provider to "openai"', () => {
    const usage = normalizeOpenAiResponsesUsage({ model: 'm', usage: { input_tokens: 10, output_tokens: 5 } })
    expect(usage.provider).toBe('openai')
  })

  /** Audio input tokens are SUBTRACTED from the raw total (not added) — a billing correctness invariant. */
  it('subtracts audio input tokens from inputTokens', () => {
    const usage = normalizeOpenAiResponsesUsage({
      usage: {
        input_tokens: 130,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 20, audio_tokens: 10 },
      },
    })
    // 130 - 20 (cache) - 10 (audio) = 100
    expect(usage.inputTokens).toBe(100)
    expect(usage.audioInTokens).toBe(10)
  })

  /** When the response carries no model field, model defaults to empty string. */
  it('defaults model to empty string when model is absent', () => {
    const usage = normalizeOpenAiResponsesUsage({ usage: { input_tokens: 10, output_tokens: 5 } })
    expect(usage.model).toBe('')
  })
})

describe('normalizeOpenAiCompatibleUsage', () => {
  /** DeepSeek's root-level cache-hit tokens map to cacheRead; provider is left empty. */
  it('reads DeepSeek prompt_cache_hit_tokens', () => {
    const usage = normalizeOpenAiCompatibleUsage({
      model: 'deepseek-chat',
      usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 40 },
    })
    expect(usage).toMatchObject({ provider: '', inputTokens: 60, cacheReadTokens: 40, outputTokens: 50 })
  })

  /** Both §5.5 invariants hold for any generated payload. */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, nat, nat, (input, cached, out, reasoning) => {
        const usage = normalizeOpenAiCompatibleUsage({
          usage: {
            prompt_tokens: input + cached,
            completion_tokens: out + reasoning,
            prompt_cache_hit_tokens: cached,
            completion_tokens_details: { reasoning_tokens: reasoning },
          },
        })
        expectInputInvariant(usage, input + cached)
        expectOutputInvariant(usage, out + reasoning)
      }),
    )
  })

  /** Malformed input throws. */
  it('throws on malformed usage', () => {
    expect(() => normalizeOpenAiCompatibleUsage({ usage: { prompt_tokens: 1 } })).toThrow(Error)
  })

  /** When BOTH root-level and nested cache-hit tokens are present, they are ADDED together (not subtracted). */
  it('adds root-level and nested cache-hit tokens', () => {
    const usage = normalizeOpenAiCompatibleUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 20,
        prompt_tokens_details: { cached_tokens: 15 },
      },
    })
    expect(usage.cacheReadTokens).toBe(35)  // 20 + 15, not 20 - 15
    expect(usage.inputTokens).toBe(65)       // 100 - 35
  })

  /** When model is absent, model defaults to empty string. */
  it('defaults model to empty string when model is absent', () => {
    const usage = normalizeOpenAiCompatibleUsage({ usage: { prompt_tokens: 5, completion_tokens: 3 } })
    expect(usage.model).toBe('')
  })
})

describe('normalizeAnthropicUsage', () => {
  /** A split cache_creation payload maps 5m/1h writes and reads the service tier and tool use. */
  it('normalizes split cache writes, service tier, and server tool use', () => {
    const usage = normalizeAnthropicUsage({
      model: 'claude-opus',
      usage: {
        input_tokens: 100,
        output_tokens: 60,
        cache_read_input_tokens: 25,
        cache_creation_input_tokens: 15,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
        service_tier: 'batch',
        server_tool_use: { web_search_requests: 3 },
      },
    })
    expect(usage).toMatchObject({
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 60,
      reasoningTokens: 0,
      cacheReadTokens: 25,
      cacheWrite5mTokens: 10,
      cacheWrite1hTokens: 5,
      serviceTier: 'batch',
      serverToolUse: { web_search_requests: 3 },
    })
  })

  /** An unsplit cache_creation total (message_delta streaming shape) defaults to the 5m category. */
  it('normalizes an unsplit cache total (streaming-final shape)', () => {
    const usage = normalizeAnthropicUsage({
      model: 'claude-sonnet',
      usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 12 },
    })
    expect(usage.cacheWrite5mTokens).toBe(12)
    expect(usage.cacheWrite1hTokens).toBe(0)
    expect(usage.serviceTier).toBeUndefined()
    expect(usage.serverToolUse).toBeUndefined()
  })

  /** Both §5.5 invariants hold (reasoning is always 0 for Anthropic). */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, nat, nat, nat, (input, output, cacheRead, write5m, write1h) => {
        const usage = normalizeAnthropicUsage({
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead,
            cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
          },
        })
        expectInputInvariant(usage, input + cacheRead + write5m + write1h)
        expectOutputInvariant(usage, output)
      }),
    )
  })

  /** Malformed input throws. */
  it('throws on malformed usage', () => {
    expect(() => normalizeAnthropicUsage({ usage: { input_tokens: 1 } })).toThrow(Error)
  })

  /** When model is absent, model defaults to empty string. */
  it('defaults model to empty string when model is absent', () => {
    const usage = normalizeAnthropicUsage({ usage: { input_tokens: 10, output_tokens: 5 } })
    expect(usage.model).toBe('')
  })
})

describe('normalizeGeminiUsage', () => {
  /** thoughtsTokenCount maps to reasoning; candidatesTokenCount maps directly (no subtraction). */
  it('maps thoughts to reasoning and tool-use prompt into input', () => {
    const usage = normalizeGeminiUsage({
      modelVersion: 'gemini-2.5-flash',
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 40,
        cachedContentTokenCount: 30,
        thoughtsTokenCount: 15,
        toolUsePromptTokenCount: 8,
      },
    })
    expect(usage).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputTokens: 78,
      cacheReadTokens: 30,
      outputTokens: 40,
      reasoningTokens: 15,
    })
  })

  /** Both §5.5 invariants hold; providerTotalInput folds in tool-use prompt tokens. */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, nat, nat, nat, (prompt, cached, candidates, thoughts, toolUse) => {
        const usage = normalizeGeminiUsage({
          usageMetadata: {
            promptTokenCount: prompt + cached,
            candidatesTokenCount: candidates,
            cachedContentTokenCount: cached,
            thoughtsTokenCount: thoughts,
            toolUsePromptTokenCount: toolUse,
          },
        })
        expectInputInvariant(usage, prompt + cached + toolUse)
        expectOutputInvariant(usage, candidates + thoughts)
      }),
    )
  })

  /** Malformed input throws. */
  it('throws on malformed usageMetadata', () => {
    expect(() => normalizeGeminiUsage({ usageMetadata: {} })).toThrow(Error)
  })

  /** Falls back through modelVersion → model → empty string. */
  it('falls back to model when modelVersion absent, then to empty string when both absent', () => {
    const withModel = normalizeGeminiUsage({ model: 'gemini-pro', usageMetadata: { promptTokenCount: 5 } })
    expect(withModel.model).toBe('gemini-pro')

    const noModel = normalizeGeminiUsage({ usageMetadata: { promptTokenCount: 5 } })
    expect(noModel.model).toBe('')
  })
})

describe('normalizeBedrockConverseUsage', () => {
  /** cacheDetails TTL entries split writes into 5m/1h; a non-object entry is skipped. */
  it('splits cacheDetails TTL entries', () => {
    const usage = normalizeBedrockConverseUsage({
      model: 'us.anthropic.claude',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20,
        cacheDetails: [
          { ttl: '5m', cacheWriteInputTokens: 8 },
          { ttl: '1h', cacheWriteInputTokens: 6 },
          null,
        ],
      },
    })
    expect(usage).toMatchObject({
      provider: 'bedrock',
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheWrite5mTokens: 8,
      cacheWrite1hTokens: 6,
    })
  })

  /** An unsplit cacheWriteInputTokens total defaults to the 5m category. */
  it('defaults an unsplit cache write to 5m', () => {
    const usage = normalizeBedrockConverseUsage({
      usage: { inputTokens: 10, outputTokens: 4, cacheWriteInputTokens: 7 },
    })
    expect(usage.cacheWrite5mTokens).toBe(7)
    expect(usage.cacheWrite1hTokens).toBe(0)
  })

  /** Both §5.5 invariants hold for the unsplit shape. */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, nat, nat, (input, output, cacheRead, cacheWrite) => {
        const usage = normalizeBedrockConverseUsage({
          usage: {
            inputTokens: input,
            outputTokens: output,
            cacheReadInputTokens: cacheRead,
            cacheWriteInputTokens: cacheWrite,
          },
        })
        expectInputInvariant(usage, input + cacheRead + cacheWrite)
        expectOutputInvariant(usage, output)
      }),
    )
  })

  /** Malformed input throws. */
  it('throws on malformed usage', () => {
    expect(() => normalizeBedrockConverseUsage({ usage: { inputTokens: 1 } })).toThrow(Error)
  })

  /** When model is absent, model defaults to empty string. */
  it('defaults model to empty string when model is absent', () => {
    const usage = normalizeBedrockConverseUsage({ usage: { inputTokens: 10, outputTokens: 5 } })
    expect(usage.model).toBe('')
  })
})

describe('normalizeMistralUsage', () => {
  /** Only prompt/completion are mapped; extra fields land in raw. */
  it('maps prompt and completion and preserves extras in raw', () => {
    const usage = normalizeMistralUsage({
      model: 'mistral-large',
      usage: { prompt_tokens: 80, completion_tokens: 30, some_future_field: 9 },
    })
    expect(usage).toMatchObject({ provider: 'mistral', inputTokens: 80, outputTokens: 30 })
    expect(usage.raw).toMatchObject({ some_future_field: 9 })
  })

  /** Both §5.5 invariants hold trivially (no cache, no reasoning). */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, (prompt, completion) => {
        const usage = normalizeMistralUsage({ usage: { prompt_tokens: prompt, completion_tokens: completion } })
        expectInputInvariant(usage, prompt)
        expectOutputInvariant(usage, completion)
      }),
    )
  })

  /** Malformed input throws. */
  it('throws on malformed usage', () => {
    expect(() => normalizeMistralUsage({ usage: { prompt_tokens: 1 } })).toThrow(Error)
  })

  /** When model is absent, model defaults to empty string. */
  it('defaults model to empty string when model is absent', () => {
    const usage = normalizeMistralUsage({ usage: { prompt_tokens: 5, completion_tokens: 3 } })
    expect(usage.model).toBe('')
  })
})

describe('normalizeOpenRouterUsage', () => {
  /** usage.cost converts to provider-reported nano-USD; reasoning is subtracted. */
  it('converts cost to provider-reported nano-USD', () => {
    const usage = normalizeOpenRouterUsage({
      model: 'gpt-5.2',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        cost: 0.0123,
        prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 15 },
      },
    })
    expect(usage).toMatchObject({
      provider: 'openrouter',
      inputTokens: 70,
      outputTokens: 35,
      cacheReadTokens: 20,
      cacheWrite5mTokens: 10,
      reasoningTokens: 15,
      providerReportedCostNanoUsd: floatUsdToNanoUsd(0.0123),
    })
  })

  /** When cost is absent, providerReportedCostNanoUsd is omitted. */
  it('omits provider cost when absent', () => {
    const usage = normalizeOpenRouterUsage({ usage: { prompt_tokens: 10, completion_tokens: 4 } })
    expect(usage.providerReportedCostNanoUsd).toBeUndefined()
  })

  /** Both §5.5 invariants hold for any generated payload. */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, nat, nat, nat, (input, cached, write, out, reasoning) => {
        const usage = normalizeOpenRouterUsage({
          usage: {
            prompt_tokens: input + cached + write,
            completion_tokens: out + reasoning,
            prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: write },
            completion_tokens_details: { reasoning_tokens: reasoning },
          },
        })
        expectInputInvariant(usage, input + cached + write)
        expectOutputInvariant(usage, out + reasoning)
      }),
    )
  })

  /** Malformed input throws. */
  it('throws on malformed usage', () => {
    expect(() => normalizeOpenRouterUsage({ usage: { prompt_tokens: 1 } })).toThrow(Error)
  })

  /** When model is absent, model defaults to empty string. */
  it('defaults model to empty string when model is absent', () => {
    const usage = normalizeOpenRouterUsage({ usage: { prompt_tokens: 5, completion_tokens: 3 } })
    expect(usage.model).toBe('')
  })
})

describe('normalizeVercelAiSdkUsage', () => {
  /** The v5 shape reads cachedInputTokens and reasoningTokens at the usage root. */
  it('normalizes the v5 shape', () => {
    const usage = normalizeVercelAiSdkUsage({
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, reasoningTokens: 15 },
    })
    expect(usage).toMatchObject({ provider: '', inputTokens: 80, outputTokens: 35, cacheReadTokens: 20, reasoningTokens: 15 })
  })

  /** The v6 shape reads the detail sub-objects for cache and reasoning. */
  it('normalizes the v6 shape', () => {
    const usage = normalizeVercelAiSdkUsage({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 10 },
        outputTokenDetails: { reasoningTokens: 15 },
      },
    })
    expect(usage).toMatchObject({ inputTokens: 70, outputTokens: 35, cacheReadTokens: 20, cacheWrite5mTokens: 10, reasoningTokens: 15 })
  })

  /** Both §5.5 invariants hold across the combined v5+v6 read. */
  it('satisfies both reconciliation invariants', () => {
    fc.assert(
      fc.property(nat, nat, nat, nat, (input, cacheRead, cacheWrite, reasoning) => {
        const output = 30
        const usage = normalizeVercelAiSdkUsage({
          usage: {
            inputTokens: input + cacheRead + cacheWrite,
            outputTokens: output + reasoning,
            inputTokenDetails: { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
            outputTokenDetails: { reasoningTokens: reasoning },
          },
        })
        expectInputInvariant(usage, input + cacheRead + cacheWrite)
        expectOutputInvariant(usage, output + reasoning)
      }),
    )
  })

  /** Malformed input throws. */
  it('throws on malformed usage', () => {
    expect(() => normalizeVercelAiSdkUsage({ usage: { inputTokens: 1 } })).toThrow(Error)
  })

  /** When model is absent, model defaults to empty string. */
  it('defaults model to empty string when model is absent', () => {
    const usage = normalizeVercelAiSdkUsage({ usage: { inputTokens: 5, outputTokens: 3 } })
    expect(usage.model).toBe('')
  })
})
