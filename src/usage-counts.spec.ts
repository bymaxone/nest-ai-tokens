/**
 * @fileoverview The counts a provider reports are counts. Every normalizer reads a count that is there as a whole number from 0 to the
 * largest safe integer and refuses anything else (a string, `NaN`, `Infinity`, a negative, a fraction, a number past the safe range, a
 * list, an object) with a plain error, which the service answers as `AI_TOKENS_USAGE_MALFORMED`: a count read as `0` bills a call for less
 * than it used, and a negative one for more. A part of a total (cached, audio, reasoning tokens) that is more than its total is refused,
 * and a container of counts that is there must be an object. What is absent, or `null` as JSON writes an unset field, is `0`.
 * @layer server
 */

import { providerPresets } from './server/config/provider-presets'

type Normalizer = (raw: unknown) => { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number; reasoningTokens: number; serverToolUse?: Record<string, number> }

/** The response of each provider, with every count its normalizer reads, and the names of the counts the response cannot do without. */
const RESPONSES: readonly (readonly [string, { normalizer: (raw: unknown) => unknown }, Record<string, unknown>, readonly string[]])[] = [
  ['openaiChat', providerPresets.openaiChat, { model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20, audio_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 10, audio_tokens: 2 } } }, ['prompt_tokens', 'completion_tokens']],
  ['openaiResponses', providerPresets.openaiResponses, { model: 'gpt-4o', usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20, audio_tokens: 5 }, output_tokens_details: { reasoning_tokens: 10, audio_tokens: 2 } } }, ['input_tokens', 'output_tokens']],
  ['anthropic', providerPresets.anthropic, { model: 'claude-opus', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 }, server_tool_use: { web_search_requests: 3 } } }, ['input_tokens', 'output_tokens']],
  ['anthropicUnsplit', providerPresets.anthropic, { model: 'claude-opus', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 40 } }, ['input_tokens', 'output_tokens']],
  ['gemini', providerPresets.gemini, { modelVersion: 'gemini-2.5', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, cachedContentTokenCount: 20, thoughtsTokenCount: 10, toolUsePromptTokenCount: 4 } }, ['promptTokenCount']],
  ['bedrock', providerPresets.bedrock, { model: 'claude', usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheDetails: [{ ttl: '1h', cacheWriteInputTokens: 7 }, { ttl: '5m', cacheWriteInputTokens: 3 }] } }, ['inputTokens', 'outputTokens']],
  ['bedrockUnsplit', providerPresets.bedrock, { model: 'claude', usage: { inputTokens: 100, outputTokens: 50, cacheWriteInputTokens: 9 } }, ['inputTokens', 'outputTokens']],
  ['mistral', providerPresets.mistral, { model: 'mistral-large', usage: { prompt_tokens: 100, completion_tokens: 50 } }, ['prompt_tokens', 'completion_tokens']],
  ['vercelAiSdk', providerPresets.vercelAiSdk, { model: 'gpt-4o', usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, reasoningTokens: 5, inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 3 }, outputTokenDetails: { reasoningTokens: 4 } } }, ['inputTokens', 'outputTokens']],
  ['openrouter', providerPresets.openrouter, { model: 'openai/gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 10 } } }, ['prompt_tokens', 'completion_tokens']],
  ['openaiCompatible', providerPresets.openaiCompatible('deepseek'), { model: 'deepseek-chat', usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 10, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } }, ['prompt_tokens', 'completion_tokens']],
]

/** Every path of a number in a response, as a list of keys. */
function numberPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === 'number') return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => numberPaths(item, [...path, index]))
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, item]) => numberPaths(item, [...path, key]))
  return []
}

/** A copy of the response with the value at `path` replaced. */
function withValue(response: Record<string, unknown>, path: (string | number)[], replacement: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = structuredClone(response)
  let target: Record<string | number, unknown> = copy
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>
  target[path.at(-1)!] = replacement
  return copy
}

const NOT_A_COUNT: readonly [string, unknown][] = [
  ['a numeric string', '40'],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['a negative', -40],
  ['a fraction', 1.5],
  ['a number past the safe range', 2 ** 53],
  ['1e300', 1e300],
  ['a boolean', true],
  ['a list', []],
  ['an object', {}],
]

