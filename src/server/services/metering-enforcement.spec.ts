/**
 * @fileoverview `MeteringEffects.enforce` and `MeteringEffects.withdraw` — the post-hoc enforcement that runs before a
 * `record({ enforce: true })` call writes its ledger row, and its rollback.
 * @layer test
 */
import { Logger } from '@nestjs/common'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import type { UsageRecord } from '../../shared'
import { LedgerService } from './ledger.service'
import { BudgetService } from './budget.service'
import { WalletService } from './wallet.service'
import { MeteringEffects, type Enforcement } from './metering-effects'
import type { ResolvedAiTokensOptions } from '../config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use real time so wallet grants are immediately effective (frozen time would
// cause grants created with new Date() to appear future-dated relative to the store).
const now = (): Date => new Date()

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
  const ledger = new LedgerService(ledgerStore, OPTIONS_WITH_WALLETS)
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


// ---------------------------------------------------------------------------
// enforce / withdraw — idempotency key, budget+wallet ordering, isSystemCost skip
// ---------------------------------------------------------------------------

/** The enforcement of a record built with `over`, named by the call key `k-1`. */
function enforcementFor(effects: MeteringEffects, over: Partial<UsageRecord> = {}): Enforcement {
  return effects.enforcementOf(record(over), 'k-1')!
}

describe('MeteringEffects.enforce', () => {
  /**
   * The post-hoc enforcement wallet debit idempotency key MUST be 'record:<call key>' so a retry of the
   * same call moves the same wallet entry, whether or not the first attempt reached the ledger.
   */
  it('debits the wallet with idempotency key "record:<call key>"', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.enforce(enforcementFor(effects))

    expect(debit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ idempotencyKey: 'record:k-1' }))
  })

  /**
   * The enforcement debit reason MUST be 'post-hoc enforcement' for audit clarity.
   */
  it('uses reason "post-hoc enforcement" for the wallet debit', async () => {
    const { service: wallets } = buildWalletService()
    await grantToUser(wallets, 100_000_000_000n)
    const debit = jest.spyOn(wallets, 'debit')

    const effects = new MeteringEffects(wallets, undefined)
    await effects.enforce(enforcementFor(effects))

    expect(debit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'post-hoc enforcement' }))
  })

  /**
   * Budget consume happens BEFORE wallet debit in enforce (§11.2 ordering).
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
    await expect(effects.enforce(enforcementFor(effects))).rejects.toThrow()
    expect(release).toHaveBeenCalled()
  })

  /**
   * The consumption and its rollback both locate the windows from the record's own instant, so a
   * back-dated record is charged to, and rolled back from, the same window.
   */
  it('consumes and rolls back the budget at the record instant', async () => {
    const { service: budgets } = buildBudgetService()
    await budgets.upsertBudget({
      tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, window: 'month', limitNanoUsd: 100_000_000_000n,
    })
    const { service: wallets } = buildWalletService()
    const consume = jest.spyOn(budgets, 'consume')
    const release = jest.spyOn(budgets, 'release')
    const effects = new MeteringEffects(wallets, budgets)
    const back = enforcementFor(effects, { occurredAt: new Date('2026-06-10T23:59:00.000Z') })

    await expect(effects.enforce(back)).rejects.toThrow()

    expect(consume).toHaveBeenCalledWith(expect.anything(), expect.anything(), back.occurredAt)
    expect(release).toHaveBeenCalledWith(expect.anything(), expect.anything(), back.occurredAt)
  })

  /**
   * isSystemCost records have no enforcement — the system-cost payer scope's costs are not charged to a
   * budget or wallet.
   */
  it('has no enforcement for an isSystemCost record', () => {
    const effects = new MeteringEffects(undefined, undefined)
    expect(effects.enforcementOf(record({ isSystemCost: true }), 'k-1')).toBeNull()
  })
})

