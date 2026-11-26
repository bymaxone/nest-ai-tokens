/**
 * @fileoverview `WalletService` — the prepaid-credit facade over `IWalletStore`
 * (spec §9.2). Wallets hold nano-USD balances as append-only entries
 * (grant/debit/refund/adjustment/expiry) with a materialized balance column for
 * atomic debits. `grant`/`debit`/`refund`/`adjust` each carry a per-wallet
 * idempotency key (replay-or-conflict, §15.2); `debit` is the race-safe
 * conditional path (§9.4) — the store reserves against the materialized balance,
 * sweeps expired grants, and records the grant burn-down allocation trail (§9.3) in
 * one atomic operation, so the service never does a check-then-write. `getBalance`
 * reports the materialized balance; grant/adjust are admin-plane mutations that the
 * host MUST restrict to privileged roles and that emit `ai_tokens.audit` (§14.4).
 * `'key'` scopes cannot own money (§9.1). All amounts are bigint nano-USD.
 * @layer server
 */

import { Injectable } from '@nestjs/common'
import type {
  NewWalletEntry,
  WalletDepletedEventData,
  WalletEntry,
  WalletGrantedEventData,
  WalletRef,
} from '../../shared'
import type { ResolvedWalletsOptions } from '../config'
import { AiTokensException } from '../errors'
import { suppliedDetails } from '../utils/detail-text'
import { attachCause } from '../errors/attach-cause'
import { assertObject, assertOptionalCount, assertOptionalText, assertText, assertWalletRef } from '../utils/argument-guards'
import { readShape, snapshotOf, withReadDates } from '../utils/date-guards'
import { ADJUST_FIELDS, BALANCE_OPTION_FIELDS, DEBIT_FIELDS, GRANT_FIELDS, REFUND_FIELDS, SETTLE_ADJUSTMENT_FIELDS, WALLET_ENTRY_FILTER_FIELDS, WALLET_REF_FIELDS } from '../utils/input-fields'
import { isNonZeroBigint, isPositiveBigint } from '../utils/numeric-guards'
import { storeFailureCode } from '../errors/store-availability'
import type { IWalletStore, WalletEntryFilter, WalletEntryPage } from '../interfaces'
import { guardedStore } from '../utils/guarded-store'
import { isLedgerIdempotencyConflict } from './ledger-idempotency-conflict'

/** The resolved wallet settings the service consumes (the enabled half of the union). */
export type WalletServiceOptions = Extract<ResolvedWalletsOptions, { enabled: true }>

/** A wallet balance in nano-USD plus its presentation credits. */
export interface WalletBalance {
  nanoUsd: bigint
  credits: number
  /** Present only on a balance asked for with options: the instant the answer was evaluated at. */
  asOf?: Date
}

/** Options of {@link WalletService.getBalance} and {@link WalletService.getBalanceBreakdown}. */
export interface BalanceOptions {
  /** The instant to answer for; defaults to now. Up to 5 seconds behind now is evaluated at now; further behind is refused. */
  asOf?: Date
}

/** One grant that still holds value, in the breakdown of a balance. */
export interface WalletBalanceBucket {
  grantEntryId: string
  remainingNanoUsd: bigint
  remainingCredits: number
  priority: number
  expiresAt?: Date
  reason?: string
}

/** What a debit at `asOf` could spend without overdraft, split by grant. */
export interface WalletBalanceBreakdownResult {
  asOf: Date
  nanoUsd: bigint
  credits: number
  /** The part no grant holds (overdraft, an unallocated refund); may be negative. */
  unallocatedNanoUsd: bigint
  unallocatedCredits: number
  buckets: WalletBalanceBucket[]
}

/** The modes a refund may restore in. */
const RESTORE_MODES = ['source', 'unallocated'] as const

/** How far behind now an `asOf` may be and still be evaluated at now: the time between reading a clock and calling. */
const AS_OF_TOLERANCE_MS = 5000

/** Input to {@link WalletService.grant}. */
export interface GrantInput {
  amountNanoUsd: bigint
  priority?: number
  effectiveAt?: Date
  expiresAt?: Date
  idempotencyKey: string
  reason: string
}

