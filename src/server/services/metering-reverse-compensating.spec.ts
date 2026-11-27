/**
 * @fileoverview A compensating record given back to `MeteringService` moves nothing: not the wallet,
 * not the budget, not the ledger or its hash chain, and no event is announced.
 * @layer test
 */
import type { AiTokensErrorResponse, NormalizedUsage } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { AiTokensException } from '../errors'
import { BudgetService } from './budget.service'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService, type MeteringEventHooks } from './metering.service'
import { PricingService } from './pricing.service'
import { WalletService } from './wallet.service'

const WALLETS: NonNullable<ResolvedAiTokensOptions['wallets']> = { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' }
const BUDGETS: NonNullable<ResolvedAiTokensOptions['budgets']> = { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true }

const OPTIONS = {
  ratingMode: 'rate-table',
  markup: 1,
  ledger: { hashChain: true },
  pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
  holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
  wallets: WALLETS,
  budgets: BUDGETS,
} as ResolvedAiTokensOptions

const WALLET = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' } as const

const USAGE: NormalizedUsage = {
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
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
}

describe('MeteringService on a compensating record', () => {
  /** `reverse` refuses it, `capture` and `release` do nothing with it: everything stays as the first reversal left it. */
  it('is moved by neither reverse, capture nor release', async () => {
    const ledgerStore = new InMemoryLedgerStore()
    const pricingStore = new InMemoryPricingStore()
    const ledger = new LedgerService(ledgerStore, OPTIONS)
    const wallets = new WalletService(new InMemoryWalletStore(), WALLETS)
    const budgets = new BudgetService(new InMemoryBudgetStore(), ledger, BUDGETS)
    const events: { [K in keyof MeteringEventHooks]: jest.Mock } = {
      usageRecorded: jest.fn(() => Promise.resolve()),
      priceMissing: jest.fn(() => Promise.resolve()),
      holdReleased: jest.fn(() => Promise.resolve()),
      usageReversed: jest.fn(() => Promise.resolve()),
      settleFailed: jest.fn(() => Promise.resolve()),
      audit: jest.fn(() => Promise.resolve()),
    }
    const service = new MeteringService(ledger, new PricingService(OPTIONS, pricingStore), new MarkupResolver(OPTIONS), OPTIONS, events, wallets, budgets)
    await pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
    await wallets.grant(WALLET, { amountNanoUsd: 100_000_000n, idempotencyKey: 'grant', reason: 'seed' })
    await budgets.upsertBudget({ tenantId: 'tenant-1', scope: { type: 'tenant', id: 'tenant-1' }, window: 'month', limitNanoUsd: 1_000_000_000n })
    const original = await service.record({ usage: USAGE, context: { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', enforce: true } })
    const compensating = await service.reverse(original.id, 'first')
    const state = async (): Promise<unknown> => ({
      wallet: await wallets.getBalance(WALLET),
      budgets: await budgets.status('tenant-1', { type: 'user', id: 'u1' }),
      rows: await ledgerStore.query({ tenantId: 'tenant-1' }),
    })
    const before = await state()
    events.usageReversed.mockClear()
    events.audit.mockClear()

    const error = await service.reverse(compensating.id, 'second').catch((e: unknown) => e)
    const caller = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' } } as const
    const asHold = { ...caller, id: compensating.id, estimatedTokens: 0, estimatedCostNanoUsd: 0n, expiresAt: new Date() }
    const captured = await service.capture(asHold, caller, USAGE)
    await service.release(asHold, caller, 'not a hold')

    expect(captured).toStrictEqual(compensating)
    expect(((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
    expect(await state()).toStrictEqual(before)
    expect(events.usageReversed).not.toHaveBeenCalled()
    expect(events.audit).not.toHaveBeenCalled()
    expect(await ledger.verifyChain('tenant-1')).toMatchObject({ valid: true, unchainedCount: 0 })
  })
})
