/**
 * @fileoverview Normalizer for the Vercel AI SDK `usage` shape. It reads BOTH the
 * v5 shape (`usage.{inputTokens, outputTokens, cachedInputTokens, reasoningTokens}`)
 * and the v6 shape (`inputTokenDetails.{cacheReadTokens, cacheWriteTokens}`,
 * `outputTokenDetails.reasoningTokens`). `outputTokens` includes reasoning tokens,
 * so they are subtracted. The provider id and model are supplied by the caller's
 * preset/context and default to empty here (spec §5.3).
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import { asObject, buildUsage, num, readResponse, requireNum, str } from './usage-fields'

/**
 * Normalize a Vercel AI SDK response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage; `provider` is `''` unless the context overrides it.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeVercelAiSdkUsage({ usage: { inputTokens: 100, outputTokens: 40 } })
 */
export function normalizeVercelAiSdkUsage(raw: unknown): NormalizedUsage {
  const { response, usage } = readResponse(raw, 'vercel-ai-sdk')
  const inputTokensTotal = requireNum(usage.inputTokens, 'vercel-ai-sdk', 'usage.inputTokens')
  const outputTokensTotal = requireNum(usage.outputTokens, 'vercel-ai-sdk', 'usage.outputTokens')

  const inputDetails = asObject(usage.inputTokenDetails)
  const outputDetails = asObject(usage.outputTokenDetails)
  const cacheReadTokens = num(usage.cachedInputTokens) + num(inputDetails?.cacheReadTokens)
  const cacheWrite5mTokens = num(inputDetails?.cacheWriteTokens)
  const reasoningTokens = num(usage.reasoningTokens) + num(outputDetails?.reasoningTokens)

  return buildUsage({
    provider: '',
    model: str(response.model) ?? '',
    operation: 'chat',
    inputTokens: inputTokensTotal - cacheReadTokens - cacheWrite5mTokens,
    outputTokens: outputTokensTotal - reasoningTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    reasoningTokens,
    raw: usage,
  })
}
