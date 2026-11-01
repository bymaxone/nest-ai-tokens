/**
 * @fileoverview The provider presets (spec §4.3). Each preset pairs a normalizer
 * with the provider id its records carry and a rating mode; a preset is passed in
 * `MeteringContext.preset`. A preset's `provider` is the id the normalizer stamps, so a
 * record and a hold sized from the same preset are priced from the same rows:
 * `azureOpenai` reuses the OpenAI Chat normalizer and records `openai`, `vertex` reuses
 * the Gemini normalizer and records `gemini`, and both need the caller to pass
 * `baseModel` for a deployment name (§6.6). `openaiCompatible(id)` records the id the
 * caller chose. `vercelAiSdk` cannot know which vendor ran the call, so its records carry
 * no provider and fail loudly; its `'openai'` only sizes a hold. `openrouter` rates in
 * `'provider-reported'` mode.
 * @layer server
 */

import type { ProviderId, ProviderPreset, RatingMode, UsageNormalizer } from '../../shared'
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
} from '../../shared'

/** Assemble a preset. */
function preset(provider: ProviderId, normalizer: UsageNormalizer, ratingMode: RatingMode): ProviderPreset {
  return { provider, normalizer, ratingMode }
}

/** The built-in provider presets, plus the `openaiCompatible(id)` factory. */
export const providerPresets = {
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests that exercise the full preset→MeteringService→UsageRecord path
  openaiChat: preset('openai', normalizeOpenAiChatUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  openaiResponses: preset('openai', normalizeOpenAiResponsesUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  azureOpenai: preset('openai', normalizeOpenAiChatUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  anthropic: preset('anthropic', normalizeAnthropicUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  gemini: preset('gemini', normalizeGeminiUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  vertex: preset('gemini', normalizeGeminiUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  bedrock: preset('bedrock', normalizeBedrockConverseUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  mistral: preset('mistral', normalizeMistralUsage, 'rate-table'),
  vercelAiSdk: preset('openai', normalizeVercelAiSdkUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID and rating mode; only observable via integration tests
  openrouter: preset('openrouter', normalizeOpenRouterUsage, 'provider-reported'),
  /** A custom OpenAI-compatible provider (DeepSeek, xAI, Groq, …); its records carry `id`. */
  openaiCompatible: (id: string): ProviderPreset =>
    preset(id, (raw) => ({ ...normalizeOpenAiCompatibleUsage(raw), provider: id }), 'rate-table'),
}