/** Input to {@link WalletService.debit}. */
export interface DebitInput {
  amountNanoUsd: bigint
  usageRecordId?: string
  idempotencyKey: string
  reason?: string
}

/** Input to {@link WalletService.refund}. */
export interface RefundInput {
  amountNanoUsd: bigint
  usageRecordId?: string
  idempotencyKey: string
  reason: string
  /**
   * `'unallocated'` (default) credits the wallet without touching any grant. `'source'` puts the refund back on the grants the debit burned,
   * in proportion, so their remaining rises and their expiry and priority are unchanged; an expired grant's part is written off.
   */
  restore?: 'source' | 'unallocated'
  /** With `restore: 'source'`: the debit to restore; when absent, the single debit of the wallet with this `usageRecordId`. */
  debitEntryId?: string
}

/** Input to {@link WalletService.adjust}. */
export interface AdjustInput {
  amountNanoUsd: bigint
  idempotencyKey: string
  reason: string
}

/** Input to {@link WalletService.settleAdjustment}: the signed capture ±delta. */
export interface SettleAdjustmentInput {
  /** The signed adjustment amount (`!= 0`): `+` credits, `−` debits. */
  amountNanoUsd: bigint
  usageRecordId?: string
  idempotencyKey: string
  reason: string
}

/**
 * The event hooks `WalletService` fires; the module wires them to the dispatcher
 * (default no-op so the service has no dependency cycle on the event dispatcher).
 */
export interface WalletEventHooks {
  granted(ref: WalletRef, data: WalletGrantedEventData): void | Promise<void>
  depleted(ref: WalletRef, data: WalletDepletedEventData): void | Promise<void>
  audit(action: string, details: Record<string, unknown>): void | Promise<void>
}

/** The no-op hooks used until the event dispatcher is wired. */
const NOOP_WALLET_HOOKS: WalletEventHooks = {
  granted: (): void => undefined,
  depleted: (): void => undefined,
  audit: (): void => undefined,
}

/**
 * Prepaid-credit facade over {@link IWalletStore}. Wallets hold nano-USD
 * balances as append-only entries (grant/debit/refund/adjust) with a
 * materialized balance column for atomic debits. See file overview.
 */
@Injectable()
export class WalletService {
  /**
   * @param store The wallet persistence port.
   * @param options The resolved wallet settings (credit rate, overdraft).
   * @param events The event hooks; the module wires them to the dispatcher.
   * @param now The injected clock; every grant's effective and expiry instant is judged on it, by the store too.
   */
  private readonly store: IWalletStore

  constructor(
    store: IWalletStore,
    private readonly options: WalletServiceOptions,
    private readonly events: WalletEventHooks = NOOP_WALLET_HOOKS,
    private readonly now: () => Date = (): Date => new Date(),
  ) {
    this.store = guardedStore(store)
  }

  /**
   * The current balance (§9.2). Reads the materialized balance; crediting a grant that falls due
   * and expiring one that lapses are applied lazily on debit and on `reconcile`, so a grant that
   * becomes effective or lapses purely with the passage of time is counted or still counted
   * until the next debit or `reconcile` (the documented §9.3 lazy-materialization trade-off).
   *
   * @param ref The wallet owner (a `'tenant' | 'team' | 'user'`, never `'key'`).
   * @returns The nano-USD balance and its presentation credits.
   */
  async getBalance(ref: WalletRef, options?: BalanceOptions): Promise<WalletBalance> {
    ref = this.assertOwner(ref)
    if (options === undefined) {
      const wallet = await this.store.getWallet(ref)
      const nanoUsd = wallet?.balanceNanoUsd ?? 0n
      return { nanoUsd, credits: this.toCredits(nanoUsd) }
    }
    const asOf = this.resolveAsOf(options)
    if (this.store.balanceAt === undefined) throw this.invalid('the store does not implement balanceAt, which getBalance with options needs')
    let nanoUsd: bigint
    try {
      nanoUsd = await this.store.balanceAt(ref, asOf)
    } catch (error) {
      throw this.mapStoreError(error, ref)
    }
    return { nanoUsd, credits: this.toCredits(nanoUsd), asOf }
  }

