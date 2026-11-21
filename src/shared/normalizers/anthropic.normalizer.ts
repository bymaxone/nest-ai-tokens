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
  buildUsage,
  detailsObject,
  knownServiceTier,
  num,
  readResponse,
  requireNum,
  str,
  sumCounts,
  toolUseCounts,
} from './usage-fields'

/**
 * The cache writes of a response: the split of `cache_creation` when it reports one, else the unsplit total (which counts as the 5-minute
 * cache). The total and the split are the same tokens twice, so a response that carries both must carry the same number.
 */
function cacheWrites(split: Record<string, unknown> | undefined, total: unknown): { cacheWrite5mTokens: number; cacheWrite1hTokens: number } {
  const part5m = split?.ephemeral_5m_input_tokens
  const part1h = split?.ephemeral_1h_input_tokens
  const reported = (part5m !== undefined && part5m !== null) || (part1h !== undefined && part1h !== null)
  if (!reported) return { cacheWrite5mTokens: num(total), cacheWrite1hTokens: 0 }
  const cacheWrite5mTokens = num(part5m)
  const cacheWrite1hTokens = num(part1h)
  if (total !== undefined && total !== null && num(total) !== sumCounts(cacheWrite5mTokens, cacheWrite1hTokens)) {
    throw new Error('anthropic: "usage.cache_creation_input_tokens" and the parts of "usage.cache_creation" differ')
  }
  return { cacheWrite5mTokens, cacheWrite1hTokens }
}

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
  const { response, usage } = readResponse(raw, 'anthropic')
  const inputTokens = requireNum(usage.input_tokens, 'anthropic', 'usage.input_tokens')
  const outputTokens = requireNum(usage.output_tokens, 'anthropic', 'usage.output_tokens')

  const cacheReadTokens = num(usage.cache_read_input_tokens)
  const cacheCreation = detailsObject(usage.cache_creation, 'anthropic', 'usage.cache_creation')
  const { cacheWrite5mTokens, cacheWrite1hTokens } = cacheWrites(cacheCreation, usage.cache_creation_input_tokens)

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
    serverToolUse: toolUseCounts(usage.server_tool_use, 'anthropic'),
    raw: usage,
  })
}
