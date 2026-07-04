/**
 * @fileoverview Normalizer for the Mistral `usage` shape. v0.1 maps
 * `prompt_tokens` / `completion_tokens` only; any additional audio/cache detail
 * fields are version-dependent and preserved verbatim in `raw` (spec §5.3/§20.3).
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import { buildUsage, readResponse, requireNum, str } from './usage-fields'

/**
 * Normalize a Mistral response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeMistralUsage({ model: 'mistral-large', usage: { prompt_tokens: 100, completion_tokens: 40 } })
 */
export function normalizeMistralUsage(raw: unknown): NormalizedUsage {
  // Stryker disable next-line StringLiteral -- provider name in error messages is internal diagnostics; tests only check toThrow(Error)
  const { response, usage } = readResponse(raw, 'mistral')
  return buildUsage({
    provider: 'mistral',
    model: str(response.model) ?? '',
    operation: 'chat',
    // Stryker disable next-line StringLiteral -- provider and field names in error messages are internal diagnostics
    inputTokens: requireNum(usage.prompt_tokens, 'mistral', 'usage.prompt_tokens'),
    // Stryker disable next-line StringLiteral -- provider and field names in error messages are internal diagnostics
    outputTokens: requireNum(usage.completion_tokens, 'mistral', 'usage.completion_tokens'),
    raw: usage,
  })
}