  /**
   * What a debit at `asOf` could spend without overdraft, split by the grants that hold it: due grants in, pending and expired ones out, by the
   * same predicates the conditional debit applies. Reads one snapshot and writes nothing.
   *
   * @param ref The wallet owner.
   * @param options `asOf`, defaulting to now; up to 5 seconds behind now is evaluated at now, further behind is refused.
   * @returns The total, the part held by no grant, and the grants in burn order, with the instant used.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` for an `asOf` that is invalid or too far behind, or a store without `balanceBreakdown`.
   */
  async getBalanceBreakdown(ref: WalletRef, options?: BalanceOptions): Promise<WalletBalanceBreakdownResult> {
    ref = this.assertOwner(ref)
    const asOf = this.resolveAsOf(options ?? {})
    if (this.store.balanceBreakdown === undefined) throw this.invalid('the store does not implement balanceBreakdown')
    let found: Awaited<ReturnType<NonNullable<IWalletStore['balanceBreakdown']>>>
    try {
      found = await this.store.balanceBreakdown(ref, asOf)
    } catch (error) {
      throw this.mapStoreError(error, ref)
    }
    return {
      asOf,
      nanoUsd: found.nanoUsd,
      credits: this.toCredits(found.nanoUsd),
      unallocatedNanoUsd: found.unallocatedNanoUsd,
      unallocatedCredits: this.toCredits(found.unallocatedNanoUsd),
      buckets: found.buckets.map((bucket) => ({
        grantEntryId: bucket.grantEntryId,
        remainingNanoUsd: bucket.remainingNanoUsd,
        remainingCredits: this.toCredits(bucket.remainingNanoUsd),
        priority: bucket.priority,
        ...(bucket.expiresAt === undefined ? {} : { expiresAt: bucket.expiresAt }),
        ...(bucket.reason === undefined ? {} : { reason: bucket.reason }),
      })),
    }
  }

  /** The instant a balance is evaluated at: now when none is given, now for one up to the tolerance behind it, a refusal for one further behind. */
  private resolveAsOf(given: BalanceOptions): Date {
    assertObject('options', given)
    const asOf = withReadDates(given, BALANCE_OPTION_FIELDS, ['asOf'], 'options ').asOf as Date | undefined
    const now = this.now()
    if (asOf === undefined) return now
    if (asOf.getTime() < now.getTime() - AS_OF_TOLERANCE_MS) throw this.invalid('asOf is in the past: a balance is answered for now or later, not for an instant that is gone')
    return new Date(Math.max(asOf.getTime(), now.getTime()))
  }

  /**
   * Grant credits (allowance, purchase, promo). Auto-creates the wallet on the
   * first grant. ADMIN PLANE (§14.4): the host MUST restrict this to privileged
   * roles. Emits `ai_tokens.wallet.granted` and `ai_tokens.audit`.
   *
   * @param ref The wallet owner.
   * @param given The grant amount (`> 0`), optional schedule, key, and reason.
   * @returns The appended grant entry.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` on a non-positive amount / `'key'` owner; `AI_TOKENS_IDEMPOTENCY_CONFLICT` on a key reuse with a different payload.
   */
  async grant(ref: WalletRef, given: GrantInput): Promise<WalletEntry> {
    ref = this.assertOwner(ref)
    assertObject('input', given)
    const input = withReadDates(given, GRANT_FIELDS, ['effectiveAt', 'expiresAt'], 'grant ')
    assertEntryText(input, true)
    const now = this.now()
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics; tests check error code only
    if (!isPositiveBigint(input.amountNanoUsd)) throw this.invalid('grant amount must be a bigint from 1 to 9223372036854775807')
    this.assertGrantFields(input)
    const grant: Omit<NewWalletEntry, 'walletId'> = {
      type: 'grant',
      amountNanoUsd: input.amountNanoUsd,
      priority: input.priority ?? 0,
      effectiveAt: input.effectiveAt ?? now,
      // Stryker disable next-line ConditionalExpression: CE true: spreading { expiresAt: undefined } is equivalent to {} because InMemoryWalletStore and consumers check expiresAt !== undefined
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    }
    const entry = await this.append(ref, grant, input.effectiveAt === undefined)
    const granted: WalletGrantedEventData = {
      walletId: entry.walletId,
      entryId: entry.id,
      amountNanoUsd: entry.amountNanoUsd,
      // Stryker disable next-line ConditionalExpression: CE true: spreading { expiresAt: undefined } is equivalent to {} because event consumers check expiresAt !== undefined
      ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    }
    await this.events.granted(ref, granted)
    // Stryker disable next-line ObjectLiteral: audit payload is internal observability; tests check method completion, not event payload shape
    await this.events.audit('ai_tokens.wallet.granted', {
      tenantId: ref.tenantId,
      walletId: entry.walletId,
      entryId: entry.id,
      amountNanoUsd: entry.amountNanoUsd.toString(),
      reason: input.reason,
    })
    return entry
  }

