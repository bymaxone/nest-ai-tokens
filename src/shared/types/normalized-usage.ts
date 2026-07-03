/**
 * @fileoverview The canonical usage shape every provider normalizer produces.
 * Downstream pricing, ledger, and budget logic is generic over this type, so it
 * never sees a provider-specific payload.
 * @layer shared
 */

import type { AiOperation } from '../constants/operations.constants'
import type { ServiceTier } from '../constants/service-tiers.constants'
import type { ProviderId } from './catalogs'

/**
 * Provider-agnostic, per-call token and cost usage. All token counts are plain
 * `number` (well under 2^53 per record); money is `bigint` nano-USD.
 */
export interface NormalizedUsage {
  provider: ProviderId
  /** Model id as reported by the RESPONSE (may be a dated snapshot — see spec §6.6). */
  model: string
  operation: AiOperation
  /** Tier reported by the response; absent → `'standard'`. */
  serviceTier?: ServiceTier
  /** Uncached, non-reasoning input tokens (after the last cache breakpoint). */
  inputTokens: number
  /**
   * Output/completion tokens EXCLUDING reasoning tokens (§5.5 invariant).
   * Anthropic folds thinking into output with no sub-field, so its adapter leaves
   * `reasoningTokens` at 0 and keeps everything here.
   */
  outputTokens: number
  /** Tokens served from a cache hit (billed at a fraction of input). */
  cacheReadTokens: number
  /** Tokens written to a 5-minute cache (Anthropic 1.25× input; Bedrock cacheWrite). */
  cacheWrite5mTokens: number
  /** Tokens written to a 1-hour cache (Anthropic 2× input). */
  cacheWrite1hTokens: number
  /** Reasoning/thinking tokens reported separately (OpenAI, Gemini). */
  reasoningTokens: number
  /** Audio input tokens (multimodal). */
  audioInTokens: number
  /** Audio output tokens (multimodal). */
  audioOutTokens: number
  /** Image input tokens (multimodal). */
  imageInTokens: number
  /** Image output tokens (multimodal). */
  imageOutTokens: number
  /**
   * Server-side tool usage counts — NON-token line items rated via
   * `PriceVersion.unitRates` (§6.2), e.g. `{ web_search_requests: 2 }`. Anthropic
   * reports these in `usage.server_tool_use`; for OpenAI/Gemini the host passes
   * counts via `MeteringContext.extraUnits`.
   */
  serverToolUse?: Record<string, number>
  /** Provider-reported cost in nano-USD when available (OpenRouter `usage.cost`). */
  providerReportedCostNanoUsd?: bigint
  /** Unclassified fields preserved verbatim for audit. */
  raw?: Record<string, unknown>
}