describe('MeteringEffects.withdraw', () => {
  /** A call whose row was not appended gives the budget back and refunds its own wallet debit under its own key. */
  it('releases the budget and refunds the wallet under "record-rollback:<call key>"', async () => {
    const { service: wallets } = buildWalletService()
    const { service: budgets } = buildBudgetService()
    const refund = jest.spyOn(wallets, 'refund')
    const release = jest.spyOn(budgets, 'release')
    const effects = new MeteringEffects(wallets, budgets)
    const enforcement = enforcementFor(effects)

    await effects.withdraw(enforcement, true)

    expect(refund).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountNanoUsd: enforcement.billedNanoUsd, idempotencyKey: 'record-rollback:k-1', reason: 'enforcement rollback' }))
    expect(release).toHaveBeenCalledWith(expect.anything(), expect.anything(), enforcement.occurredAt)
  })

  /** When another attempt appended the row, its wallet debit is the one the key replays, so this attempt refunds nothing. */
  it('leaves the wallet alone when told another attempt owns the debit', async () => {
    const { service: wallets } = buildWalletService()
    const { service: budgets } = buildBudgetService()
    const refund = jest.spyOn(wallets, 'refund')
    const release = jest.spyOn(budgets, 'release')
    const effects = new MeteringEffects(wallets, budgets)

    await effects.withdraw(enforcementFor(effects), false)

    expect(refund).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalled()
  })

  /** Without the budget feature there is nothing to release, and a wallet-only call is refunded alone. */
  it('refunds the wallet alone when budgets are disabled', async () => {
    const { service: wallets } = buildWalletService()
    const refund = jest.spyOn(wallets, 'refund')
    const effects = new MeteringEffects(wallets, undefined)

    await effects.withdraw(enforcementFor(effects), true)

    expect(refund).toHaveBeenCalledTimes(1)
  })

  /** A failed compensation is logged and swallowed, so the original error surfaces unmasked. */
  it('logs and swallows a failed refund or release', async () => {
    const { service: wallets } = buildWalletService()
    const { service: budgets } = buildBudgetService()
    jest.spyOn(wallets, 'refund').mockRejectedValueOnce(new Error('wallet down'))
    jest.spyOn(budgets, 'release').mockRejectedValueOnce(new Error('budget down'))
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const effects = new MeteringEffects(wallets, budgets)

    await expect(effects.withdraw(enforcementFor(effects), true)).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to refund a wallet debit while withdrawing'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to release a budget consumption while withdrawing'))
    warn.mockRestore()
  })
})

describe('MeteringEffects.sharesDebit', () => {
  const PAYER = { type: 'user', id: 'u1' } as const

  /** A row shares the debit only when every field of the call shape matches; changing any one field refuses it. */
  it.each([
    { name: 'the same call shape', over: {}, expected: true },
    { name: 'a reversed record, whose debit existed', over: { status: 'reversed' as const }, expected: true },
    { name: 'a pending hold, which reserved its wallet under another key', over: { status: 'pending' as const }, expected: false },
    { name: 'a released hold', over: { status: 'released' as const }, expected: false },
    { name: 'a row that was not enforced', over: { enforced: false }, expected: false },
    { name: 'a system cost', over: { isSystemCost: true }, expected: false },
    { name: 'a row that cost nothing', over: { billedCostNanoUsd: 0n }, expected: false },
    { name: 'a row of another payer', over: { scope: { type: 'user', id: 'u2' } as const }, expected: false },
    { name: 'a row of another scope type', over: { scope: { type: 'tenant', id: 'u1' } as const }, expected: false },
    { name: 'a row of a payer that owns no wallet', over: { scope: { type: 'key', id: 'u1' } as const }, expected: false },
  ])('is $expected for $name', ({ over, expected }) => {
    const { service: wallets } = buildWalletService()
    const effects = new MeteringEffects(wallets, undefined)
    const asked = over.scope?.type === 'key' ? over.scope : PAYER

    expect(effects.sharesDebit(record({ enforced: true, status: 'posted', ...over }), asked)).toBe(expected)
  })

  /** Without the wallet feature no row stands for a wallet debit. */
  it('is false when wallets are disabled', () => {
    expect(new MeteringEffects(undefined, undefined).sharesDebit(record({ enforced: true, status: 'posted' }), PAYER)).toBe(false)
  })
})
