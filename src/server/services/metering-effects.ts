/**
 * @fileoverview `MeteringEffects` — the wallet + budget + live-counter movements
 * behind the metering lifecycle (spec §11.2 side-effect matrix). It owns the exact
 * signs and the deterministic, hold-derived idempotency keys so every money path is
 * crash-safe on replay: a hold reserves (budget consume → wallet debit, each step
 * compensating the previous), a capture settles the ±delta (never re-blocking), a
 * release/reverse restores in full, and post-hoc `record({ enforce })` consumes
 * after the ledger write. All amounts are bigint nano-USD; a `'key'` payer scope is
 * skipped on the wallet leg (keys spend their owner's wallet, resolved by the host).
 * Internal — not part of the public barrel.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { MeteringScope, UsageRecord, WalletRef } from '../../shared'
import type { LedgerAppendInput } from './ledger.service'
import { sumTokens } from './ledger.service'
import type { BudgetDelta, MeteringContext } from '../interfaces'
import { sameScope, scopeOwnsWallet, scopeToWalletRef } from '../utils/scope-wallet'
import type { BudgetService } from './budget.service'
import type { WalletService } from './wallet.service'

/** The reservation an effects call moves across the three budget dimensions. */
export interface EffectDelta {
  billedNanoUsd: bigint
  tokens: number
  count: number
}

/** A resolvable wallet leg: the wallet service plus the owner ref for a payer scope. */
interface WalletLeg {
  wallets: WalletService
  ref: WalletRef
}

/** Build a budget delta from an effect delta. */
function budgetDelta(delta: EffectDelta): BudgetDelta {
  return { nanoUsd: delta.billedNanoUsd, tokens: delta.tokens, count: delta.count }
}

/** What one post-hoc enforcement moves; see {@link MeteringEffects.enforcementOf}. */
export interface Enforcement {
  tenantId: string
  scope: MeteringScope
  feature: string
  occurredAt: Date
  billedNanoUsd: bigint
  tokens: number
  key: string
}

/** The budget delta of an enforcement: its cost, its tokens and one call. */
function enforcementDelta(enforcement: Enforcement): BudgetDelta {
  return budgetDelta({ billedNanoUsd: enforcement.billedNanoUsd, tokens: enforcement.tokens, count: 1 })
}

/** The scope-context the budget service reads an enforcement through. */
function enforcementContext(enforcement: Enforcement): MeteringContext {
  return { tenantId: enforcement.tenantId, scope: enforcement.scope, feature: enforcement.feature }
}

/** Rebuild a scope-context for the budget service from a persisted record. */
function contextOf(record: UsageRecord): MeteringContext {
  return { tenantId: record.tenantId, scope: record.scope, feature: record.feature }
}

/** The wallet/budget/counter movements behind the metering lifecycle. */
export class MeteringEffects {
  private readonly logger = new Logger(MeteringEffects.name)

  /**
   * @param wallets The wallet service, when the wallet feature is enabled.
   * @param budgets The budget service, when the budget feature is enabled.
   */
  constructor(
    private readonly wallets: WalletService | undefined,
    private readonly budgets: BudgetService | undefined,
  ) {}

  /**
   * The wallet leg for a payer scope, or `null` when there is nothing to move:
   * wallets disabled, a `'key'` scope (spends its owner's wallet), or a
   * non-billable amount (`≤ 0` for a debit/refund, `= 0` for a signed settlement).
   */
  private legFor(tenantId: string, scope: MeteringScope, amount: bigint, signed: boolean): WalletLeg | null {
    if (this.wallets === undefined || !scopeOwnsWallet(scope)) return null
    if (signed ? amount === 0n : amount <= 0n) return null
    return { wallets: this.wallets, ref: scopeToWalletRef(tenantId, scope) }
  }

  /**
   * Reserve a hold: consume the budget window/counter, then debit the wallet — the
   * §11.2 ordering (cheapest to roll back first). A wallet shortfall compensates the
   * budget consumption before rethrowing.
   *
   * @param context The metering context (payer scope, feature).
   * @param delta The estimated reservation.
   * @param ledgerKey The stable key deriving the wallet debit idempotency key.
   * @throws {AiTokensException} The dimension's budget/quota/credits error on a shortfall (prior steps compensated).
   */
  async reserveHold(context: MeteringContext, delta: EffectDelta, ledgerKey: string): Promise<void> {
    if (this.budgets !== undefined) await this.budgets.consume(context, budgetDelta(delta))
    // Stryker disable next-line BooleanLiteral: billedNanoUsd is always ≥ 0n by contract; signed=false/true are equivalent for non-negative amounts
    const leg = this.legFor(context.tenantId, context.scope, delta.billedNanoUsd, false)
    if (leg === null) return
    try {
      await leg.wallets.debit(leg.ref, { amountNanoUsd: delta.billedNanoUsd, idempotencyKey: `hold:${ledgerKey}`, reason: 'auth-hold reservation' })
    } catch (error) {
      if (this.budgets !== undefined) await this.budgets.release(context, budgetDelta(delta))
      throw error
    }
  }

