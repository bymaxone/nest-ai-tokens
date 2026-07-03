/**
 * @fileoverview `ContentCapture` — the ONLY path prompt/completion text may enter
 * the library (spec §14.2/§14.3). It is OFF by default: unless `options.content` is
 * configured, `capture()` is a pure no-op and no text is touched. When enabled it
 * masks each text via `content.mask` (default identity), then writes it to the
 * opt-in, short-TTL {@link IContentStore} sidecar under its role. The immutable
 * ledger, events, telemetry, and logs NEVER receive text — a sidecar failure is
 * logged (without the text) and never breaks the metering path. `IContentStore.purge`
 * supports erasure independently of the ledger. Internal — not part of the public barrel.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { ResolvedContentOptions } from '../config'

/** The text a host explicitly hands the library for the sidecar (never sourced by the library). */
export interface CaptureContentInput {
  usageRecordId: string
  tenantId: string
  prompt?: string | undefined
  completion?: string | undefined
}

/** Identity mask used when the host configures none. */
const IDENTITY = (text: string): string => text

/**
 * The ONLY path through which prompt/completion text may enter the library.
 * Disabled by default; when enabled, masks and forwards text to the opt-in
 * {@link IContentStore} sidecar. A sidecar failure is always non-fatal. Internal.
 */
export class ContentCapture {
  private readonly logger = new Logger(ContentCapture.name)

  /** @param options The resolved content-sidecar settings (disabled by default). */
  constructor(private readonly options: ResolvedContentOptions) {}

  /**
   * Persist the masked prompt/completion to the content sidecar. A no-op when the
   * feature is disabled or no text was supplied. Failures are logged (never the
   * text) and never rethrown — content capture must not break metering.
   *
   * @param input The record id, tenant, and the host-supplied text.
   */
  async capture(input: CaptureContentInput): Promise<void> {
    if (!this.options.enabled) return
    if (input.prompt === undefined && input.completion === undefined) return
    const { store, ttlSeconds } = this.options
    const mask = this.options.mask ?? IDENTITY
    try {
      if (input.prompt !== undefined) {
        await store.put({ usageRecordId: input.usageRecordId, tenantId: input.tenantId, role: 'prompt', text: mask(input.prompt), ttlSeconds })
      }
      if (input.completion !== undefined) {
        await store.put({ usageRecordId: input.usageRecordId, tenantId: input.tenantId, role: 'completion', text: mask(input.completion), ttlSeconds })
      }
    } catch {
      this.logger.error(`failed to write content sidecar for record ${input.usageRecordId}`)
    }
  }
}

/** The default no-op content capture used when the sidecar is disabled. */
export const NO_OP_CONTENT_CAPTURE = new ContentCapture({ enabled: false })