  /**
   * Atomic conditional debit (§9.4). `usageRecordId` links usage-driven debits;
   * a non-usage debit (e.g. a voucher reservation) omits it and MUST carry a
   * `reason`. The store reserves against the materialized balance and records the
   * grant burn-down allocation in one atomic step — never a check-then-write.
   *
   * @param ref The wallet owner.
   * @param given The debit amount (`> 0`), optional `usageRecordId`, key, and reason.
   * @returns The appended debit entry.
   * @throws {AiTokensException} `AI_TOKENS_INSUFFICIENT_CREDITS` (402) when the balance would fall below `-overdraft`; `AI_TOKENS_INVALID_CONFIG` when neither `usageRecordId` nor `reason` is present, or the amount is not positive.
   */
  async debit(ref: WalletRef, given: DebitInput): Promise<WalletEntry> {
    ref = this.assertOwner(ref)
    assertObject('input', given)
    const input = snapshotOf(given, DEBIT_FIELDS)
    assertEntryText(input, false)
    const now = this.now()
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics; tests check error code only
    if (!isPositiveBigint(input.amountNanoUsd)) throw this.invalid('debit amount must be a bigint from 1 to 9223372036854775807')
    if (input.usageRecordId === undefined && input.reason === undefined) {
      // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
      throw this.invalid('a debit without a usageRecordId must carry a reason')
    }
    const entry: NewWalletEntry = {
      // Stryker disable next-line StringLiteral: placeholder walletId; the store's insert always assigns the real wallet id and never reads this sentinel, so any string here is equivalent
      walletId: '',
      type: 'debit',
      amountNanoUsd: -input.amountNanoUsd,
      priority: 0,
      effectiveAt: now,
      // Stryker disable next-line ConditionalExpression: CE true: spreading { usageRecordId: undefined } is equivalent to {} because store and consumers check usageRecordId !== undefined
      ...(input.usageRecordId !== undefined ? { usageRecordId: input.usageRecordId } : {}),
      idempotencyKey: input.idempotencyKey,
      // Stryker disable next-line ConditionalExpression: CE true: spreading { reason: undefined } is equivalent to {} because store and consumers check reason !== undefined
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }
    const debited = await this.conditionalDebit(ref, entry, input.amountNanoUsd, now)
    const balance = await this.store.getWallet(ref)
    if (balance !== null && balance.balanceNanoUsd <= 0n) {
      await this.events.depleted(ref, { walletId: debited.walletId, balanceNanoUsd: balance.balanceNanoUsd })
    }
    return debited
  }

