/**
 * @fileoverview Normalizer for the AWS Bedrock Converse `usage` shape. Cache
 * writes come either as a single `cacheWriteInputTokens` total (defaulting to the
 * 5-minute category) or split across `cacheDetails[]` TTL entries (spec §5.3).
 * Model ids like `us.anthropic.claude-…-v1:0` are region-prefixed and are
 * resolved downstream (spec §6.6).
 * @layer shared
 */

import type { NormalizedUsage } from '../types/normalized-usage'
import { asArray, asObject, buildUsage, num, readResponse, requireNum, str } from './usage-fields'

/** Split Bedrock cache-write tokens into 5-minute and 1-hour categories. */
function splitCacheWrite(usage: Record<string, unknown>): {
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
} {
  const details = asArray(usage.cacheDetails)
  if (details === undefined) {
    // An unsplit total defaults to the 5-minute cache.
    return { cacheWrite5mTokens: num(usage.cacheWriteInputTokens), cacheWrite1hTokens: 0 }
  }
  let cacheWrite5mTokens = 0
  let cacheWrite1hTokens = 0
  for (const item of details) {
    const entry = asObject(item)
    if (entry === undefined) continue
    const count = num(entry.cacheWriteInputTokens)
    if (str(entry.ttl) === '1h') cacheWrite1hTokens += count
    else cacheWrite5mTokens += count
  }
  return { cacheWrite5mTokens, cacheWrite1hTokens }
}

/**
 * Normalize a Bedrock Converse response into {@link NormalizedUsage}.
 *
 * @param raw The provider response object (with a nested `usage`).
 * @returns The canonical usage.
 * @throws {Error} When the `usage` object or its required token fields are absent.
 * @example
 * normalizeBedrockConverseUsage({ model: 'us.anthropic.claude', usage: { inputTokens: 100, outputTokens: 40 } })
 */
export function normalizeBedrockConverseUsage(raw: unknown): NormalizedUsage {
  // Stryker disable next-line StringLiteral -- provider name in error messages is internal diagnostics; tests only check toThrow(Error)
  const { response, usage } = readResponse(raw, 'bedrock-converse')
  // Stryker disable next-line StringLiteral -- provider and field names in error messages are internal diagnostics
  const inputTokens = requireNum(usage.inputTokens, 'bedrock-converse', 'usage.inputTokens')
  // Stryker disable next-line StringLiteral -- provider and field names in error messages are internal diagnostics
  const outputTokens = requireNum(usage.outputTokens, 'bedrock-converse', 'usage.outputTokens')
  const { cacheWrite5mTokens, cacheWrite1hTokens } = splitCacheWrite(usage)

  return buildUsage({
    provider: 'bedrock',
    model: str(response.model) ?? '',
    operation: 'chat',
    inputTokens,
    outputTokens,
    cacheReadTokens: num(usage.cacheReadInputTokens),
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    raw: usage,
  })
}
