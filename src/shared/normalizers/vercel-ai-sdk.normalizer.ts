/**
 * @fileoverview Normalizer for the Vercel AI SDK `usage` shape. It reads BOTH the
 * v5 shape (`usage.{inputTokens, outputTokens, cachedInputTokens, reasoningTokens}`)
 * and the v6 shape (`inputTokenDetails.{cacheReadTokens, cacheWriteTokens}`,
 * `outputTokenDetails.reasoningTokens`). `outputTokens` includes reasoning tokens,
 * so they are subtracted. The SDK does not say which vendor served the call, so the
 * provider is left empty: a record built from this usage has no provider and is not
 * priced from any vendor's rows (spec §5.3).
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import { buildUsage, detailsObject, num, readResponse, remainder, requireNum, str, sumCounts } from './usage-fields'

/**
 * Normalize a Vercel AI SDK response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage; `provider` is always `''`.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeVercelAiSdkUsage({ usage: { inputTokens: 100, outputTokens: 40 } })
 */
export function normalizeVercelAiSdkUsage(raw: unknown): NormalizedUsage {
  const { response, usage } = readResponse(raw, 'vercel-ai-sdk')
  const inputTokensTotal = requireNum(usage.inputTokens, 'vercel-ai-sdk', 'usage.inputTokens')
  const outputTokensTotal = requireNum(usage.outputTokens, 'vercel-ai-sdk', 'usage.outputTokens')

  const inputDetails = detailsObject(usage.inputTokenDetails, 'vercel-ai-sdk', 'usage.inputTokenDetails')
  const outputDetails = detailsObject(usage.outputTokenDetails, 'vercel-ai-sdk', 'usage.outputTokenDetails')
  const cacheReadTokens = sumCounts(num(usage.cachedInputTokens), num(inputDetails?.cacheReadTokens))
  const cacheWrite5mTokens = num(inputDetails?.cacheWriteTokens)
  const reasoningTokens = sumCounts(num(usage.reasoningTokens), num(outputDetails?.reasoningTokens))

  return buildUsage({
    provider: '',
    model: str(response.model) ?? '',
    operation: 'chat',
    inputTokens: remainder(inputTokensTotal, [cacheReadTokens, cacheWrite5mTokens], 'vercel-ai-sdk', 'usage.inputTokens'),
    outputTokens: remainder(outputTokensTotal, [reasoningTokens], 'vercel-ai-sdk', 'usage.outputTokens'),
    cacheReadTokens,
    cacheWrite5mTokens,
    reasoningTokens,
    raw: usage,
  })
}
