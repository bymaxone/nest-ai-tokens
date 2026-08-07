/**
 * @fileoverview Normalizer for the OpenAI Chat Completions `usage` shape. The
 * critical rule (spec §5.3/§5.5): `completion_tokens` INCLUDES reasoning tokens,
 * so `outputTokens = completion_tokens − reasoning_tokens` — double-billing that
 * detail is the audit's #1 billing bug. Cached and audio prompt tokens are a
 * subset of `prompt_tokens` and are split into their own categories.
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import { asObject, buildUsage, num, openAiServiceTier, readResponse, requireNum, str } from './usage-fields'

/**
 * Normalize an OpenAI Chat Completions response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeOpenAiChatUsage({ model: 'gpt-5.2', usage: { prompt_tokens: 100, completion_tokens: 40 } })
 */
export function normalizeOpenAiChatUsage(raw: unknown): NormalizedUsage {
  // Stryker disable next-line StringLiteral: provider and field names in error messages are internal diagnostics; tests only check toThrow(Error)
  const { response, usage } = readResponse(raw, 'openai-chat')
  // Stryker disable next-line StringLiteral: provider and field names in error messages are internal diagnostics
  const promptTokens = requireNum(usage.prompt_tokens, 'openai-chat', 'usage.prompt_tokens')
  // Stryker disable next-line StringLiteral: provider and field names in error messages are internal diagnostics
  const completionTokens = requireNum(usage.completion_tokens, 'openai-chat', 'usage.completion_tokens')

  const promptDetails = asObject(usage.prompt_tokens_details)
  const completionDetails = asObject(usage.completion_tokens_details)
  const cacheReadTokens = num(promptDetails?.cached_tokens)
  const audioInTokens = num(promptDetails?.audio_tokens)
  const reasoningTokens = num(completionDetails?.reasoning_tokens)
  const audioOutTokens = num(completionDetails?.audio_tokens)

  const serviceTier = openAiServiceTier(response.service_tier)
  return buildUsage({
    provider: 'openai',
    model: str(response.model) ?? '',
    operation: 'chat',
    inputTokens: promptTokens - cacheReadTokens - audioInTokens,
    outputTokens: completionTokens - reasoningTokens,
    cacheReadTokens,
    reasoningTokens,
    audioInTokens,
    audioOutTokens,
    serviceTier,
    raw: usage,
  })
}