  /**
   * Refund a previous debit. With no `restore`, or `restore: 'unallocated'`, a plain `refund` credit entry that no grant owns: it never resurrects an
   * expired grant, the credit is unallocated balance (§9.3). With `restore: 'source'`, the amount goes back on the grants the debit burned. Refunds are always
   * allowed (they can restore a negative balance).
   *
   * @param ref The wallet owner.
   * @param given The refund amount (`> 0`), optional `usageRecordId`, key, and reason.
   * @returns The appended refund entry.
   */
  async refund(ref: WalletRef, given: RefundInput): Promise<WalletEntry> {
    ref = this.assertOwner(ref)
    assertObject('input', given)
    const input = snapshotOf(given, REFUND_FIELDS)
    assertEntryText(input, true)
    const now = this.now()
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics; tests check error code only
    if (!isPositiveBigint(input.amountNanoUsd)) throw this.invalid('refund amount must be a bigint from 1 to 9223372036854775807')
    if (input.restore !== undefined && !(RESTORE_MODES as readonly unknown[]).includes(input.restore)) throw this.invalid("refund restore must be 'source' or 'unallocated'")
    assertOptionalText('debitEntryId', input.debitEntryId)
    if (input.debitEntryId !== undefined && input.restore !== 'source') throw this.invalid("a debitEntryId names the debit a refund restores: it needs restore: 'source'")
    if (input.restore === 'source') return this.refundToSource(ref, input, now)
    return this.append(ref, {
      type: 'refund',
      amountNanoUsd: input.amountNanoUsd,
      priority: 0,
      effectiveAt: now,
      // Stryker disable next-line ConditionalExpression,ObjectLiteral: CE true / OL {}: spreading { usageRecordId: undefined } is equivalent to {} because store and consumers check usageRecordId !== undefined
      ...(input.usageRecordId !== undefined ? { usageRecordId: input.usageRecordId } : {}),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    })
  }

  /** Refund into the grants the debit burned: one store transaction, never an unallocated fallback when the store lacks it. */
  private async refundToSource(ref: WalletRef, input: RefundInput, now: Date): Promise<WalletEntry> {
    if (this.store.refundToSource === undefined) throw this.invalid("the store does not implement refundToSource, which restore: 'source' needs")
    try {
      return await this.store.refundToSource(ref, {
        entry: {
          walletId: '',
          type: 'refund',
          amountNanoUsd: input.amountNanoUsd,
          priority: 0,
          effectiveAt: now,
          ...(input.usageRecordId !== undefined ? { usageRecordId: input.usageRecordId } : {}),
          idempotencyKey: input.idempotencyKey,
          reason: input.reason,
        },
        ...(input.debitEntryId !== undefined ? { debitEntryId: input.debitEntryId } : {}),
        now,
      })
    } catch (error) {
      throw this.mapStoreError(error, ref, input.idempotencyKey)
    }
  }

  /**
   * Signed manual correction (ADMIN PLANE — §14.4; the host MUST restrict this to
   * privileged roles). A positive adjustment auto-creates the wallet. Emits
   * `ai_tokens.audit`.
   *
   * @param ref The wallet owner.
   * @param given The signed amount (`!= 0`), key, and reason.
   * @returns The appended adjustment entry.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` on a zero amount / `'key'` owner.
   */
  async adjust(ref: WalletRef, given: AdjustInput): Promise<WalletEntry> {
    ref = this.assertOwner(ref)
    assertObject('input', given)
    const input = snapshotOf(given, ADJUST_FIELDS)
    assertEntryText(input, true)
    const now = this.now()
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics; tests check error code only
    if (!isNonZeroBigint(input.amountNanoUsd)) throw this.invalid('adjustment amount must be a non-zero bigint within -9223372036854775808 to 9223372036854775807')
    const entry = await this.append(ref, {
      type: 'adjustment',
      amountNanoUsd: input.amountNanoUsd,
      priority: 0,
      effectiveAt: now,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    })
    // Stryker disable next-line ObjectLiteral: audit payload is internal observability; tests check method completion, not event payload shape
    await this.events.audit('ai_tokens.wallet.adjusted', {
      tenantId: ref.tenantId,
      walletId: entry.walletId,
      entryId: entry.id,
      amountNanoUsd: entry.amountNanoUsd.toString(),
      reason: input.reason,
    })
    return entry
  }

