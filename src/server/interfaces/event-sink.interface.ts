/**
 * @fileoverview The programmatic event-delivery port (spec §12.1). A sink ships
 * events to webhooks, queues, or realtime fan-out. Sink failures are logged,
 * never thrown into the metering path. `bigint` payload fields are serialized as
 * decimal strings at the JSON boundary (§15.5).
 * @layer server
 */

import type { AiTokensEvent } from '../../shared'

/** A programmatic sink for the library's typed events. */
export interface IEventSink {
  /** Deliver one event (at-least-once). */
  deliver(event: AiTokensEvent): Promise<void>
}
