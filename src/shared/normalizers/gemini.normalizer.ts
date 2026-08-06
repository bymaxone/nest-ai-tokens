/**
 * @fileoverview Normalizer for the Google Gemini / Vertex `usageMetadata` shape.
 * `candidatesTokenCount` EXCLUDES thoughts, so it maps directly to `outputTokens`
 * with no subtraction; `thoughtsTokenCount` maps to `reasoningTokens`;
 * `toolUsePromptTokenCount` folds into `inputTokens` (billed at the input rate);
 * `cachedContentTokenCount` is the cache-read portion of the prompt (spec §5.3).
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import { buildUsage, num, readResponse, requireNum, str } from './usage-fields'

/**
 * Normalize a Gemini / Vertex response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usageMetadata`).
 * @returns The canonical usage.
 * @throws {Error} When `usageMetadata` or its required token field is absent.
 * @example
 * normalizeGeminiUsage({ modelVersion: 'gemini-2.5-flash', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40 } })
 */
export function normalizeGeminiUsage(raw: unknown): NormalizedUsage {
  // Stryker disable next-line StringLiteral: provider name and usage key in error messages are internal diagnostics; tests only check toThrow(Error)
  const { response, usage } = readResponse(raw, 'gemini', 'usageMetadata')
  // Stryker disable next-line StringLiteral: provider and field names in error messages are internal diagnostics
  const promptTokenCount = requireNum(usage.promptTokenCount, 'gemini', 'usageMetadata.promptTokenCount')
  const candidatesTokenCount = num(usage.candidatesTokenCount)
  const cacheReadTokens = num(usage.cachedContentTokenCount)
  const reasoningTokens = num(usage.thoughtsTokenCount)
  const toolUseInputTokens = num(usage.toolUsePromptTokenCount)

  return buildUsage({
    provider: 'gemini',
    model: str(response.modelVersion) ?? str(response.model) ?? '',
    operation: 'chat',
    inputTokens: promptTokenCount - cacheReadTokens + toolUseInputTokens,
    outputTokens: candidatesTokenCount,
    cacheReadTokens,
    reasoningTokens,
    raw: usage,
  })
}
