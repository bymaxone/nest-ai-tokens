/**
 * @fileoverview An in-memory {@link IWalletStore} for tests — a faithful stand-in
 * for the Prisma wallet half: auto-create on first grant/positive adjust, per-wallet
 * idempotency on `(walletId, idempotencyKey)` (replay on a matching entry-payload
 * hash, {@link LedgerIdempotencyConflict} on a mismatch), a materialized balance
 * kept as the signed sum of every entry, an atomic conditional debit that reserves
 * against that balance in one synchronous critical section (no read-check-write
 * gap — the fake models the §9.4 conditional `UPDATE`), grant burn-down with a
 * persisted allocation trail and lazy expiry entries, and reconciliation. Lives
 * under `test/` so it is not collected for coverage.
 *
 * Balance model (single source of truth = the entries, §9.4): the materialized
 * column equals the signed sum of every entry. A read-side `computeBalance(now)`
 * additionally subtracts the unspent remainder of any grant that is future-effective
 * or already expired, so `getBalance()` never reports credit that cannot be spent —
 * the conditional debit first sweeps expired grants (writing their `expiry` entries),
 * which brings the materialized column into agreement before the atomic reserve.
 * @layer test
 */

import { randomUUID } from 'node:crypto'
import type { NewWalletEntry, Wallet, WalletEntry, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import { deriveIdempotencyKey } from '@bymax-one/nest-ai-tokens/shared'
import type {
  IWalletStore,
  OpenGrant,
  WalletEntryFilter,
  WalletEntryPage,
} from '@bymax-one/nest-ai-tokens'
import { LedgerIdempotencyConflict } from '../../src/server/services/ledger-idempotency-conflict'

/** A persisted debit→grant allocation (the audit trail of §9.3). */
export interface WalletAllocation {
  debitEntryId: string
  grantEntryId: string
  amountNanoUsd: bigint
}

/** The grant burn order the store applies inside {@link InMemoryWalletStore.conditionalDebit}. */
export type BurnOrder = 'expiry' | 'priority' | 'fifo'

/** Construction options for the in-memory wallet store. */
export interface InMemoryWalletStoreOptions {
  /** Grant burn order for debit allocation. Default `'expiry'`. */
  burnOrder?: BurnOrder
  /** Injected clock; defaults to the real wall clock. */
  now?: () => Date
}

/** A Map-backed materialized-balance wallet store for unit/contract tests. */
export class InMemoryWalletStore implements IWalletStore {
  /** Wallets keyed by `tenantId|ownerType|ownerId`. */
  private readonly wallets = new Map<string, Wallet>()
  /** Entries keyed by wallet id, in append order. */
  private readonly entries = new Map<string, WalletEntry[]>()
  /** Replay map keyed by `walletId|idempotencyKey` → the stored entry and its payload hash. */
  private readonly idempotency = new Map<string, { entry: WalletEntry; hash: string }>()
  /** Allocations keyed by the consuming entry id (a debit or an expiry entry). */
  private readonly allocations = new Map<string, WalletAllocation[]>()
  private readonly burnOrder: BurnOrder
  private readonly now: () => Date

  constructor(options: InMemoryWalletStoreOptions = {}) {
    this.burnOrder = options.burnOrder ?? 'expiry'
    this.now = options.now ?? ((): Date => new Date())
  }

  /** Compose the wallet map key. */
  private static keyOf(ref: WalletRef): string {
    return `${ref.tenantId}|${ref.ownerType}|${ref.ownerId}`
  }

  /** Compose the per-wallet replay key. */
  private static replayKey(walletId: string, idempotencyKey: string): string {
    return `${walletId}|${idempotencyKey}`
  }

  /**
   * The content hash that tells a matching replay apart from a genuine conflict.
   * It covers only the stable business payload of an entry — amount, priority,
   * expiry, usage link, and reason. `effectiveAt` is EXCLUDED: the service defaults
   * it to the wall clock at call time, so including it would make a retry of the
   * same logical grant/debit hash differently and spuriously conflict. This mirrors
   * the ledger payload hash, which likewise excludes generated timestamps.
   */
  private static hashOf(entry: NewWalletEntry): string {
    return deriveIdempotencyKey({
      type: entry.type,
      amountNanoUsd: entry.amountNanoUsd,
      priority: entry.priority,
      expiresAt: entry.expiresAt,
      usageRecordId: entry.usageRecordId,
      reason: entry.reason,
    })
  }

  getWallet(ref: WalletRef): Promise<Wallet | null> {
    return Promise.resolve(this.wallets.get(InMemoryWalletStore.keyOf(ref)) ?? null)
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a conflict throw surfaces as a rejected promise; the body stays synchronous (atomic).
  async appendEntry(
    ref: WalletRef,
    entry: NewWalletEntry,
    allocations: { grantEntryId: string; amountNanoUsd: bigint }[] = [],
  ): Promise<WalletEntry> {
    const autoCreate = entry.type === 'grant' || (entry.type === 'adjustment' && entry.amountNanoUsd > 0n)
    const wallet = this.resolveWallet(ref, autoCreate)
    if (wallet === null) throw new WalletMissingError()
    const replay = this.replayOrConflict(ref, wallet, entry)
    if (replay !== null) return replay
    return this.insert(wallet, entry, allocations)
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a conflict throw surfaces as a rejected promise; the reserve critical section below stays synchronous (atomic).
  async conditionalDebit(ref: WalletRef, entry: NewWalletEntry, overdraftNanoUsd: bigint): Promise<WalletEntry | null> {
    const wallet = this.wallets.get(InMemoryWalletStore.keyOf(ref))
    if (wallet === undefined) return null
    const replay = this.replayOrConflict(ref, wallet, entry)
    if (replay !== null) return replay
    // Critical section — synchronous, no await: the fake's model of the atomic §9.4
    // conditional UPDATE. Expired grants are swept first so the materialized column
    // reflects only spendable credit before the reserve is checked.
    this.sweepExpiredGrants(wallet)
    // `entry.amountNanoUsd` is negative for a debit, so the reserve adds it: this is
    // the fake's model of `balance - cost >= -overdraft` from the §9.4 conditional UPDATE.
    if (wallet.balanceNanoUsd + entry.amountNanoUsd < -overdraftNanoUsd) return null
    const debit = this.insert(wallet, entry, [])
    this.allocateDebit(wallet, debit)
    return debit
  }

  openGrants(ref: WalletRef, order: BurnOrder): Promise<OpenGrant[]> {
    const wallet = this.wallets.get(InMemoryWalletStore.keyOf(ref))
    if (wallet === undefined) return Promise.resolve([])
    return Promise.resolve(this.spendableGrants(wallet, order))
  }

  listEntries(ref: WalletRef, filter: WalletEntryFilter = {}): Promise<WalletEntryPage> {
    const wallet = this.wallets.get(InMemoryWalletStore.keyOf(ref))
    if (wallet === undefined) return Promise.resolve({ entries: [], total: 0 })
    const matched = (this.entries.get(wallet.id) ?? []).filter((entry) => matchesFilter(entry, filter))
    const offset = filter.offset ?? 0
    const end = filter.limit === undefined ? undefined : offset + filter.limit
    return Promise.resolve({ entries: matched.slice(offset, end), total: matched.length })
  }

  reconcile(ref: WalletRef): Promise<Wallet> {
    const wallet = this.wallets.get(InMemoryWalletStore.keyOf(ref))
    if (wallet === undefined) return Promise.reject(new WalletMissingError())
    wallet.balanceNanoUsd = this.spendableBalance(wallet)
    wallet.updatedAt = this.now()
    return Promise.resolve(wallet)
  }

  /** Test accessor — the allocation trail of a consuming (debit/expiry) entry. */
  allocationsOf(entryId: string): readonly WalletAllocation[] {
    return this.allocations.get(entryId) ?? []
  }

  /** Test accessor — every entry of a wallet in append order. */
  entriesOf(ref: WalletRef): readonly WalletEntry[] {
    const wallet = this.wallets.get(InMemoryWalletStore.keyOf(ref))
    return wallet === undefined ? [] : (this.entries.get(wallet.id) ?? [])
  }

  /** Test helper — skew the materialized column to prove `reconcile` repairs it. */
  forceBalance(ref: WalletRef, value: bigint): void {
    const wallet = this.wallets.get(InMemoryWalletStore.keyOf(ref))
    if (wallet !== undefined) wallet.balanceNanoUsd = value
  }

  /** Fetch or (optionally) create the wallet for a ref. */
  private resolveWallet(ref: WalletRef, autoCreate: boolean): Wallet | null {
    const key = InMemoryWalletStore.keyOf(ref)
    const existing = this.wallets.get(key)
    if (existing !== undefined) return existing
    if (!autoCreate) return null
    const now = this.now()
    const wallet: Wallet = {
      id: randomUUID(),
      tenantId: ref.tenantId,
      ownerType: ref.ownerType,
      ownerId: ref.ownerId,
      balanceNanoUsd: 0n,
      createdAt: now,
      updatedAt: now,
    }
    this.wallets.set(key, wallet)
    this.entries.set(wallet.id, [])
    return wallet
  }

  /** Return the stored entry on a matching replay, throw on a conflict, or `null` when new. */
  private replayOrConflict(ref: WalletRef, wallet: Wallet, entry: NewWalletEntry): WalletEntry | null {
    const prior = this.idempotency.get(InMemoryWalletStore.replayKey(wallet.id, entry.idempotencyKey))
    if (prior === undefined) return null
    if (prior.hash === InMemoryWalletStore.hashOf(entry)) return prior.entry
    throw new LedgerIdempotencyConflict(ref.tenantId, entry.idempotencyKey)
  }

  /** Persist an entry, its allocations, and the materialized-balance delta. */
  private insert(
    wallet: Wallet,
    entry: NewWalletEntry,
    allocations: { grantEntryId: string; amountNanoUsd: bigint }[],
  ): WalletEntry {
    const stored: WalletEntry = { ...entry, id: randomUUID(), walletId: wallet.id, createdAt: this.now() }
    ;(this.entries.get(wallet.id) as WalletEntry[]).push(stored)
    this.idempotency.set(InMemoryWalletStore.replayKey(wallet.id, entry.idempotencyKey), {
      entry: stored,
      hash: InMemoryWalletStore.hashOf(entry),
    })
    if (allocations.length > 0) {
      this.allocations.set(
        stored.id,
        allocations.map((allocation) => ({ debitEntryId: stored.id, ...allocation })),
      )
    }
    wallet.balanceNanoUsd += this.balanceDelta(stored)
    wallet.updatedAt = stored.createdAt
    return stored
  }

  /**
   * The materialized-column delta for an entry. A grant contributes only while it is
   * spendable at its PERSISTED append instant (the stamped `createdAt`, not a fresh
   * clock read) — future-dated and born-expired grants add nothing; every other entry
   * contributes its full signed amount. This uses the SAME {@link wasCountedAtAppend}
   * rule as {@link sweepExpiredGrants}, so the fake stays internally consistent and
   * matches the Prisma adapter's persisted-instant balance decision. Expiry of an
   * initially-spendable grant is applied lazily as an `expiry` entry by the sweep.
   */
  private balanceDelta(entry: WalletEntry): bigint {
    if (entry.type !== 'grant') return entry.amountNanoUsd
    return this.wasCountedAtAppend(entry) ? entry.amountNanoUsd : 0n
  }

  /** Whether a grant contributed to the materialized column when it was appended. */
  private wasCountedAtAppend(grant: WalletEntry): boolean {
    return grant.effectiveAt <= grant.createdAt && (grant.expiresAt === undefined || grant.expiresAt > grant.createdAt)
  }

  /** Write an `expiry` entry (with its allocation) for every expired grant with a remainder. */
  private sweepExpiredGrants(wallet: Wallet): void {
    const now = this.now()
    for (const grant of this.entries.get(wallet.id) ?? []) {
      if (grant.type !== 'grant') continue
      if (grant.expiresAt === undefined || grant.expiresAt > now) continue
      if (!this.wasCountedAtAppend(grant)) continue
      const remaining = grant.amountNanoUsd - this.allocatedOf(grant.id)
      if (remaining <= 0n) continue
      this.insert(
        wallet,
        {
          walletId: wallet.id,
          type: 'expiry',
          amountNanoUsd: -remaining,
          priority: grant.priority,
          effectiveAt: now,
          idempotencyKey: `expiry:${grant.id}`,
          reason: 'grant expired',
        },
        [{ grantEntryId: grant.id, amountNanoUsd: remaining }],
      )
    }
  }

  /** Greedily allocate a debit across the spendable grants in burn order. */
  private allocateDebit(wallet: Wallet, debit: WalletEntry): void {
    let remaining = -debit.amountNanoUsd
    const trail: WalletAllocation[] = []
    for (const grant of this.spendableGrants(wallet, this.burnOrder)) {
      if (remaining <= 0n) break
      const take = grant.remainingNanoUsd < remaining ? grant.remainingNanoUsd : remaining
      trail.push({ debitEntryId: debit.id, grantEntryId: grant.id, amountNanoUsd: take })
      remaining -= take
    }
    if (trail.length > 0) this.allocations.set(debit.id, trail)
  }

  /** Grants that are effective now, not expired, and still have a remainder, in burn order. */
  private spendableGrants(wallet: Wallet, order: BurnOrder): OpenGrant[] {
    const now = this.now()
    const open = (this.entries.get(wallet.id) ?? [])
      .filter((entry) => entry.type === 'grant' && entry.effectiveAt <= now && (entry.expiresAt === undefined || entry.expiresAt > now))
      .map((grant) => ({ ...grant, remainingNanoUsd: grant.amountNanoUsd - this.allocatedOf(grant.id) }))
      .filter((grant) => grant.remainingNanoUsd > 0n)
    return open.sort((a, b) => compareGrants(a, b, order))
  }

  /** Σ of allocations drawn against a grant (debit + expiry). */
  private allocatedOf(grantEntryId: string): bigint {
    let total = 0n
    for (const trail of this.allocations.values()) {
      for (const allocation of trail) {
        if (allocation.grantEntryId === grantEntryId) total += allocation.amountNanoUsd
      }
    }
    return total
  }

  /**
   * The time-aware spendable balance recomputed from the entry ledger (§9.4): every
   * effective grant and non-grant entry counts in full, minus the unspent remainder
   * of any grant that has expired (whether or not its `expiry` entry has been swept
   * yet). Future-dated grants are ignored. `reconcile` writes this back to the
   * materialized column, healing any drift.
   */
  private spendableBalance(wallet: Wallet): bigint {
    const now = this.now()
    let total = 0n
    for (const entry of this.entries.get(wallet.id) ?? []) {
      if (entry.type !== 'grant') total += entry.amountNanoUsd
      else if (entry.effectiveAt <= now) total += entry.amountNanoUsd
    }
    for (const grant of this.entries.get(wallet.id) ?? []) {
      if (grant.type !== 'grant' || grant.effectiveAt > now) continue
      if (grant.expiresAt === undefined || grant.expiresAt > now) continue
      const remaining = grant.amountNanoUsd - this.allocatedOf(grant.id)
      if (remaining > 0n) total -= remaining
    }
    return total
  }
}

/** Signal that a wallet does not exist for a non-creating entry — mapped to insufficient credits. */
export class WalletMissingError extends Error {
  readonly isWalletMissing = true
  constructor() {
    super('wallet does not exist')
    this.name = 'WalletMissingError'
  }
}

/** Order two open grants by the configured burn order (soonest-expiring / priority / fifo). */
function compareGrants(a: OpenGrant, b: OpenGrant, order: BurnOrder): number {
  if (order === 'priority') return a.priority - b.priority
  if (order === 'fifo') return a.createdAt.getTime() - b.createdAt.getTime()
  const aExpiry = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY
  const bExpiry = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY
  return aExpiry - bExpiry
}

/** True when an entry satisfies every populated filter field. */
function matchesFilter(entry: WalletEntry, filter: WalletEntryFilter): boolean {
  if (filter.type !== undefined && entry.type !== filter.type) return false
  if (filter.from !== undefined && entry.createdAt < filter.from) return false
  if (filter.to !== undefined && entry.createdAt > filter.to) return false
  return true
}