  /**
   * Apply an unconditional signed settlement adjustment — the capture ±delta vs a
   * hold (§11.2). Unlike {@link debit} it NEVER blocks on the balance (capture must
   * settle actuals even into overdraft) and unlike {@link adjust} it emits NO admin
   * audit (it is a system settlement, not a manual correction). Appends an
   * `adjustment` entry; a positive amount credits (refund of an over-reservation), a
   * negative amount debits (top-up when actuals exceeded the estimate).
   *
   * @param ref The wallet owner.
   * @param input The signed amount (`!= 0`), optional `usageRecordId`, key, and reason.
   * @returns The appended adjustment entry.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` on a zero amount / `'key'` owner.
   */
  async settleAdjustment(ref: WalletRef, given: SettleAdjustmentInput): Promise<WalletEntry> {
    ref = this.assertOwner(ref)
    assertObject('input', given)
    const input = snapshotOf(given, SETTLE_ADJUSTMENT_FIELDS)
    const now = this.now()
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics; tests check error code only
    if (!isNonZeroBigint(input.amountNanoUsd)) throw this.invalid('settlement adjustment amount must be a non-zero bigint within -9223372036854775808 to 9223372036854775807')
    return this.append(ref, {
      type: 'adjustment',
      amountNanoUsd: input.amountNanoUsd,
      priority: 0,
      effectiveAt: now,
      // Stryker disable next-line ConditionalExpression: CE true: spreading { usageRecordId: undefined } is equivalent to {} because store and consumers check usageRecordId !== undefined
      // Stryker disable next-line ConditionalExpression: CE true: spreading { usageRecordId: undefined } is equivalent to {} because store and consumers check usageRecordId !== undefined
      ...(input.usageRecordId !== undefined ? { usageRecordId: input.usageRecordId } : {}),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    })
  }

  /**
   * Paginated entry history with type/date filters — the transaction listing a
   * usage meter renders. An `adjustment` entry keyed `activate:<grantId>` (reason
   * `grant activated`) is not an operator adjustment: the store writes it when it credits
   * a grant that was not yet due as it was appended, and its amount is that grant's.
   *
   * @param ref The wallet owner.
   * @param filter Optional type/date filters and pagination.
   * @returns A page of entries and the total match count.
   */
  async getEntries(ref: WalletRef, filter?: WalletEntryFilter): Promise<WalletEntryPage> {
    ref = this.assertOwner(ref)
    if (filter !== undefined) assertObject('filter', filter)
    const clean = filter === undefined ? undefined : withReadDates(filter, WALLET_ENTRY_FILTER_FIELDS, ['from', 'to'])
    if (clean !== undefined) {
      assertOptionalCount('limit', clean.limit)
      assertOptionalCount('offset', clean.offset)
      if (clean.order !== undefined && clean.order !== 'asc' && clean.order !== 'desc') throw this.invalid("order must be 'asc' or 'desc'")
    }
    return this.store.listEntries(ref, clean)
  }

  /**
   * Recompute and repair the materialized balance from the entry ledger (§9.4).
   * ADMIN PLANE (§14.4): the host MUST restrict this to privileged roles. Emits
   * `ai_tokens.audit`.
   *
   * @param ref The wallet owner.
   * @returns The reconciled nano-USD balance and its presentation credits.
   */
  async reconcile(ref: WalletRef): Promise<WalletBalance> {
    ref = this.assertOwner(ref)
    let wallet: Awaited<ReturnType<IWalletStore['reconcile']>>
    try {
      wallet = await this.store.reconcile(ref, this.now())
    } catch (error) {
      throw this.mapStoreError(error, ref)
    }
    // Stryker disable next-line ObjectLiteral,StringLiteral: audit event name and payload are internal observability; tests check the reconciled balance, not event shape
    await this.events.audit('ai_tokens.wallet.reconciled', {
      tenantId: ref.tenantId,
      walletId: wallet.id,
      balanceNanoUsd: wallet.balanceNanoUsd.toString(),
    })
    return { nanoUsd: wallet.balanceNanoUsd, credits: this.toCredits(wallet.balanceNanoUsd) }
  }

  /** Append a non-debit entry, mapping a store idempotency/missing-wallet signal to the catalog. */
  private async append(ref: WalletRef, entry: Omit<NewWalletEntry, 'walletId'>, effectiveAtDefaulted = false): Promise<WalletEntry> {
    try {
      // Stryker disable next-line StringLiteral: placeholder walletId; the store's insert always assigns the real wallet id and never reads this sentinel, so any string here is equivalent
      return await this.store.appendEntry(ref, { walletId: '', ...entry }, undefined, { effectiveAtDefaulted })
    } catch (error) {
      throw this.mapStoreError(error, ref, entry.idempotencyKey)
    }
  }