  /**
   * Compensate a hold whose pending ledger insert failed: refund the wallet debit
   * and release the budget consumption. Best-effort — failures are logged so the
   * original insert error surfaces unmasked.
   *
   * @param context The metering context.
   * @param delta The reservation to unwind.
   * @param ledgerKey The stable key deriving the wallet rollback idempotency key.
   */
  async compensateHold(context: MeteringContext, delta: EffectDelta, ledgerKey: string): Promise<void> {
    // Stryker disable next-line BooleanLiteral: billedNanoUsd is always ≥ 0n by contract
    const leg = this.legFor(context.tenantId, context.scope, delta.billedNanoUsd, false)
    if (leg !== null) {
      try {
        await leg.wallets.refund(leg.ref, { amountNanoUsd: delta.billedNanoUsd, idempotencyKey: `hold-rollback:${ledgerKey}`, reason: 'hold rollback' })
      } catch {
        // Stryker disable next-line StringLiteral: logger.warn text is internal observability; the observable contract is that compensateHold resolves (best-effort)
        this.logger.warn('failed to refund a hold debit during rollback')
      }
    }
    if (this.budgets === undefined) return
    try {
      await this.budgets.release(context, budgetDelta(delta))
    } catch {
      // Stryker disable next-line StringLiteral: logger.warn text is internal observability
      this.logger.warn('failed to release a budget reservation during rollback')
    }
  }

  /**
   * Settle a capture: apply the signed ±delta between the actual and the reserved
   * estimate to the budget window/counter and the wallet — never re-blocking.
   *
   * @param record The now-posted record (the payer/feature source).
   * @param reservedBilledNanoUsd The hold's billed estimate.
   * @param reservedTokens The hold's estimated tokens.
   * @param actualBilledNanoUsd The settled billed cost.
   * @param actualTokens The settled token total.
   */
  async settleCapture(record: UsageRecord, reservedBilledNanoUsd: bigint, reservedTokens: number, actualBilledNanoUsd: bigint, actualTokens: number): Promise<void> {
    if (record.isSystemCost) return
    if (this.budgets !== undefined) {
      await this.budgets.adjust(
        contextOf(record),
        { nanoUsd: actualBilledNanoUsd - reservedBilledNanoUsd, tokens: actualTokens - reservedTokens, count: 0 },
        record.occurredAt,
      )
    }
    const walletDelta = reservedBilledNanoUsd - actualBilledNanoUsd
    const leg = this.legFor(record.tenantId, record.scope, walletDelta, true)
    if (leg === null) return
    await leg.wallets.settleAdjustment(leg.ref, { amountNanoUsd: walletDelta, usageRecordId: record.id, idempotencyKey: `capture:${record.id}`, reason: 'hold capture settlement' })
  }

  /**
   * Restore a hold in full — the shared code path for `release()` and the reaper.
   * Releases the reserved budget and refunds the reserved wallet debit.
   *
   * @param record The pending record being voided (carries the reserved amounts).
   */
  async restoreHold(record: UsageRecord): Promise<void> {
    if (record.isSystemCost) return
    if (this.budgets !== undefined) {
      await this.budgets.release(contextOf(record), { nanoUsd: record.billedCostNanoUsd, tokens: record.totalTokens, count: 1 }, record.occurredAt)
    }
    // Stryker disable next-line BooleanLiteral: billedCostNanoUsd is always ≥ 0n by contract
    const leg = this.legFor(record.tenantId, record.scope, record.billedCostNanoUsd, false)
    if (leg === null) return
    await leg.wallets.refund(leg.ref, { amountNanoUsd: record.billedCostNanoUsd, usageRecordId: record.id, idempotencyKey: `release:${record.id}`, reason: 'hold released' })
  }

  /**
   * Compensate a reversed posted record — best-effort across stores (§8.5 step 3;
   * cross-store 2PC is out of scope, deterministic keys make retries safe).
   *
   * @param record The reversed (annotated) original record.
   * @param reason The caller's stated reason (echoed on the wallet refund).
   */
  async reverseEffects(record: UsageRecord, reason: string): Promise<void> {
    // Stryker disable next-line BooleanLiteral: billedCostNanoUsd is always ≥ 0n by contract
    const leg = this.legFor(record.tenantId, record.scope, record.billedCostNanoUsd, false)
    if (leg !== null) {
      try {
        await leg.wallets.refund(leg.ref, { amountNanoUsd: record.billedCostNanoUsd, usageRecordId: record.id, idempotencyKey: `reverse:${record.id}`, reason })
      } catch {
        // Stryker disable next-line StringLiteral: logger.warn text is internal observability
        this.logger.warn('failed to refund a wallet debit during reversal')
      }
    }
    if (this.budgets === undefined) return
    try {
      await this.budgets.release(contextOf(record), { nanoUsd: record.billedCostNanoUsd, tokens: record.totalTokens, count: 1 }, record.occurredAt)
    } catch {
      // Stryker disable next-line StringLiteral: logger.warn text is internal observability
      this.logger.warn('failed to release a budget consumption during reversal')
    }
  }

