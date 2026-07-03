/**
 * @fileoverview The optional prompt/response content sidecar port (spec §14.2).
 * The immutable ledger NEVER stores text; hosts opt into a separate, redacted,
 * short-TTL sidecar. `purge()` supports erasure requests independently of the
 * ledger.
 * @layer server
 */

/** The opt-in, redacted, short-TTL content sidecar port. */
export interface IContentStore {
  /** Persist masked text for a record with a TTL. */
  put(input: {
    usageRecordId: string
    tenantId: string
    role: 'prompt' | 'completion'
    text: string
    ttlSeconds: number
  }): Promise<void>
  /** Delete stored text by tenant, record, or subject; returns the number purged. */
  purge(filter: { tenantId: string; usageRecordId?: string; subjectId?: string }): Promise<number>
}
