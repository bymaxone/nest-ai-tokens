/**
 * @fileoverview Targeted unit tests for {@link MeteringEffects}.
 *
 * Tests the side-effect matrix (spec §11.2) at the MeteringEffects level directly:
 * correct idempotency-key prefixes on every wallet operation, correct budget API call
 * order, compensation semantics on failures, isSystemCost skip, and the legFor
 * boundary conditions (amount = 0, signed vs unsigned, key-type scope).
 *
 * These tests do NOT go through MeteringService — they construct MeteringEffects with
 * spy-able WalletService and BudgetService instances so that exact arguments are
 * verifiable.
 *
 * @layer test/unit
 */

import { Logger } from '@nestjs/common'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { MeteringContext } from '../interfaces'
import type { UsageRecord } from '../../shared'
import { LedgerService } from './ledger.service'
import { BudgetService } from './budget.service'
import { WalletService } from './wallet.service'
import { MeteringEffects, type EffectDelta } from './metering-effects'
import type { ResolvedAiTokensOptions } from '../config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use real time so wallet grants are immediately effective (frozen time would
// cause grants created with new Date() to appear future-dated relative to the store).
const now = (): Date => new Date()

/** A minimal metering context for the payer scope used in all tests. */
function ctx(): MeteringContext {
  return { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }
}

/** A minimal effect delta that has a non-zero billable amount. */
function delta(over: Partial<EffectDelta> = {}): EffectDelta {
  return { billedNanoUsd: 10_000_000n, tokens: 1000, count: 1, ...over }
}

/** A minimal posted usage record whose fields align with ctx(). */
function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'rec-1',
    tenantId: 'tenant-1',
    scope: { type: 'user', id: 'u1' },
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    feature: 'chat.reply',
    tags: [],
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
    totalTokens: 1500,
    priceVersionId: 'price-1',
    rawCostNanoUsd: 10_000_000n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 10_000_000n,
    markupMultiplier: 1,
    currency: 'nano-USD',
    priceMissing: false,
    status: 'posted',
    isSystemCost: false,
    enforced: false,
    idempotencyKey: 'idem-1',
    occurredAt: now(),
    createdAt: now(),
    updatedAt: now(),
    ...over,
  }
}

/** Shared resolved-options shape for budget service construction. */
const BUDGET_OPTIONS = {
  enabled: true as const,
  defaultPolicy: 'block' as const,
  alertThresholds: [0.8, 1] as const,
  failClosed: false,
}

/** Shared resolved-options shape for wallet service construction. */
const WALLET_OPTIONS = {
  enabled: true as const,
  creditRateNanoUsd: 1_000_000_000n,
  overdraftNanoUsd: 0n,
  burnOrder: 'expiry' as const,
}

/** Resolved options stub used to build BudgetService (only the budget slice is needed). */
const OPTIONS_WITH_WALLETS: Pick<ResolvedAiTokensOptions, 'ledger' | 'pricing' | 'holds' | 'ratingMode' | 'markup' | 'wallets' | 'budgets'> = {
  ratingMode: 'rate-table',
  markup: 1,
  ledger: { hashChain: false },
  pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
  holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
  wallets: WALLET_OPTIONS,
  budgets: BUDGET_OPTIONS,
}

/** Build a WalletService backed by an in-memory store. */
function buildWalletService(): { service: WalletService; store: InMemoryWalletStore } {
  const store = new InMemoryWalletStore({ now })
  return { service: new WalletService(store, WALLET_OPTIONS), store }
}

/** Build a BudgetService backed by in-memory stores. */
function buildBudgetService(): { service: BudgetService; store: InMemoryBudgetStore } {
  const budgetStore = new InMemoryBudgetStore({ now })
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  const ledger = new LedgerService(ledgerStore, OPTIONS_WITH_WALLETS)
  void pricingStore
  const service = new BudgetService(budgetStore, ledger, BUDGET_OPTIONS, now)
  return { service, store: budgetStore }
}

