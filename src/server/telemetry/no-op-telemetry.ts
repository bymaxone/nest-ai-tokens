/**
 * @fileoverview The default telemetry binding — a {@link TelemetryEmitter} over a
 * `null` sink (spec §14.1). `MeteringService` uses this when the host configures no
 * telemetry, so every emission is a no-op that allocates no attribute object.
 * Internal — not part of the public barrel.
 * @layer server
 */

import { TelemetryEmitter } from './otel-emitter'

/** The no-op telemetry emitter used when no sink is configured. */
export const NO_OP_TELEMETRY = new TelemetryEmitter(null)
