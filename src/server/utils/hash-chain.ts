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

import type { NewUsageRecord, UsageRecord } from '../../shared'
import { deriveIdempotencyKey } from '../../shared'
import { computePayloadHash } from './payload-hash'

/**
 * Records that share one predecessor. `parentHash` is the shared `prevHash`, `null` for records that
 * share the genesis position; `records` lists the siblings oldest first by `createdAt`, ties broken by id.
 */
export interface ChainFork {
  parentHash: string | null
  records: { id: string; createdAt: Date }[]
}

/**
 * The outcome of {@link LedgerService.verifyChain}. `unchainedCount` is the number of settled
 * records that carry no chain hash (written before the chain was enabled): they are counted, not
 * verified, and the chain does not protect them. `chainStartsAtRecordId` is the genesis record when
 * the verified records include it. `forks` is present only when two or more verified records name the
 * same predecessor; the chain stays valid, because a fork alone is not proof of tampering. The official
 * adapter links each record to the single tail under a per-tenant lock, so a fork among the records it
 * wrote is unexpected: investigate it. A store that chose another predecessor can fork legitimately, and
 * the library cannot tell the two apart; the siblings' `createdAt` against the date you began using the
 * single-tail adapter does. The third variant means settled records exist and none carries a hash or a `prevHash`,
 * i.e. the chain was never enabled for this tenant, which is not evidence of tampering.
 */
export type ChainVerification =
  | { valid: true; unchainedCount: number; chainStartsAtRecordId?: string; forks?: ChainFork[] }
  | { valid: false; brokenAtRecordId: string; unchainedCount: number }
  | { valid: false; status: 'never-enabled'; unchainedCount: number }

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
    // Stryker disable next-line StringLiteral: empty-string fallback for null prevHash; tests only verify hash determinism and inequality, not the specific hash value for a genesis block
    prevHash: prevHash ?? '',
    id: record.id,
    content: computePayloadHash(record),
  })
}

/**
 * Verify a tenant's settled records against the hash chain. The chain is walked by its links
 * (`prevHash` to `hash`), not by row order, because a record links to the hashed record created
 * last while rows are listed by creation time: a hold created before a record that settled first
 * sits ahead of it in the listing yet links to it.
 *
 * Every hashed record must recompute from its own `prevHash`. With `structural` set (an unbounded
 * call), the hashed records must also form one chain: exactly one head, the record whose
 * `prevHash` is not another record's hash, and that head must be the genesis (no `prevHash`).
 * Two records may share a predecessor. The chain stays valid and the shared predecessors are returned
 * as `forks`, because a fork alone does not prove tampering.
 * Records without a hash are counted as unchained; one that still carries a `prevHash` is a chained
 * record whose hash was removed and is reported as broken. A `from`/`to` window can cut the chain
 * anywhere, so a bounded call checks each record's own hash and skips the structural rules.
 *
 * @param records The tenant's settled (`posted` and `reversed`) records in listing order.
 * @param structural Whether the records are the whole chain (no `from`/`to` bounds).
 * @returns The verification outcome.
 */
export function verifyChainRecords(records: UsageRecord[], structural: boolean): ChainVerification {
  const hashed = records.filter((record) => record.hash !== undefined)
  const unchainedCount = records.length - hashed.length
  const stripped = records.find((record) => record.hash === undefined && record.prevHash !== undefined)
  if (stripped !== undefined) return { valid: false, brokenAtRecordId: stripped.id, unchainedCount }
  const forged = hashed.find((record) => record.hash !== chainHash(record.prevHash ?? null, record))
  if (forged !== undefined) return { valid: false, brokenAtRecordId: forged.id, unchainedCount }
  if (hashed.length === 0) {
    return records.length === 0
      ? { valid: true, unchainedCount }
      : { valid: false, status: 'never-enabled', unchainedCount }
  }
  const hashes = new Set(hashed.map((record) => record.hash))
  const heads = hashed.filter((record) => !hashes.has(record.prevHash))
  const genesis = heads.find((record) => record.prevHash === undefined)
  if (structural) {
    // Any head other than the genesis lost its predecessor: a gap, or a front that was cut off.
    const offending = heads.find((record) => record !== genesis)
    if (offending !== undefined) return { valid: false, brokenAtRecordId: offending.id, unchainedCount }
  }
  const forks = forksOf(hashed)
  return {
    valid: true,
    unchainedCount,
    ...(genesis === undefined ? {} : { chainStartsAtRecordId: genesis.id }),
    ...(forks.length === 0 ? {} : { forks }),
  }
}

/** The groups of two or more hashed records that share a predecessor, in order of first appearance. */
function forksOf(hashed: UsageRecord[]): ChainFork[] {
  const byParent = new Map<string | null, UsageRecord[]>()
  for (const record of hashed) {
    const parent = record.prevHash ?? null
    byParent.set(parent, [...(byParent.get(parent) ?? []), record])
  }
  return [...byParent]
    .filter(([, siblings]) => siblings.length > 1)
    .map(([parentHash, siblings]) => ({
      parentHash,
      records: siblings
        .map(({ id, createdAt }) => ({ id, createdAt }))
        // Stryker disable next-line EqualityOperator: record ids are unique, so the comparator never sees two equal ids and < and <= order identically
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)),
    }))
}
