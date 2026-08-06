/**
 * @fileoverview The provider presets (spec §4.3). Each preset pairs a normalizer
 * with the right provider id and rating mode; a preset is passed in
 * `MeteringContext.preset`. `azureOpenai` reuses the OpenAI Chat normalizer but
 * requires the caller to pass `baseModel` (§6.6); `vercelAiSdk` defaults its
 * provider to `'openai'` and expects a per-call override; `openrouter` rates in
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
  azureOpenai: preset('azure-openai', normalizeOpenAiChatUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  anthropic: preset('anthropic', normalizeAnthropicUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  gemini: preset('gemini', normalizeGeminiUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  vertex: preset('vertex', normalizeGeminiUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  bedrock: preset('bedrock', normalizeBedrockConverseUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID; only observable via integration tests
  mistral: preset('mistral', normalizeMistralUsage, 'rate-table'),
  vercelAiSdk: preset('openai', normalizeVercelAiSdkUsage, 'rate-table'),
  // Stryker disable next-line StringLiteral: provider ID and rating mode; only observable via integration tests
  openrouter: preset('openrouter', normalizeOpenRouterUsage, 'provider-reported'),
  /** A custom OpenAI-compatible provider (DeepSeek, xAI, Groq, …). */
  openaiCompatible: (id: string): ProviderPreset => preset(id, normalizeOpenAiCompatibleUsage, 'rate-table'),
}
