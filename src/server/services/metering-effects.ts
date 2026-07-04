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
import type { BudgetDelta, MeteringContext } from '../interfaces'
import { scopeOwnsWallet, scopeToWalletRef } from '../utils/scope-wallet'
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
    // Stryker disable next-line BooleanLiteral -- billedNanoUsd is always ≥ 0n by contract; signed=false/true are equivalent for non-negative amounts
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
    // Stryker disable next-line BooleanLiteral -- billedNanoUsd is always ≥ 0n by contract
    const leg = this.legFor(context.tenantId, context.scope, delta.billedNanoUsd, false)
    if (leg !== null) {
      try {
        await leg.wallets.refund(leg.ref, { amountNanoUsd: delta.billedNanoUsd, idempotencyKey: `hold-rollback:${ledgerKey}`, reason: 'hold rollback' })
      } catch {
        // Stryker disable next-line StringLiteral -- logger.warn text is internal observability; the observable contract is that compensateHold resolves (best-effort)
        this.logger.warn('failed to refund a hold debit during rollback')
      }
    }
    if (this.budgets === undefined) return
    try {
      await this.budgets.release(context, budgetDelta(delta))
    } catch {
      // Stryker disable next-line StringLiteral -- logger.warn text is internal observability
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
      await this.budgets.adjust(contextOf(record), { nanoUsd: actualBilledNanoUsd - reservedBilledNanoUsd, tokens: actualTokens - reservedTokens, count: 0 })
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
      await this.budgets.release(contextOf(record), { nanoUsd: record.billedCostNanoUsd, tokens: record.totalTokens, count: 1 })
    }
    // Stryker disable next-line BooleanLiteral -- billedCostNanoUsd is always ≥ 0n by contract
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
    // Stryker disable next-line BooleanLiteral -- billedCostNanoUsd is always ≥ 0n by contract
    const leg = this.legFor(record.tenantId, record.scope, record.billedCostNanoUsd, false)
    if (leg !== null) {
      try {
        await leg.wallets.refund(leg.ref, { amountNanoUsd: record.billedCostNanoUsd, usageRecordId: record.id, idempotencyKey: `reverse:${record.id}`, reason })
      } catch {
        // Stryker disable next-line StringLiteral -- logger.warn text is internal observability
        this.logger.warn('failed to refund a wallet debit during reversal')
      }
    }
    if (this.budgets === undefined) return
    try {
      await this.budgets.release(contextOf(record), { nanoUsd: record.billedCostNanoUsd, tokens: record.totalTokens, count: 1 })
    } catch {
      // Stryker disable next-line StringLiteral -- logger.warn text is internal observability
      this.logger.warn('failed to release a budget consumption during reversal')
    }
  }

  /**
   * Post-hoc enforcement for `record({ enforce: true })` — consume the budget then
   * debit the wallet AFTER the ledger write (the §11.2 trade-off; both may throw). A
   * wallet shortfall rolls the budget consumption back before rethrowing.
   *
   * @param record The just-persisted enforced record.
   * @throws {AiTokensException} A budget/quota/credits error when a limit is exhausted.
   */
  async enforceRecord(record: UsageRecord): Promise<void> {
    if (record.isSystemCost) return
    const delta = budgetDelta({ billedNanoUsd: record.billedCostNanoUsd, tokens: record.totalTokens, count: 1 })
    if (this.budgets !== undefined) await this.budgets.consume(contextOf(record), delta)
    // Stryker disable next-line BooleanLiteral -- billedCostNanoUsd is always ≥ 0n by contract
    const leg = this.legFor(record.tenantId, record.scope, record.billedCostNanoUsd, false)
    if (leg === null) return
    try {
      await leg.wallets.debit(leg.ref, { amountNanoUsd: record.billedCostNanoUsd, usageRecordId: record.id, idempotencyKey: `record:${record.id}`, reason: 'post-hoc enforcement' })
    } catch (error) {
      if (this.budgets !== undefined) await this.budgets.release(contextOf(record), delta)
      throw error
    }
  }
}