/** Seed a $25 grant for the default user (so debit calls succeed). */
async function grantToUser(wallets: WalletService, amount = 25_000_000_000n): Promise<void> {
  await wallets.grant(
    { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' },
    { amountNanoUsd: amount, idempotencyKey: 'seed-grant', reason: 'test seed' },
  )
}

// ---------------------------------------------------------------------------
// reserveHold — wallet idempotency key, budget consume order
// ---------------------------------------------------------------------------

describe('MeteringEffects.reserveHold', () => {
  /**
   * The wallet debit idempotency key MUST use the `hold:${ledgerKey}` prefix so
   * replays of reserveHold with the same ledger key hit the same idempotency slot
   * and are therefore no-ops (spec §8.4 / §11.2).
   */
  it('debits the wallet with idempotency key "hold:<ledgerKey>"', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets)
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.reserveHold(ctx(), delta(), 'ledger-key-abc')

    expect(debit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      expect.objectContaining({ idempotencyKey: 'hold:ledger-key-abc' }),
    )
  })

  /**
   * The debit reason MUST be 'auth-hold reservation' so wallet entries are
   * self-describing in audit logs.
   */
  it('uses reason "auth-hold reservation" for the wallet debit', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets)
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.reserveHold(ctx(), delta(), 'key-1')

    expect(debit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'auth-hold reservation' }),
    )
  })

  /**
   * Budget consume happens BEFORE the wallet debit (§11.2 ordering: cheapest
   * rollback first). If the budget fails, the wallet must NOT be debited.
   */
  it('consumes the budget before debiting the wallet', async () => {
    const { service: budgets } = buildBudgetService()
    // Set up a budget that will block (limit = 0 tokens)
    await budgets.upsertBudget({
      tenantId: 'tenant-1',
      scope: { type: 'user', id: 'u1' },
      window: 'month',
      limitTokens: 0,
    })
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets)
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, budgets)
    await expect(effects.reserveHold(ctx(), delta(), 'key-2')).rejects.toThrow()
    // Wallet debit must NOT have been called when budget blocked
    expect(debit).not.toHaveBeenCalled()
  })

  /**
   * When the wallet debit fails, the budget consumption is rolled back (the
   * compensating release keeps the net state at zero).
   */
  it('releases the budget when the wallet debit fails', async () => {
    const { service: budgets } = buildBudgetService()
    await budgets.upsertBudget({
      tenantId: 'tenant-1',
      scope: { type: 'user', id: 'u1' },
      window: 'month',
      limitNanoUsd: 100_000_000_000n,
    })
    const { service: wallets } = buildWalletService()
    // No grant → debit will fail (insufficient credits)
    const release = jest.spyOn(budgets, 'release')

    const effects = new MeteringEffects(wallets, budgets)
    await expect(effects.reserveHold(ctx(), delta(), 'key-3')).rejects.toThrow()
    expect(release).toHaveBeenCalled()
  })

  /**
   * With wallets disabled (undefined), reserveHold only calls budget.consume —
   * no wallet operation is attempted.
   */
  it('skips the wallet debit when wallets are disabled', async () => {
    const { service: budgets } = buildBudgetService()
    await budgets.upsertBudget({
      tenantId: 'tenant-1',
      scope: { type: 'user', id: 'u1' },
      window: 'month',
      limitNanoUsd: 100_000_000_000n,
    })
    const consume = jest.spyOn(budgets, 'consume')

    const effects = new MeteringEffects(undefined, budgets)
    await effects.reserveHold(ctx(), delta(), 'key-4')
    expect(consume).toHaveBeenCalledTimes(1)
  })

  /**
   * A zero-amount delta produces no wallet leg (legFor returns null for amount ≤ 0n).
   */
  it('skips the wallet debit for a zero-amount delta', async () => {
    const { service: wallets } = buildWalletService()
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.reserveHold(ctx(), delta({ billedNanoUsd: 0n }), 'key-5')
    expect(debit).not.toHaveBeenCalled()
  })

  /**
   * A 'key' scope does not own a wallet (scopeOwnsWallet → false) so no
   * wallet debit is attempted regardless of amount.
   */
  it('skips the wallet debit for a key-type scope', async () => {
    const { service: wallets } = buildWalletService()
    const debit = jest.spyOn(wallets, 'debit')
    const keyCtx: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'key', id: 'api-key-1' }, feature: 'chat.reply' }

    const effects = new MeteringEffects(wallets, undefined)
    await effects.reserveHold(keyCtx, delta(), 'key-6')
    expect(debit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// compensateHold — idempotency key, best-effort semantics
// ---------------------------------------------------------------------------

describe('MeteringEffects.compensateHold', () => {
  /**
   * The rollback refund idempotency key MUST be 'hold-rollback:<ledgerKey>' so that
   * a compensateHold replay does not re-refund if the first attempt partially succeeded.
   */
  it('refunds the wallet with idempotency key "hold-rollback:<ledgerKey>"', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets)
    // First reserve so there is a debit to refund
    const effects = new MeteringEffects(wallets, undefined)
    await effects.reserveHold(ctx(), delta(), 'lk-1')
    const refund = jest.spyOn(wallets, 'refund')

    await effects.compensateHold(ctx(), delta(), 'lk-1')
    expect(refund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'hold-rollback:lk-1' }),
    )
  })

  /**
   * The rollback refund reason MUST be 'hold rollback' so wallet entries identify the
   * source operation in audit logs and cross-reference the rolled-back reservation.
   */
  it('uses reason "hold rollback" for the rollback refund', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets)
    const effects = new MeteringEffects(wallets, undefined)
    await effects.reserveHold(ctx(), delta(), 'lk-5')
    const refund = jest.spyOn(wallets, 'refund')

    await effects.compensateHold(ctx(), delta(), 'lk-5')

    expect(refund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'hold rollback' }),
    )
  })

  /**
   * A wallet refund failure during compensateHold must NOT mask the original error:
   * compensateHold is best-effort and always resolves (the rollback failure is logged).
   * Asserting the `logger.warn` fires also kills the catch-body BlockStatement mutant
   * (emptying `catch { this.logger.warn(...) }`): an empty body swallows silently with no
   * warn, so the spy assertion fails — while the resolve assertion alone cannot observe it.
   */
  it('does not throw when the rollback wallet refund fails', async () => {
    const { service: wallets } = buildWalletService()
    jest.spyOn(wallets, 'refund').mockRejectedValueOnce(new Error('refund down'))
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    const effects = new MeteringEffects(wallets, undefined)
    await expect(effects.compensateHold(ctx(), delta(), 'lk-2')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to refund a hold debit during rollback'))
    warn.mockRestore()
  })

  /**
   * A budget release failure during compensateHold must NOT throw: the rollback is
   * best-effort so it does not mask the original insert failure. Asserting that
   * budgets.release is actually attempted kills the BlockStatement mutation that would
   * empty the `try { await this.budgets.release(...) }` body (an empty body would never
   * call release), and asserting the `logger.warn` fires kills the distinct catch-body
   * BlockStatement mutant (emptying `catch { this.logger.warn(...) }` — silent swallow).
   */
  it('does not throw when the rollback budget release fails', async () => {
    const { service: budgets } = buildBudgetService()
    const release = jest.spyOn(budgets, 'release').mockRejectedValueOnce(new Error('release down'))
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    const effects = new MeteringEffects(undefined, budgets)
    await expect(effects.compensateHold(ctx(), delta(), 'lk-3')).resolves.toBeUndefined()
    expect(release).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to release a budget reservation during rollback'))
    warn.mockRestore()
  })

  /**
   * With budgets disabled, compensateHold returns early after the optional wallet
   * refund — no budget release is attempted.
   */
  it('skips budget release when budgets are disabled', async () => {
    const { service: wallets } = buildWalletService()
    const refund = jest.spyOn(wallets, 'refund').mockResolvedValue({} as never)

    const effects = new MeteringEffects(wallets, undefined)
    await effects.compensateHold(ctx(), delta(), 'lk-4')
    expect(refund).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// settleCapture — signed wallet delta, isSystemCost skip
// ---------------------------------------------------------------------------

describe('MeteringEffects.settleCapture', () => {
  /**
   * The settle-adjustment idempotency key MUST be 'capture:<record.id>' — a stable
   * key that prevents double-settlement if capture() is called twice (spec §11.1
   * idempotent capture).
   */
  it('settles the wallet adjustment with idempotency key "capture:<record.id>"', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    const settle = jest.spyOn(wallets, 'settleAdjustment')

    const effects = new MeteringEffects(wallets, undefined)
    const rec = record({ billedCostNanoUsd: 10_000_000n })
    // reserve > actual → walletDelta = 5_000_000n (refund)
    await effects.settleCapture(rec, 15_000_000n, 1500, 10_000_000n, 1000)

    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'capture:rec-1' }),
    )
  })

  /**
   * The settle-adjustment reason MUST be 'hold capture settlement' so wallet entries
   * are self-describing in audit logs and cross-reference the original hold.
   */
  it('uses reason "hold capture settlement" for the wallet settlement', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    const settle = jest.spyOn(wallets, 'settleAdjustment')

    const effects = new MeteringEffects(wallets, undefined)
    // reserve > actual → positive walletDelta triggers settleAdjustment
    await effects.settleCapture(record({ billedCostNanoUsd: 10_000_000n }), 15_000_000n, 1500, 10_000_000n, 1000)

    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'hold capture settlement' }),
    )
  })

  /**
   * isSystemCost records skip ALL wallet/budget effects in settleCapture
   * (the system-cost payer scope is internal; its costs are not billed to a wallet).
   */
  it('skips all effects for an isSystemCost record', async () => {
    const { service: wallets } = buildWalletService()
    const { service: budgets } = buildBudgetService()
    const settle = jest.spyOn(wallets, 'settleAdjustment')
    const adjust = jest.spyOn(budgets, 'adjust')

    const effects = new MeteringEffects(wallets, budgets)
    await effects.settleCapture(record({ isSystemCost: true }), 10_000_000n, 1000, 5_000_000n, 500)

    expect(settle).not.toHaveBeenCalled()
    expect(adjust).not.toHaveBeenCalled()
  })

  /**
   * When actual > reserve (walletDelta < 0), settleAdjustment IS called with the
   * negative delta (a debit adjustment to collect the overage). The signed=true guard
   * in legFor only skips when walletDelta === 0n exactly.
   */
  it('calls settleAdjustment with the negative delta when actual cost exceeds the reserve', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    const settle = jest.spyOn(wallets, 'settleAdjustment')

    const effects = new MeteringEffects(wallets, undefined)
    // reserved=5_000_000n, actual=10_000_000n → walletDelta = -5_000_000n
    await effects.settleCapture(record({ billedCostNanoUsd: 10_000_000n }), 5_000_000n, 500, 10_000_000n, 1000)

    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountNanoUsd: -5_000_000n }),
    )
  })

  /**
   * When reserve === actual (walletDelta = 0n), no wallet settlement is needed
   * (the amount = 0 guard in legFor for signed mode returns null).
   */
  it('skips the wallet settle when actual cost equals the reserve exactly', async () => {
    const { service: wallets } = buildWalletService()
    const settle = jest.spyOn(wallets, 'settleAdjustment')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.settleCapture(record({ billedCostNanoUsd: 10_000_000n }), 10_000_000n, 1000, 10_000_000n, 1000)

    expect(settle).not.toHaveBeenCalled()
  })

  /**
   * settleCapture applies the signed ±delta between actuals and the reserve to the
   * budget window/counter (§11.2). Asserting budgets.adjust is invoked with the exact
   * bigint nano-USD and token deltas kills the BlockStatement mutation that would empty
   * the `if (this.budgets !== undefined) { await this.budgets.adjust(...) }` body — an
   * empty body would never reconcile the budget with the settled actuals. Wallets are
   * left undefined to isolate the budget leg.
   */
  it('adjusts the budget by the signed actual-minus-reserved delta', async () => {
    const { service: budgets } = buildBudgetService()
    const adjust = jest.spyOn(budgets, 'adjust')

    // reserved 15M nano-USD / 1500 tokens vs actual 10M / 1000 → delta -5M / -500, count 0.
    const effects = new MeteringEffects(undefined, budgets)
    await effects.settleCapture(record({ billedCostNanoUsd: 10_000_000n }), 15_000_000n, 1500, 10_000_000n, 1000)

    expect(adjust).toHaveBeenCalledWith(expect.anything(), { nanoUsd: -5_000_000n, tokens: -500, count: 0 })
  })
})

