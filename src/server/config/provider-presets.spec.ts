/**
 * @fileoverview The provider id and rating mode of every built-in preset, which reach the usage record a host reads.
 * @layer server
 */
import { providerPresets } from './provider-presets'

describe('providerPresets', () => {
  /** The provider id prices and reports a record; the rating mode says whether the provider's own cost is taken. */
  it.each([
    ['openaiChat', 'openai', 'rate-table'],
    ['openaiResponses', 'openai', 'rate-table'],
    ['azureOpenai', 'openai', 'rate-table'],
    ['anthropic', 'anthropic', 'rate-table'],
    ['gemini', 'gemini', 'rate-table'],
    ['vertex', 'gemini', 'rate-table'],
    ['bedrock', 'bedrock', 'rate-table'],
    ['mistral', 'mistral', 'rate-table'],
    ['vercelAiSdk', 'openai', 'rate-table'],
    ['openrouter', 'openrouter', 'provider-reported'],
  ] as const)('%s is of provider %s, rated by %s', (name, provider, ratingMode) => {
    const preset = providerPresets[name]
    expect([preset.provider, preset.ratingMode]).toEqual([provider, ratingMode])
  })

  /** A custom OpenAI-compatible preset carries the host's id, on itself and on what it normalizes. */
  it('carries the id given to openaiCompatible', () => {
    const preset = providerPresets.openaiCompatible('deepseek')
    expect([preset.provider, preset.ratingMode]).toEqual(['deepseek', 'rate-table'])
    expect(preset.normalizer({ model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } }).provider).toBe('deepseek')
  })
})