  /**
   * What the enforcement of one `record({ enforce: true })` call moves, or `null` when the call moves nothing (a
   * system cost). `key` names the call: the idempotency key when there is one, so a retry moves the same wallet
   * entry, else a fresh id.
   *
   * @param input The record about to be appended.
   * @param key The call's idempotency key, or a fresh id.
   */
  enforcementOf(input: LedgerAppendInput, key: string): Enforcement | null {
    if (input.isSystemCost) return null
    return { tenantId: input.tenantId, scope: input.scope, feature: input.feature, occurredAt: input.occurredAt, billedNanoUsd: input.billedCostNanoUsd, tokens: sumTokens(input), key }
  }

  /**
   * Whether the ledger row found for a key is the same call shape as `enforcement`, so that the debit under that
   * call's key is the one both attempts share: a `record()` row (posted or reversed, never a hold, whose wallet
   * reservation is keyed differently), enforced, not a system cost, of the same payer, whose payer owns a wallet and
   * owes an amount. It is an allowlist read from the conditions {@link enforcementOf} and {@link enforce} apply, so
   * anything else (another path, payer or scope reusing the key) leaves the loser's debit its own to refund.
   *
   * @param row The record stored under the key.
   * @param scope The payer of the attempt that is asking.
   */
  sharesDebit(row: UsageRecord, scope: MeteringScope): boolean {
    const record = row.status === 'posted' || row.status === 'reversed'
    // Stryker disable next-line BooleanLiteral: billedCostNanoUsd is always ≥ 0n by contract
    return record && row.enforced && !row.isSystemCost && sameScope(row.scope, scope) && this.legFor(row.tenantId, row.scope, row.billedCostNanoUsd, false) !== null
  }

  /**
   * Post-hoc enforcement for `record({ enforce: true })`: consume the budget, then debit the wallet, BEFORE the
   * ledger row is appended, so the row of an enforced call exists only when both accepted it. A refused call
   * leaves no row and no effect, and a retry of it is decided afresh. A wallet shortfall rolls the budget
   * consumption back before rethrowing.
   *
   * @param enforcement The movement derived from the record about to be appended.
   * @throws {AiTokensException} A budget/quota/credits error when a limit is exhausted.
   */
  async enforce(enforcement: Enforcement): Promise<void> {
    const delta = enforcementDelta(enforcement)
    const context = enforcementContext(enforcement)
    if (this.budgets !== undefined) await this.budgets.consume(context, delta, enforcement.occurredAt)
    // Stryker disable next-line BooleanLiteral: billedNanoUsd is always ≥ 0n by contract
    const leg = this.legFor(enforcement.tenantId, enforcement.scope, enforcement.billedNanoUsd, false)
    if (leg === null) return
    try {
      await leg.wallets.debit(leg.ref, { amountNanoUsd: enforcement.billedNanoUsd, idempotencyKey: `record:${enforcement.key}`, reason: 'post-hoc enforcement' })
    } catch (error) {
      if (this.budgets !== undefined) await this.budgets.release(context, delta, enforcement.occurredAt)
      throw error
    }
  }

  /**
   * Undo {@link enforce} for a call whose ledger row was not appended. The budget consumption is always released;
   * the wallet debit is refunded only when `refundWallet` is set, which a caller leaves unset when another attempt
   * with the same key appended its row, because that attempt's debit is the one the debit key replays.
   * Best-effort: a failure is logged so the original error surfaces unmasked.
   *
   * @param enforcement The movement {@link enforce} made.
   * @param refundWallet Whether to refund the wallet debit as well.
   */
  async withdraw(enforcement: Enforcement, refundWallet: boolean): Promise<void> {
    // Stryker disable next-line BooleanLiteral: billedNanoUsd is always ≥ 0n by contract
    const leg = refundWallet ? this.legFor(enforcement.tenantId, enforcement.scope, enforcement.billedNanoUsd, false) : null
    if (leg !== null) {
      try {
        await leg.wallets.refund(leg.ref, { amountNanoUsd: enforcement.billedNanoUsd, idempotencyKey: `record-rollback:${enforcement.key}`, reason: 'enforcement rollback' })
      } catch {
        this.logger.warn('failed to refund a wallet debit while withdrawing')
      }
    }
    if (this.budgets === undefined) return
    try {
      await this.budgets.release(enforcementContext(enforcement), enforcementDelta(enforcement), enforcement.occurredAt)
    } catch {
      this.logger.warn('failed to release a budget consumption while withdrawing')
    }
  }
}
