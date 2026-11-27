/**
 * @fileoverview A negative amount, the row of a reversal, moves nothing in the wallet from any side effect.
 * @layer test/unit
 */
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { UsageRecord } from '../../shared'
import type { MeteringContext } from '../interfaces'
import { MeteringEffects, type EffectDelta } from './metering-effects'
import { WalletService } from './wallet.service'

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

/** Build a WalletService backed by an in-memory store. */
function buildWalletService(): { service: WalletService } {
  return { service: new WalletService(new InMemoryWalletStore({ now }), { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' }) }
}

describe('MeteringEffects with a negative amount', () => {
  /** A wallet whose debit and refund are watched and do nothing. */
  function watched(): { effects: MeteringEffects; debit: jest.SpyInstance; refund: jest.SpyInstance } {
    const { service } = buildWalletService()
    const debit = jest.spyOn(service, 'debit').mockResolvedValue(undefined as never)
    const refund = jest.spyOn(service, 'refund').mockResolvedValue(undefined as never)
    return { effects: new MeteringEffects(service, undefined), debit, refund }
  }

  const NEGATIVE = -10_000_000n
  const enforcement = { tenantId: 'tenant-1', scope: { type: 'user' as const, id: 'u1' }, feature: 'chat.reply', occurredAt: now(), billedNanoUsd: NEGATIVE, tokens: -1500, key: 'k', attempt: 'a' }

  /** Only a positive amount is owed to a wallet: no path debits or refunds a negative one. */
  it.each<[string, (effects: MeteringEffects) => Promise<unknown>]>([
    ['reserveHold', (effects) => effects.reserveHold(ctx(), delta({ billedNanoUsd: NEGATIVE }), 'k', 'a', now())],
    ['compensateHold', (effects) => effects.compensateHold(ctx(), delta({ billedNanoUsd: NEGATIVE }), 'k', 'a', now())],
    ['restoreHold', (effects) => effects.restoreHold(record({ billedCostNanoUsd: NEGATIVE }))],
    ['restoreOrphanDebit', (effects) => effects.restoreOrphanDebit(record({ billedCostNanoUsd: NEGATIVE, requestId: 'record:k' }))],
    ['reverseEffects', (effects) => effects.reverseEffects(record({ billedCostNanoUsd: NEGATIVE }), 'undo the undo')],
    ['enforce', (effects) => effects.enforce(enforcement)],
    ['withdraw', (effects) => effects.withdraw(enforcement, true)],
  ])('moves nothing in the wallet from %s', async (_path, move) => {
    const { effects, debit, refund } = watched()
    await move(effects)
    expect(debit).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
  })

  /** A row that owes the wallet nothing stands for no debit that another attempt could share. */
  it('shares no debit with a row of a negative amount', () => {
    const { effects } = watched()
    const row = record({ billedCostNanoUsd: NEGATIVE, enforced: true })
    expect(effects.sharesDebit(row, row.scope)).toBe(false)
    expect(effects.sharesHoldDebit(row, row.scope)).toBe(false)
    expect(effects.sharesDebit({ ...row, billedCostNanoUsd: 1n }, row.scope)).toBe(true)
    expect(effects.sharesHoldDebit({ ...row, billedCostNanoUsd: 1n }, row.scope)).toBe(true)
  })
})