// ---------------------------------------------------------------------------
// restoreHold — idempotency key, isSystemCost skip
// ---------------------------------------------------------------------------

describe('MeteringEffects.restoreHold', () => {
  /**
   * The release refund idempotency key MUST be 'release:<record.id>' so that
   * a hold-reaper replay of restoreHold does not double-refund the wallet.
   */
  it('refunds the wallet with idempotency key "release:<record.id>"', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    // Pre-debit so the refund has a positive source
    await wallets.debit(
      { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' },
      { amountNanoUsd: 10_000_000n, idempotencyKey: 'pre-debit-1', reason: 'pre-debit' },
    )
    const refund = jest.spyOn(wallets, 'refund')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.restoreHold(record({ billedCostNanoUsd: 10_000_000n }))

    expect(refund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'release:rec-1' }),
    )
  })

  /**
   * The release refund reason MUST be 'hold released' for audit clarity.
   */
  it('uses reason "hold released" for the release refund', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    await wallets.debit(
      { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' },
      { amountNanoUsd: 10_000_000n, idempotencyKey: 'pre-debit-2', reason: 'pre-debit' },
    )
    const refund = jest.spyOn(wallets, 'refund')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.restoreHold(record({ billedCostNanoUsd: 10_000_000n }))

    expect(refund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'hold released' }),
    )
  })

  /**
   * isSystemCost holds skip ALL wallet/budget effects in restoreHold.
   */
  it('skips all effects for an isSystemCost record', async () => {
    const { service: wallets } = buildWalletService()
    const { service: budgets } = buildBudgetService()
    const refund = jest.spyOn(wallets, 'refund')
    const release = jest.spyOn(budgets, 'release')

    const effects = new MeteringEffects(wallets, budgets)
    await effects.restoreHold(record({ isSystemCost: true }))

    expect(refund).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  /**
   * Budget release happens before wallet refund in restoreHold (§11.2 ordering).
   * Verified by checking that both services are called and the record is processed.
   */
  it('calls budget release and wallet refund for a standard hold restore', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    await wallets.debit(
      { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' },
      { amountNanoUsd: 10_000_000n, idempotencyKey: 'pre-debit-3', reason: 'pre-debit' },
    )
    const { service: budgets } = buildBudgetService()
    await budgets.upsertBudget({
      tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, window: 'month', limitNanoUsd: 100_000_000_000n,
    })
    const release = jest.spyOn(budgets, 'release')
    const refund = jest.spyOn(wallets, 'refund')

    const effects = new MeteringEffects(wallets, budgets)
    await effects.restoreHold(record({ billedCostNanoUsd: 10_000_000n }))

    expect(release).toHaveBeenCalledTimes(1)
    expect(refund).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// reverseEffects — idempotency key, best-effort, caller reason forwarded
// ---------------------------------------------------------------------------

describe('MeteringEffects.reverseEffects', () => {
  /**
   * The reverse refund idempotency key MUST be 'reverse:<record.id>' — deterministic
   * so a replay of reverse() is idempotent at the wallet level.
   */
  it('refunds the wallet with idempotency key "reverse:<record.id>"', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    await wallets.debit(
      { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' },
      { amountNanoUsd: 10_000_000n, idempotencyKey: 'pre-debit-4', reason: 'pre-debit' },
    )
    const refund = jest.spyOn(wallets, 'refund')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.reverseEffects(record({ billedCostNanoUsd: 10_000_000n }), 'test-reason')

    expect(refund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'reverse:rec-1' }),
    )
  })

  /**
   * The caller's reason string MUST be forwarded to the wallet refund so it appears
   * in the wallet entry and audit trail.
   */
  it('forwards the caller reason to the wallet refund', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    await wallets.debit(
      { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' },
      { amountNanoUsd: 10_000_000n, idempotencyKey: 'pre-debit-5', reason: 'pre-debit' },
    )
    const refund = jest.spyOn(wallets, 'refund')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.reverseEffects(record({ billedCostNanoUsd: 10_000_000n }), 'customer-dispute')

    expect(refund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'customer-dispute' }),
    )
  })

  /**
   * A wallet refund failure during reverseEffects is swallowed (best-effort — spec
   * §8.5 step 3). The budget release still runs. Asserting the `logger.warn` fires kills
   * the catch-body BlockStatement mutant (emptying `catch { this.logger.warn(...) }`);
   * here budgets.release is mocked to resolve, so the refund catch is the sole warn source.
   */
  it('does not throw when the wallet refund fails during reversal', async () => {
    const { service: wallets } = buildWalletService()
    jest.spyOn(wallets, 'refund').mockRejectedValueOnce(new Error('refund down'))
    const { service: budgets } = buildBudgetService()
    const release = jest.spyOn(budgets, 'release').mockResolvedValue()
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    const effects = new MeteringEffects(wallets, budgets)
    await expect(effects.reverseEffects(record(), 'reason')).resolves.toBeUndefined()
    // Budget release still runs despite wallet failure
    expect(release).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to refund a wallet debit during reversal'))
    warn.mockRestore()
  })

  /**
   * A budget release failure during reverseEffects is swallowed (best-effort). Asserting
   * the `logger.warn` fires kills the catch-body BlockStatement mutant (emptying
   * `catch { this.logger.warn(...) }` — a silent swallow the resolve assertion cannot see).
   */
  it('does not throw when the budget release fails during reversal', async () => {
    const { service: budgets } = buildBudgetService()
    jest.spyOn(budgets, 'release').mockRejectedValueOnce(new Error('release down'))
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    const effects = new MeteringEffects(undefined, budgets)
    await expect(effects.reverseEffects(record(), 'reason')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to release a budget consumption during reversal'))
    warn.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// enforceRecord — idempotency key, budget+wallet ordering, isSystemCost skip
// ---------------------------------------------------------------------------

describe('MeteringEffects.enforceRecord', () => {
  /**
   * The post-hoc enforcement wallet debit idempotency key MUST be 'record:<record.id>'
   * so that a retry of enforceRecord is idempotent (spec §11.2 post-hoc path).
   */
  it('debits the wallet with idempotency key "record:<record.id>"', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.enforceRecord(record())

    expect(debit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'record:rec-1' }),
    )
  })

  /**
   * The enforcement debit reason MUST be 'post-hoc enforcement' for audit clarity.
   */
  it('uses reason "post-hoc enforcement" for the wallet debit', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.enforceRecord(record())

    expect(debit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'post-hoc enforcement' }),
    )
  })

  /**
   * Budget consume happens BEFORE wallet debit in enforceRecord (§11.2 ordering).
   * If the wallet debit fails, the budget consumption is rolled back.
   */
  it('releases the budget when the wallet debit fails during enforcement', async () => {
    const { service: budgets } = buildBudgetService()
    await budgets.upsertBudget({
      tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, window: 'month', limitNanoUsd: 100_000_000_000n,
    })
    const { service: wallets } = buildWalletService()
    // No grant → debit fails
    const release = jest.spyOn(budgets, 'release')

    const effects = new MeteringEffects(wallets, budgets)
    await expect(effects.enforceRecord(record())).rejects.toThrow()
    expect(release).toHaveBeenCalled()
  })

  /**
   * isSystemCost records skip ALL effects in enforceRecord — the system-cost payer
   * scope's costs are not charged to a budget or wallet.
   */
  it('skips all effects for an isSystemCost record', async () => {
    const { service: wallets } = buildWalletService()
    const { service: budgets } = buildBudgetService()
    const consume = jest.spyOn(budgets, 'consume')
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, budgets)
    await effects.enforceRecord(record({ isSystemCost: true }))

    expect(consume).not.toHaveBeenCalled()
    expect(debit).not.toHaveBeenCalled()
  })
})
