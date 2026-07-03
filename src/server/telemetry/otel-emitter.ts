/**
 * @fileoverview `TelemetryEmitter` — emits OpenTelemetry GenAI (`gen_ai.*`) usage
 * and duration signals for every posted record through the pluggable
 * {@link ITelemetrySink} (spec §14.1). It imports NOTHING from `@opentelemetry/api`
 * — the sink port isolates that optional peer, so the host's sink owns the SDK.
 * NO CONTENT: only token counts, model, provider, operation, and service tier
 * become attributes — prompt/completion text never reaches telemetry. When no sink
 * is configured every call is a cheap no-op that allocates no attribute object
 * (the null guard runs before {@link buildGenAiAttributes}).
 * @layer server
 */

import type { UsageRecord } from '../../shared'
import type { ITelemetrySink } from '../interfaces'

/**
 * Build the `gen_ai.*` attribute set for a record — token counts, model
 * (`requestedModel ?? model` for the request, `model` for the response),
 * operation, provider, and service tier. Never includes prompt/completion text.
 *
 * @param record The posted usage record.
 * @returns The `gen_ai.*` attributes (strings and numbers only).
 */
export function buildGenAiAttributes(record: UsageRecord): Record<string, string | number> {
  return {
    'gen_ai.provider.name': record.provider,
    'gen_ai.request.model': record.requestedModel ?? record.model,
    'gen_ai.response.model': record.model,
    'gen_ai.operation.name': record.operation,
    'gen_ai.request.service_tier': record.serviceTier,
    'gen_ai.usage.input_tokens': record.inputTokens,
    'gen_ai.usage.output_tokens': record.outputTokens,
  }
}

/** Emits GenAI telemetry through a sink, or does nothing when none is configured. */
export class TelemetryEmitter {
  /** @param sink The host telemetry sink, or `null` to disable telemetry. */
  constructor(private readonly sink: ITelemetrySink | null) {}

  /**
   * Record a usage measurement for a posted record (no-op without a sink).
   *
   * @param record The posted usage record.
   */
  recordUsage(record: UsageRecord): void {
    if (this.sink === null) return
    this.sink.recordUsage(buildGenAiAttributes(record), record)
  }

  /**
   * Record an operation duration for a posted record (no-op without a sink, or when
   * the sink does not implement `recordDuration`).
   *
   * @param record The posted usage record.
   * @param milliseconds The measured operation duration.
   */
  recordDuration(record: UsageRecord, milliseconds: number): void {
    const sink = this.sink
    if (sink?.recordDuration === undefined) return
    sink.recordDuration(buildGenAiAttributes(record), milliseconds)
  }
}
