/**
 * @fileoverview The OpenTelemetry telemetry port (spec §14.1). Emits `gen_ai.*`
 * attributes and metrics. Content is never captured. Without a sink, telemetry is
 * a no-op.
 * @layer server
 */

import type { UsageRecord } from '../../shared'

/** A pluggable OpenTelemetry sink for gen_ai usage and duration signals. */
export interface ITelemetrySink {
  /** Record a usage measurement with its `gen_ai.*` attributes. */
  recordUsage(attributes: Record<string, string | number>, record: UsageRecord): void
  /** Optionally record an operation duration in milliseconds. */
  recordDuration?(attributes: Record<string, string | number>, milliseconds: number): void
}
