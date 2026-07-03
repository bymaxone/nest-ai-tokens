/**
 * @fileoverview Normalizer for the OpenRouter `usage` shape. `usage.cost` is the
 * real charged amount in USD (1 credit = 1 USD) and converts to
 * `providerReportedCostNanoUsd`, enabling `'provider-reported'` rating with no
 * price row. `completion_tokens` includes reasoning, so it is subtracted like
 * OpenAI (spec §5.3/§5.5/§6.5). `cost_details` is preserved in `raw`.
 * @layer shared
 */

import { floatUsdToNanoUsd } from '../pricing/money'
import type { NormalizedUsage } from '../types/normalized-usage'
import { asObject, buildUsage, num, openAiServiceTier, readResponse, requireNum, str } from './usage-fields'

/**
 * Normalize an OpenRouter response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage, including `providerReportedCostNanoUsd` when `usage.cost` is present.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeOpenRouterUsage({ model: 'gpt-5.2', usage: { prompt_tokens: 100, completion_tokens: 40, cost: 0.0123 } })
 */
export function normalizeOpenRouterUsage(raw: unknown): NormalizedUsage {
  const { response, usage } = readResponse(raw, 'openrouter')
  const promptTokens = requireNum(usage.prompt_tokens, 'openrouter', 'usage.prompt_tokens')
  const completionTokens = requireNum(usage.completion_tokens, 'openrouter', 'usage.completion_tokens')

  const promptDetails = asObject(usage.prompt_tokens_details)
  const completionDetails = asObject(usage.completion_tokens_details)
  const cacheReadTokens = num(promptDetails?.cached_tokens)
  const cacheWrite5mTokens = num(promptDetails?.cache_write_tokens)
  const reasoningTokens = num(completionDetails?.reasoning_tokens)

  const cost = usage.cost
  const providerReportedCostNanoUsd =
    typeof cost === 'number' && Number.isFinite(cost) ? floatUsdToNanoUsd(cost) : undefined

  return buildUsage({
    provider: 'openrouter',
    model: str(response.model) ?? '',
    operation: 'chat',
    inputTokens: promptTokens - cacheReadTokens - cacheWrite5mTokens,
    outputTokens: completionTokens - reasoningTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    reasoningTokens,
    serviceTier: openAiServiceTier(response.service_tier),
    providerReportedCostNanoUsd,
    raw: usage,
  })
}
