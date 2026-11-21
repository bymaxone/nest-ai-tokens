/**
 * @fileoverview The usage a provider reports is read once. Each provider's response reaches its normalizer in a view that answers every
 * field with the value it answered the first time, so a getter that answers a valid count first and another after cannot make a check
 * pass on one value and the sum use another. For every normalizer the response is rebuilt with each of its fields as such a getter:
 * the normalizer must read each field at most once and must return what it returns for the plain response.
 * @layer server
 */

import { providerPresets } from './server/config/provider-presets'
import { viewOf } from './server/utils/usage-view'

/** The response of each provider, with every field its normalizer reads. */
const RESPONSES: readonly (readonly [string, { normalizer: (raw: unknown) => unknown }, Record<string, unknown>])[] = [
  ['openaiChat', providerPresets.openaiChat, { model: 'gpt-4o', service_tier: 'default', usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20, audio_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 10, audio_tokens: 2 } } }],
  ['openaiResponses', providerPresets.openaiResponses, { model: 'gpt-4o', service_tier: 'flex', usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20, audio_tokens: 5 }, output_tokens_details: { reasoning_tokens: 10, audio_tokens: 2 } } }],
  ['azureOpenai', providerPresets.azureOpenai, { model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } } }],
  ['anthropic', providerPresets.anthropic, { model: 'claude-opus', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 }, service_tier: 'standard', server_tool_use: { web_search_requests: 3 } } }],
  ['anthropicUnsplit', providerPresets.anthropic, { model: 'claude-opus', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 40 } }],
  ['gemini', providerPresets.gemini, { modelVersion: 'gemini-2.5', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, cachedContentTokenCount: 20, thoughtsTokenCount: 10, toolUsePromptTokenCount: 4 } }],
  ['bedrock', providerPresets.bedrock, { model: 'claude', usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheDetails: [{ ttl: '1h', cacheWriteInputTokens: 7 }, { ttl: '5m', cacheWriteInputTokens: 3 }] } }],
  ['bedrockUnsplit', providerPresets.bedrock, { model: 'claude', usage: { inputTokens: 100, outputTokens: 50, cacheWriteInputTokens: 9 } }],
  ['mistral', providerPresets.mistral, { model: 'mistral-large', usage: { prompt_tokens: 100, completion_tokens: 50 } }],
  ['vercelAiSdk', providerPresets.vercelAiSdk, { model: 'gpt-4o', usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 2, reasoningTokens: 4, inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 3 }, outputTokenDetails: { reasoningTokens: 4 } } }],
  ['openrouter', providerPresets.openrouter, { model: 'openai/gpt-4o', service_tier: 'default', usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.25, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 10 } } }],
  ['openaiCompatible', providerPresets.openaiCompatible('deepseek'), { model: 'deepseek-chat', usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 5, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } }],
]

/** The reads of every getter of a rebuilt response, by path, and the response whose getters answer a valid value first and another after. */
function stateful(source: unknown, reads: Map<string, number>, path: string): unknown {
  if (typeof source !== 'object' || source === null) return source
  if (Array.isArray(source)) return source.map((item, index) => stateful(item, reads, `${path}[${String(index)}]`))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const at = `${path}.${key}`
    Object.defineProperty(out, key, {
      enumerable: true,
      get: (): unknown => {
        const seen = (reads.get(at) ?? 0) + 1
        reads.set(at, seen)
        const answer = stateful(value, reads, at)
        // Anything the second read answers is another value: a number becomes a different count, and text another text.
        return seen === 1 ? answer : typeof value === 'number' ? value + 1_000 : typeof value === 'string' ? `${value}-again` : answer
      },
    })
  }
  return out
}

describe('the usage a provider reports, read through the view a normalizer gets', () => {
  it.each(RESPONSES)('reads every field of the %s response at most once, and returns what the plain response returns', (_name, preset, response) => {
    const reads = new Map<string, number>()
    const viewed = preset.normalizer(viewOf(stateful(response, reads, '') as object))
    expect(viewed).toEqual(preset.normalizer(response))
    expect([...reads.entries()].filter(([, count]) => count > 1)).toEqual([])
    expect(reads.size).toBeGreaterThan(3)
  })

  it.each(RESPONSES)('reads every field of the %s response exactly once even without the view, as the normalizers are written', (_name, preset, response) => {
    const reads = new Map<string, number>()
    preset.normalizer(stateful(response, reads, ''))
    expect(Math.max(...reads.values())).toBe(1)
  })
})
