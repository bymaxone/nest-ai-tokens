/**
 * @fileoverview The optional per-tenant tamper-evident hash chain (spec §8.6).
 * When `ledger.hashChain` is enabled, each SETTLED record (`posted`, including
 * compensating records) hashes the previous settled record for its tenant, so any
 * post-hoc modification of a record's content becomes detectable — the SOC 2
 * expectation for billing records.
 *
 * The hashed field set is the immutable settled content: the payload-hash fields
 * (§8.4) plus the record `id`. `status` and `reversedByRecordId` are deliberately
 * EXCLUDED because the sole permitted post-posting mutation is the annotation-only
 * `posted → reversed` flip (§8.3): the chain must survive it (a reversed record
 * keeps its settlement hash, §8.6 rule 1), so the hash cannot depend on fields
 * that the annotation changes. Any change to a content, cost, token, or id field
 * breaks the chain.
 *
 * THROUGHPUT CAVEAT (§20.2): enabling the chain serializes posted writes per tenant
 * (a Postgres advisory lock in the official adapter) — a measurable cost on hot
 * tenants. Leave `ledger.hashChain` off unless tamper evidence is required.
 * @layer server
 */

import type { NewUsageRecord } from '../../shared'
import { deriveIdempotencyKey } from '../../shared'
import { computePayloadHash } from './payload-hash'

/** The outcome of {@link LedgerService.verifyChain}: intact, or the first broken record. */
export type ChainVerification = { valid: true } | { valid: false; brokenAtRecordId: string }

/**
 * Compute a settled record's position in its tenant's tamper-evident chain:
 * a canonical SHA-256 over the previous hash, the record id, and the record's
 * content hash (§8.6). Pure and deterministic. Accepts any record carrying its
 * content plus an `id`, so a store can hash a row before it holds a full
 * {@link UsageRecord}.
 *
 * @param prevHash The previous settled record's hash, or `null` for the genesis record.
 * @param record The settled record being hashed (content fields + `id`).
 * @returns The 64-character lowercase hex chain hash.
 */
export function chainHash(prevHash: string | null, record: NewUsageRecord & { id: string }): string {
  return deriveIdempotencyKey({
    prevHash: prevHash ?? '',
    id: record.id,
    content: computePayloadHash(record),
  })
}
