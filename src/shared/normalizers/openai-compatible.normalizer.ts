/**
 * @fileoverview Normalizer for OpenAI-compatible gateways (DeepSeek, xAI, Groq, …)
 * that reuse the Chat Completions `prompt_tokens` / `completion_tokens` shape
 * without OpenAI-specific detail guarantees. DeepSeek's `prompt_cache_hit_tokens`
 * maps to `cacheReadTokens` when present. The provider id is left empty for the
 * preset (`providerPresets.openaiCompatible(id)`) or context to supply (spec §5.3).
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import { asObject, buildUsage, num, openAiServiceTier, readResponse, requireNum, str } from './usage-fields'

/**
 * Normalize an OpenAI-compatible chat response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage; `provider` is `''` unless the preset overrides it.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeOpenAiCompatibleUsage({ model: 'deepseek-chat', usage: { prompt_tokens: 100, completion_tokens: 40 } })
 */
export function normalizeOpenAiCompatibleUsage(raw: unknown): NormalizedUsage {
  const { response, usage } = readResponse(raw, 'openai-compatible')
  const promptTokens = requireNum(usage.prompt_tokens, 'openai-compatible', 'usage.prompt_tokens')
  const completionTokens = requireNum(usage.completion_tokens, 'openai-compatible', 'usage.completion_tokens')

  const promptDetails = asObject(usage.prompt_tokens_details)
  const completionDetails = asObject(usage.completion_tokens_details)
  // DeepSeek reports cache hits at the usage root; OpenAI-style gateways nest them.
  const cacheReadTokens = num(usage.prompt_cache_hit_tokens) + num(promptDetails?.cached_tokens)
  const reasoningTokens = num(completionDetails?.reasoning_tokens)

  const serviceTier = openAiServiceTier(response.service_tier)
  return buildUsage({
    provider: '',
    model: str(response.model) ?? '',
    operation: 'chat',
    inputTokens: promptTokens - cacheReadTokens,
    outputTokens: completionTokens - reasoningTokens,
    cacheReadTokens,
    reasoningTokens,
    serviceTier,
    raw: usage,
  })
}
