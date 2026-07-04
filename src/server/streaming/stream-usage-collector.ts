/**
 * @fileoverview `StreamUsageCollector` — abort-safe usage capture for streamed
 * responses (spec §5.6). Provider `usage` arrives only in the final chunk (OpenAI:
 * a trailing chunk with `usage` and empty `choices`; Anthropic: cumulative in
 * `message_delta`, finalized at `message_stop`), and an aborted stream reports
 * all-zero usage even though tokens were consumed. The collector accumulates the
 * output text as chunks flow and, at `finalize()`, prefers the provider-final usage;
 * on an abort it falls back to a tokenizer count of the accumulated output so the
 * call is still billed for what it produced. `push()` NEVER throws — a malformed
 * chunk is skipped and counted. Only token counts and (optionally) the prompt cross
 * this boundary; prompt/response text stays here for counting and is never persisted.
 * @layer server
 */

import type { AiOperation, NormalizedUsage, ProviderId, ProviderPreset, UsageNormalizer } from '../../shared'
import { normalizeAnthropicUsage, normalizeOpenAiChatUsage } from '../../shared'
import { AiTokensException } from '../errors'
import type { ITokenizer } from '../interfaces'

/** Construction options for {@link StreamUsageCollector}. */
export interface StreamUsageCollectorOptions {
  provider: ProviderId
  model: string
  /** The rated operation; defaults to `'chat'`. */
  operation?: AiOperation
  /** How to parse the provider-final usage chunk; defaults to the provider's built-in normalizer. */
  preset?: ProviderPreset
  /** Fallback token counter for aborted streams; defaults to the module tokenizer. */
  tokenizer?: ITokenizer
  /** Custom output-text extractor for providers beyond the OpenAI/Anthropic built-ins. */
  outputText?: (chunk: Record<string, unknown>) => string | undefined
}

/** A zeroed {@link NormalizedUsage} for the given identity. */
function zeroUsage(provider: ProviderId, model: string, operation: AiOperation): NormalizedUsage {
  return {
    provider,
    model,
    operation,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
  }
}

/** Coerce an unknown chunk to a plain record, or `null`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  // Stryker disable next-line ConditionalExpression -- value !== null → true is equivalent: for a null value the cast still yields null, so asRecord(null) returns null regardless
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * Accumulates usage chunks from a streamed provider response and finalises
 * into a {@link NormalizedUsage} object. Prefer the provider's own final
 * usage block; fall back to tokenizer-estimated output tokens when the
 * stream is aborted before the final chunk arrives.
 *
 * @example
 * const collector = new StreamUsageCollector({ provider: 'openai-chat', model: 'gpt-4o' })
 * // call collector.push(chunk) for each SSE chunk
 * const usage = await collector.finalize()
 */
export class StreamUsageCollector {
  private readonly operation: AiOperation
  private outputText = ''
  /** The provider-final response object to normalize, once seen. */
  private finalResponse: unknown = null
  /** Anthropic streaming state accumulated across events (seeded from the constructed identity). */
  private anthropicModel: string
  private anthropicBaseUsage: Record<string, unknown> = {}
  private anthropicOutputTokens = 0
  private promptTokens: number | undefined
  private promptText: string | undefined
  private finalized = false
  private malformed = 0
  /** True after `finalize()` when the tokenizer fallback (not provider-final usage) was used. */
  usedFallback = false

  /** @param opts The provider/model + optional preset/tokenizer/extractor. */
  constructor(private readonly opts: StreamUsageCollectorOptions) {
    this.operation = opts.operation ?? 'chat'
    this.anthropicModel = opts.model
  }

  /** How many chunks were skipped as malformed (debug/observability). */
  get malformedCount(): number {
    return this.malformed
  }

  /** Provide the prompt text so an aborted stream can count input tokens via the tokenizer. */
  setPromptText(text: string): void {
    this.promptText = text
  }

  /** Provide a pre-counted prompt token total (takes precedence over `setPromptText`). */
  setPromptTokens(count: number): void {
    this.promptTokens = count
  }

  /**
   * Feed one stream chunk: accumulate output text and watch for the provider-final
   * usage. Never throws — a malformed chunk is skipped and counted.
   *
   * @param chunk One raw provider stream chunk/event.
   */
  push(chunk: unknown): void {
    try {
      const record = asRecord(chunk)
      if (record === null) {
        this.malformed += 1
        return
      }
      if (this.opts.provider === 'anthropic') this.pushAnthropic(record)
      else this.pushOpenAiLike(record)
    } catch {
      this.malformed += 1
    }
  }

