/**
 * @fileoverview Normalizer for the OpenAI Responses API `usage` shape. Same
 * reasoning-subtraction rule as Chat Completions, but the fields are renamed
 * `input_tokens` / `output_tokens` with `input_tokens_details` /
 * `output_tokens_details` (spec §5.3).
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import { asObject, buildUsage, num, openAiServiceTier, readResponse, requireNum, str } from './usage-fields'

/**
 * Normalize an OpenAI Responses API response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeOpenAiResponsesUsage({ model: 'gpt-5.2', usage: { input_tokens: 100, output_tokens: 40 } })
 */
export function normalizeOpenAiResponsesUsage(raw: unknown): NormalizedUsage {
  const { response, usage } = readResponse(raw, 'openai-responses')
  const inputTokensTotal = requireNum(usage.input_tokens, 'openai-responses', 'usage.input_tokens')
  const outputTokensTotal = requireNum(usage.output_tokens, 'openai-responses', 'usage.output_tokens')

  const inputDetails = asObject(usage.input_tokens_details)
  const outputDetails = asObject(usage.output_tokens_details)
  const cacheReadTokens = num(inputDetails?.cached_tokens)
  const audioInTokens = num(inputDetails?.audio_tokens)
  const reasoningTokens = num(outputDetails?.reasoning_tokens)
  const audioOutTokens = num(outputDetails?.audio_tokens)

  const serviceTier = openAiServiceTier(response.service_tier)
  return buildUsage({
    provider: 'openai',
    model: str(response.model) ?? '',
    operation: 'responses',
    inputTokens: inputTokensTotal - cacheReadTokens - audioInTokens,
    outputTokens: outputTokensTotal - reasoningTokens,
    cacheReadTokens,
    reasoningTokens,
    audioInTokens,
    audioOutTokens,
    serviceTier,
    raw: usage,
  })
}