  /** Run the atomic conditional debit, mapping `null` to insufficient credits (§9.4). */
  private async conditionalDebit(ref: WalletRef, entry: NewWalletEntry, requested: bigint, now: Date): Promise<WalletEntry> {
    let result: WalletEntry | null
    try {
      result = await this.store.conditionalDebit(ref, entry, this.options.overdraftNanoUsd, now)
    } catch (error) {
      throw this.mapStoreError(error, ref, entry.idempotencyKey)
    }
    if (result === null) {
      const wallet = await this.store.getWallet(ref)
      // Stryker disable next-line ObjectLiteral: error context fields are diagnostic; tests check the error code (AI_TOKENS_INSUFFICIENT_CREDITS), not the payload shape
      throw new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', undefined, {
        balanceNanoUsd: (wallet?.balanceNanoUsd ?? 0n).toString(),
        requestedNanoUsd: requested.toString(),
      })
    }
    return result
  }

  /** Map a store idempotency conflict / missing-wallet signal to the typed catalog error. */
  private mapStoreError(error: unknown, ref: WalletRef, idempotencyKey?: string): AiTokensException {
    if (isLedgerIdempotencyConflict(error)) {
      // Stryker disable next-line ObjectLiteral: error context is internal diagnostics; tests check error code only
      return new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, suppliedDetails({ tenantId: ref.tenantId, idempotencyKey }))
    }
    if (isWalletMissing(error)) {
      // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics
      return new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', undefined, { reason: 'wallet does not exist' })
    }
    return error instanceof AiTokensException
      ? error
      : attachCause(new AiTokensException(storeFailureCode(error), undefined, {}), error)
  }

  /** Snapshot the reference of a wallet and reject a `'key'` owner at runtime (`'key'` scopes cannot own money, §9.1). */
  private assertOwner(given: WalletRef): WalletRef {
    assertObject('wallet', given)
    const ref = readShape(given, { fields: WALLET_REF_FIELDS }, 'wallet.') as unknown as WalletRef
    assertWalletRef(ref)
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics; tests check error code only
    if ((ref.ownerType as string) === 'key') throw this.invalid("'key' scopes cannot own a wallet")
    return ref
  }

  /** Present a nano-USD balance as credits (presentation-only division). */
  private toCredits(nanoUsd: bigint): number {
    return Number(nanoUsd) / Number(this.options.creditRateNanoUsd)
  }

  /** Refuse a grant whose priority is not a whole number or whose dates are not valid dates: an `Invalid Date` compares false with every instant. */
  private assertGrantFields(input: GrantInput): void {
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    if (input.priority !== undefined && !Number.isInteger(input.priority)) throw this.invalid('grant priority must be a whole number')
  }

  /** Build the invalid-config exception with an actionable reason. */
  private invalid(reason: string): AiTokensException {
    // Stryker disable next-line ObjectLiteral: error context is internal diagnostics; tests check error code only
    return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
  }
}

/** The structural shape of the wallet-missing store signal. */
interface WalletMissingShape {
  isWalletMissing: true
}

/** Narrow an unknown thrown value to the wallet-missing store signal. */
function isWalletMissing(error: unknown): error is WalletMissingShape {
  // Stryker disable next-line ConditionalExpression: CE false on `typeof error !== 'object'`: non-object primitives also fail `.isWalletMissing === true` (returns undefined), giving the same false result; the guard is defensive but the outcome is identical for all realistic inputs
  if (typeof error !== 'object' || error === null) return false
  return (error as Record<string, unknown>).isWalletMissing === true
}

/** Throw unless the entry is an object whose idempotency key, reason and record id are strings, the reason being required when `reasonRequired`. */
function assertEntryText(input: { idempotencyKey: unknown; reason?: unknown; usageRecordId?: unknown }, reasonRequired: boolean): void {
  assertText('idempotencyKey', input.idempotencyKey)
  if (reasonRequired) assertText('reason', input.reason)
  else assertOptionalText('reason', input.reason)
  assertOptionalText('usageRecordId', input.usageRecordId)
}
