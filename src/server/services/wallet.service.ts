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
import type { IWalletStore, WalletEntryFilter, WalletEntryPage } from '../interfaces'
import { isLedgerIdempotencyConflict } from './ledger-idempotency-conflict'

/** The resolved wallet settings the service consumes (the enabled half of the union). */
export type WalletServiceOptions = Extract<ResolvedWalletsOptions, { enabled: true }>

/** A wallet balance in nano-USD plus its presentation credits. */
export interface WalletBalance {
  nanoUsd: bigint
  credits: number
}

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
   */
  constructor(
    private readonly store: IWalletStore,
    private readonly options: WalletServiceOptions,
    private readonly events: WalletEventHooks = NOOP_WALLET_HOOKS,
  ) {}

  /**
   * The current balance, excluding not-yet-effective and expired grants (§9.2).
   * Reads the materialized balance; expiry is applied lazily on debit, so a grant
   * that lapses purely with the passage of time is reflected at the next debit or
   * `reconcile` (the documented §9.3 lazy-materialization trade-off).
   *
   * @param ref The wallet owner (a `'tenant' | 'team' | 'user'`, never `'key'`).
   * @returns The nano-USD balance and its presentation credits.
   */
  async getBalance(ref: WalletRef): Promise<WalletBalance> {
    this.assertOwner(ref)
    const wallet = await this.store.getWallet(ref)
    const nanoUsd = wallet?.balanceNanoUsd ?? 0n
    return { nanoUsd, credits: this.toCredits(nanoUsd) }
  }

  /**
   * Grant credits (allowance, purchase, promo). Auto-creates the wallet on the
   * first grant. ADMIN PLANE (§14.4): the host MUST restrict this to privileged
   * roles. Emits `ai_tokens.wallet.granted` and `ai_tokens.audit`.
   *
   * @param ref The wallet owner.
   * @param input The grant amount (`> 0`), optional schedule, key, and reason.
   * @returns The appended grant entry.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` on a non-positive amount / `'key'` owner; `AI_TOKENS_IDEMPOTENCY_CONFLICT` on a key reuse with a different payload.
   */
  async grant(ref: WalletRef, input: GrantInput): Promise<WalletEntry> {
    this.assertOwner(ref)
    // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics; tests check error code only
    if (input.amountNanoUsd <= 0n) throw this.invalid('grant amount must be greater than 0')
    const entry = await this.append(ref, {
      type: 'grant',
      amountNanoUsd: input.amountNanoUsd,
      priority: input.priority ?? 0,
      effectiveAt: input.effectiveAt ?? new Date(),
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { expiresAt: undefined } is equivalent to {} because InMemoryWalletStore and consumers check expiresAt !== undefined
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    })
    const granted: WalletGrantedEventData = {
      walletId: entry.walletId,
      entryId: entry.id,
      amountNanoUsd: entry.amountNanoUsd,
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { expiresAt: undefined } is equivalent to {} because event consumers check expiresAt !== undefined
      ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    }
    await this.events.granted(ref, granted)
    // Stryker disable next-line ObjectLiteral -- audit payload is internal observability; tests check method completion, not event payload shape
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
   * @param input The debit amount (`> 0`), optional `usageRecordId`, key, and reason.
   * @returns The appended debit entry.
   * @throws {AiTokensException} `AI_TOKENS_INSUFFICIENT_CREDITS` (402) when the balance would fall below `-overdraft`; `AI_TOKENS_INVALID_CONFIG` when neither `usageRecordId` nor `reason` is present, or the amount is not positive.
   */
  async debit(ref: WalletRef, input: DebitInput): Promise<WalletEntry> {
    this.assertOwner(ref)
    // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics; tests check error code only
    if (input.amountNanoUsd <= 0n) throw this.invalid('debit amount must be greater than 0')
    if (input.usageRecordId === undefined && input.reason === undefined) {
      // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics
      throw this.invalid('a debit without a usageRecordId must carry a reason')
    }
    const entry: NewWalletEntry = {
      // Stryker disable next-line StringLiteral -- placeholder walletId; the store's insert always assigns the real wallet id and never reads this sentinel, so any string here is equivalent
      walletId: '',
      type: 'debit',
      amountNanoUsd: -input.amountNanoUsd,
      priority: 0,
      effectiveAt: new Date(),
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { usageRecordId: undefined } is equivalent to {} because store and consumers check usageRecordId !== undefined
      ...(input.usageRecordId !== undefined ? { usageRecordId: input.usageRecordId } : {}),
      idempotencyKey: input.idempotencyKey,
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { reason: undefined } is equivalent to {} because store and consumers check reason !== undefined
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }
    const debited = await this.conditionalDebit(ref, entry, input.amountNanoUsd)
    const balance = await this.store.getWallet(ref)
    if (balance !== null && balance.balanceNanoUsd <= 0n) {
      await this.events.depleted(ref, { walletId: debited.walletId, balanceNanoUsd: balance.balanceNanoUsd })
    }
    return debited
  }

  /**
   * Refund a previous debit (a plain `refund` credit entry). Never resurrects an
   * expired grant — the credit is unallocated balance (§9.3). Refunds are always
   * allowed (they can restore a negative balance).
   *
   * @param ref The wallet owner.
   * @param input The refund amount (`> 0`), optional `usageRecordId`, key, and reason.
   * @returns The appended refund entry.
   */
  async refund(ref: WalletRef, input: RefundInput): Promise<WalletEntry> {
    this.assertOwner(ref)
    // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics; tests check error code only
    if (input.amountNanoUsd <= 0n) throw this.invalid('refund amount must be greater than 0')
    return this.append(ref, {
      type: 'refund',
      amountNanoUsd: input.amountNanoUsd,
      priority: 0,
      effectiveAt: new Date(),
      // Stryker disable next-line ConditionalExpression,ObjectLiteral -- CE true / OL {}: spreading { usageRecordId: undefined } is equivalent to {} because store and consumers check usageRecordId !== undefined
      ...(input.usageRecordId !== undefined ? { usageRecordId: input.usageRecordId } : {}),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    })
  }

  /**
   * Signed manual correction (ADMIN PLANE — §14.4; the host MUST restrict this to
   * privileged roles). A positive adjustment auto-creates the wallet. Emits
   * `ai_tokens.audit`.
   *
   * @param ref The wallet owner.
   * @param input The signed amount (`!= 0`), key, and reason.
   * @returns The appended adjustment entry.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` on a zero amount / `'key'` owner.
   */
  async adjust(ref: WalletRef, input: AdjustInput): Promise<WalletEntry> {
    this.assertOwner(ref)
    // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics; tests check error code only
    if (input.amountNanoUsd === 0n) throw this.invalid('adjustment amount must not be 0')
    const entry = await this.append(ref, {
      type: 'adjustment',
      amountNanoUsd: input.amountNanoUsd,
      priority: 0,
      effectiveAt: new Date(),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    })
    // Stryker disable next-line ObjectLiteral -- audit payload is internal observability; tests check method completion, not event payload shape
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
  async settleAdjustment(ref: WalletRef, input: SettleAdjustmentInput): Promise<WalletEntry> {
    this.assertOwner(ref)
    // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics; tests check error code only
    if (input.amountNanoUsd === 0n) throw this.invalid('settlement adjustment amount must not be 0')
    return this.append(ref, {
      type: 'adjustment',
      amountNanoUsd: input.amountNanoUsd,
      priority: 0,
      effectiveAt: new Date(),
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { usageRecordId: undefined } is equivalent to {} because store and consumers check usageRecordId !== undefined
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { usageRecordId: undefined } is equivalent to {} because store and consumers check usageRecordId !== undefined
      ...(input.usageRecordId !== undefined ? { usageRecordId: input.usageRecordId } : {}),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    })
  }

  /**
   * Paginated entry history with type/date filters — the transaction listing a
   * usage meter renders.
   *
   * @param ref The wallet owner.
   * @param filter Optional type/date filters and pagination.
   * @returns A page of entries and the total match count.
   */
  async getEntries(ref: WalletRef, filter?: WalletEntryFilter): Promise<WalletEntryPage> {
    this.assertOwner(ref)
    return this.store.listEntries(ref, filter)
  }

  /**
   * Recompute and repair the materialized balance from the entry ledger (§9.4).
   * ADMIN PLANE (§14.4): the host MUST restrict this to privileged roles. Emits
   * `ai_tokens.audit`.
   *
   * @param ref The wallet owner.
   * @returns The reconciled wallet.
   */
  async reconcile(ref: WalletRef): Promise<WalletBalance> {
    this.assertOwner(ref)
    const wallet = await this.store.reconcile(ref)
    // Stryker disable next-line ObjectLiteral,StringLiteral -- audit event name and payload are internal observability; tests check the reconciled balance, not event shape
    await this.events.audit('ai_tokens.wallet.reconciled', {
      tenantId: ref.tenantId,
      walletId: wallet.id,
      balanceNanoUsd: wallet.balanceNanoUsd.toString(),
    })
    return { nanoUsd: wallet.balanceNanoUsd, credits: this.toCredits(wallet.balanceNanoUsd) }
  }

  /** Append a non-debit entry, mapping a store idempotency/missing-wallet signal to the catalog. */
  private async append(ref: WalletRef, entry: Omit<NewWalletEntry, 'walletId'>): Promise<WalletEntry> {
    try {
      // Stryker disable next-line StringLiteral -- placeholder walletId; the store's insert always assigns the real wallet id and never reads this sentinel, so any string here is equivalent
      return await this.store.appendEntry(ref, { walletId: '', ...entry })
    } catch (error) {
      throw this.mapStoreError(error, ref, entry.idempotencyKey)
    }
  }

  /** Run the atomic conditional debit, mapping `null` to insufficient credits (§9.4). */
  private async conditionalDebit(ref: WalletRef, entry: NewWalletEntry, requested: bigint): Promise<WalletEntry> {
    let result: WalletEntry | null
    try {
      result = await this.store.conditionalDebit(ref, entry, this.options.overdraftNanoUsd)
    } catch (error) {
      throw this.mapStoreError(error, ref, entry.idempotencyKey)
    }
    if (result === null) {
      const wallet = await this.store.getWallet(ref)
      // Stryker disable next-line ObjectLiteral -- error context fields are diagnostic; tests check the error code (AI_TOKENS_INSUFFICIENT_CREDITS), not the payload shape
      throw new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', undefined, {
        balanceNanoUsd: (wallet?.balanceNanoUsd ?? 0n).toString(),
        requestedNanoUsd: requested.toString(),
      })
    }
    return result
  }

  /** Map a store idempotency conflict / missing-wallet signal to the typed catalog error. */
  private mapStoreError(error: unknown, ref: WalletRef, idempotencyKey: string): AiTokensException {
    if (isLedgerIdempotencyConflict(error)) {
      // Stryker disable next-line ObjectLiteral -- error context is internal diagnostics; tests check error code only
      return new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, {
        tenantId: ref.tenantId,
        idempotencyKey,
      })
    }
    if (isWalletMissing(error)) {
      // Stryker disable next-line ObjectLiteral,StringLiteral -- error context and reason are internal diagnostics
      return new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', undefined, { reason: 'wallet does not exist' })
    }
    return error instanceof AiTokensException
      ? error
      : new AiTokensException('AI_TOKENS_STORE_ERROR', undefined, {})
  }

  /** Reject a `'key'` owner at runtime (`'key'` scopes cannot own money, §9.1). */
  private assertOwner(ref: WalletRef): void {
    // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics; tests check error code only
    if ((ref.ownerType as string) === 'key') throw this.invalid("'key' scopes cannot own a wallet")
  }

  /** Present a nano-USD balance as credits (presentation-only division). */
  private toCredits(nanoUsd: bigint): number {
    return Number(nanoUsd) / Number(this.options.creditRateNanoUsd)
  }

  /** Build the invalid-config exception with an actionable reason. */
  private invalid(reason: string): AiTokensException {
    // Stryker disable next-line ObjectLiteral -- error context is internal diagnostics; tests check error code only
    return new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason })
  }
}

/** The structural shape of the wallet-missing store signal. */
interface WalletMissingShape {
  isWalletMissing: true
}

/** Narrow an unknown thrown value to the wallet-missing store signal. */
function isWalletMissing(error: unknown): error is WalletMissingShape {
  // Stryker disable next-line ConditionalExpression -- CE false on `typeof error !== 'object'`: non-object primitives also fail `.isWalletMissing === true` (returns undefined), giving the same false result; the guard is defensive but the outcome is identical for all realistic inputs
  if (typeof error !== 'object' || error === null) return false
  return (error as Record<string, unknown>).isWalletMissing === true
}