  /**
   * Resolve the final usage: provider-final when seen (normalized), else a tokenizer
   * count of the accumulated output (input tokens from the prompt count when
   * provided, else 0 — the hold estimate is applied by `capture()`), else a
   * missing-usage error. Async to support async tokenizers (§14.2.1). Single-use.
   *
   * @returns The finalized normalized usage.
   * @throws {AiTokensException} `AI_TOKENS_STREAM_USAGE_MISSING` on an abort with no tokenizer; a re-use error on a second call.
   */
  async finalize(): Promise<NormalizedUsage> {
    // Stryker disable next-line ObjectLiteral,StringLiteral -- error context and reason are internal diagnostics; tests check error code only
    if (this.finalized) throw new AiTokensException('AI_TOKENS_STREAM_USAGE_MISSING', undefined, { reason: 'the collector was already finalized' })
    this.finalized = true
    const provider = this.opts.provider
    if (this.finalResponse !== null) return this.normalizeFinal(this.finalResponse)
    const tokenizer = this.opts.tokenizer
    if (tokenizer !== undefined) return this.fallbackUsage(provider, tokenizer)
    // Stryker disable next-line ObjectLiteral -- error context is internal diagnostics
    throw new AiTokensException('AI_TOKENS_STREAM_USAGE_MISSING', undefined, { provider, model: this.opts.model })
  }

  /** Accumulate an OpenAI-shaped chunk and capture its trailing usage. */
  private pushOpenAiLike(record: Record<string, unknown>): void {
    const text = this.opts.outputText?.(record) ?? openAiDelta(record)
    if (text !== undefined) this.outputText += text
    if (asRecord(record.usage) !== null) this.finalResponse = record
  }

  /** Accumulate an Anthropic-shaped event and reconstruct its final usage at message_stop. */
  private pushAnthropic(record: Record<string, unknown>): void {
    const type = record.type
    if (type === 'message_start') {
      const message = asRecord(record.message)
      const usage = asRecord(message?.usage)
      this.anthropicModel = typeof message?.model === 'string' ? message.model : this.opts.model
      this.anthropicBaseUsage = usage ?? {}
      this.anthropicOutputTokens = numberOf(usage?.output_tokens)
    } else if (type === 'content_block_delta') {
      const delta = asRecord(record.delta)
      const text = this.opts.outputText?.(record) ?? (typeof delta?.text === 'string' ? delta.text : undefined)
      if (text !== undefined) this.outputText += text
    } else if (type === 'message_delta') {
      const usage = asRecord(record.usage)
      if (usage !== null) this.anthropicOutputTokens = numberOf(usage.output_tokens)
    } else if (type === 'message_stop') {
      this.finalResponse = {
        model: this.anthropicModel,
        usage: { ...this.anthropicBaseUsage, output_tokens: this.anthropicOutputTokens },
      }
    }
  }

  /** Normalize a captured provider-final response via the preset or the provider default. */
  private normalizeFinal(response: unknown): NormalizedUsage {
    const normalizer: UsageNormalizer =
      this.opts.preset?.normalizer ?? (this.opts.provider === 'anthropic' ? normalizeAnthropicUsage : normalizeOpenAiChatUsage)
    return normalizer(response)
  }

  /** Build the tokenizer-counted fallback usage for an aborted stream. */
  private async fallbackUsage(provider: ProviderId, tokenizer: ITokenizer): Promise<NormalizedUsage> {
    this.usedFallback = true
    const outputTokens = await tokenizer.countTokens({ text: this.outputText, model: this.opts.model, provider })
    const inputTokens = this.promptTokens ?? (this.promptText !== undefined ? await tokenizer.countTokens({ text: this.promptText, model: this.opts.model, provider }) : 0)
    return { ...zeroUsage(provider, this.opts.model, this.operation), inputTokens, outputTokens }
  }
}

/** Concatenate the delta content across an OpenAI chunk's choices. */
function openAiDelta(record: Record<string, unknown>): string | undefined {
  if (!Array.isArray(record.choices)) return undefined
  let text = ''
  for (const choice of record.choices) {
    const delta = asRecord(asRecord(choice)?.delta)
    if (typeof delta?.content === 'string') text += delta.content
  }
  // Stryker disable next-line ConditionalExpression,StringLiteral -- returning '' instead of undefined for empty output is a no-op: the sole caller appends the result to outputText and `outputText += ''` changes nothing, so both CE→false and the empty-string-sentinel mutation are equivalent
  return text === '' ? undefined : text
}

/** Read a finite number, or 0. */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
