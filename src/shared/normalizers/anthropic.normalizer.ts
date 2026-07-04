/**
 * @fileoverview Normalizer for the Anthropic Messages `usage` shape. Anthropic
 * folds thinking into `output_tokens` with no sub-field, so `reasoningTokens`
 * stays `0` (spec §5.3/§5.5). Cache writes split into 5-minute and 1-hour
 * categories via `cache_creation`; an unsplit `cache_creation_input_tokens`
 * total defaults to the 5-minute category. Server tool use maps to `serverToolUse`.
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import {
  asObject,
  buildUsage,
  knownServiceTier,
  num,
  readResponse,
  requireNum,
  str,
  toolUseCounts,
} from './usage-fields'

/**
 * Normalize an Anthropic Messages response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeAnthropicUsage({ model: 'claude-opus', usage: { input_tokens: 100, output_tokens: 40 } })
 */
export function normalizeAnthropicUsage(raw: unknown): NormalizedUsage {
  // Stryker disable next-line StringLiteral -- provider name in error messages is internal diagnostics; tests only check toThrow(Error)
  const { response, usage } = readResponse(raw, 'anthropic')
  // Stryker disable next-line StringLiteral -- provider and field names in error messages are internal diagnostics
  const inputTokens = requireNum(usage.input_tokens, 'anthropic', 'usage.input_tokens')
  // Stryker disable next-line StringLiteral -- provider and field names in error messages are internal diagnostics
  const outputTokens = requireNum(usage.output_tokens, 'anthropic', 'usage.output_tokens')

  const cacheReadTokens = num(usage.cache_read_input_tokens)
  const cacheCreation = asObject(usage.cache_creation)
  const cacheWrite5mTokens = cacheCreation
    ? num(cacheCreation.ephemeral_5m_input_tokens)
    : num(usage.cache_creation_input_tokens)
  const cacheWrite1hTokens = cacheCreation ? num(cacheCreation.ephemeral_1h_input_tokens) : 0

  return buildUsage({
    provider: 'anthropic',
    model: str(response.model) ?? '',
    operation: 'chat',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    serviceTier: knownServiceTier(usage.service_tier),
    serverToolUse: toolUseCounts(usage.server_tool_use),
    raw: usage,
  })
}