describe('the counts of every normalizer', () => {
  it.each(RESPONSES)('%s: the plain response is normalized', (_name, preset, response) => {
    expect(() => preset.normalizer(response)).not.toThrow()
  })

  describe.each(RESPONSES)('%s', (_name, preset, response, required) => {
    const paths = numberPaths(response)
    const cases = paths.flatMap((path) => NOT_A_COUNT.map(([kind, value]) => [path.join('.'), path, kind, value] as const))

    it.each(cases)('refuses %s when it is %s', (_label, path, _kind, value) => {
      expect(() => preset.normalizer(withValue(response, path, value))).toThrow()
    })

    it.each(paths.map((path) => [path.join('.'), path] as const))('reads %s as 0 when it is null, and refuses it when the response cannot do without it', (_label, path) => {
      const mustBeThere = required.includes(String(path.at(-1)))
      const run = (): unknown => preset.normalizer(withValue(response, path, null))
      if (mustBeThere) expect(run).toThrow()
      else expect(run).not.toThrow()
    })
  })

  it.each([
    ['openaiChat', providerPresets.openaiChat, { model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 500 } } }],
    ['openaiChat reasoning past its total', providerPresets.openaiChat, { model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 11 } } }],
    ['openaiResponses', providerPresets.openaiResponses, { model: 'gpt-4o', usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 60, audio_tokens: 41 } } }],
    ['gemini', providerPresets.gemini, { modelVersion: 'gemini', usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 101 } }],
    ['openrouter', providerPresets.openrouter, { model: 'm', usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 41 } } }],
    ['openaiCompatible', providerPresets.openaiCompatible('x'), { model: 'm', usage: { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 60, prompt_tokens_details: { cached_tokens: 41 } } }],
    ['vercelAiSdk', providerPresets.vercelAiSdk, { model: 'm', usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 60, inputTokenDetails: { cacheWriteTokens: 41 } } }],
  ])('refuses a part that is more than its total: %s', (_name, preset, response) => {
    expect(() => preset.normalizer(response)).toThrow()
  })

  it('bills what the response says: a cached count of 40 on a prompt of 100 is 60 input and 40 cached', () => {
    const usage = (providerPresets.openaiChat.normalizer as Normalizer)({ model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } })
    expect([usage.inputTokens, usage.cacheReadTokens]).toEqual([60, 40])
  })

  it.each(['prompt_tokens_details', 'completion_tokens_details'] as const)('refuses %s that is a list, a string or a number, and reads one that is null or absent', (field) => {
    const base = { model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 10 } }
    for (const bad of [[], 'x', 5, true]) expect(() => providerPresets.openaiChat.normalizer({ ...base, usage: { ...base.usage, [field]: bad } })).toThrow()
    expect(() => providerPresets.openaiChat.normalizer({ ...base, usage: { ...base.usage, [field]: null } })).not.toThrow()
    expect(() => providerPresets.openaiChat.normalizer(base)).not.toThrow()
  })

  it.each([['a list', []], ['a string', 'x'], ['a number', 5]] as const)('refuses the cache details of Anthropic and Bedrock that are %s', (_kind, bad) => {
    expect(() => providerPresets.anthropic.normalizer({ model: 'm', usage: { input_tokens: 1, output_tokens: 1, cache_creation: bad } })).toThrow()
    expect(() => providerPresets.anthropic.normalizer({ model: 'm', usage: { input_tokens: 1, output_tokens: 1, server_tool_use: bad } })).toThrow()
    expect(() => providerPresets.bedrock.normalizer({ model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheDetails: bad === 'x' ? 'x' : bad === 5 ? 5 : {} } })).toThrow()
  })

  it('refuses an entry of the cache details of Bedrock that is no object, and counts that add up past the safe range', () => {
    expect(() => providerPresets.bedrock.normalizer({ model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheDetails: [5] } })).toThrow()
    expect(() => providerPresets.bedrock.normalizer({ model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheDetails: [{ ttl: '1h', cacheWriteInputTokens: Number.MAX_SAFE_INTEGER }, { ttl: '1h', cacheWriteInputTokens: 1 }] } })).toThrow()
    expect(() => providerPresets.vercelAiSdk.normalizer({ model: 'm', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: Number.MAX_SAFE_INTEGER, inputTokenDetails: { cacheReadTokens: 1 } } })).toThrow()
  })
})
