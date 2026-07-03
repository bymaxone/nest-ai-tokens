import type { UsageRecord, WalletRef } from '../../shared'
import type { EventDispatcher } from './event-dispatcher'
import {
  createBudgetEventHooks,
  createLedgerAuditHook,
  createMeteringEventHooks,
  createWalletEventHooks,
} from './event-hooks'

/** Build a complete settled `UsageRecord`. */
function makeRecord(over: Partial<UsageRecord> = {}): UsageRecord {
  const now = new Date('2026-06-01T00:00:00.000Z')
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
    rawCostNanoUsd: 6_250_000n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 25_000_000n,
    markupMultiplier: 4,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    idempotencyKey: 'key-1',
    isSystemCost: false,
    enforced: false,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

describe('createMeteringEventHooks', () => {
  /** usageRecorded maps the record to the documented usage.recorded payload. */
  it('emits usage.recorded with the documented payload', async () => {
    const emit = jest.fn(() => Promise.resolve())
    const hooks = createMeteringEventHooks({ emit } as unknown as EventDispatcher)
    const record = makeRecord()
    await hooks.usageRecorded(record)
    expect(emit).toHaveBeenCalledWith('ai_tokens.usage.recorded', 'tenant-1', record.scope, {
      usageRecordId: 'rec-1',
      feature: 'chat.reply',
      provider: 'openai',
      model: 'gpt-5',
      serviceTier: 'standard',
      totalTokens: 1500,
      rawCostNanoUsd: 6_250_000n,
      billedCostNanoUsd: 25_000_000n,
      enforced: false,
      isSystemCost: false,
    })
  })

  /** priceMissing maps the record to the documented price.missing payload. */
  it('emits price.missing with the documented payload', async () => {
    const emit = jest.fn(() => Promise.resolve())
    const hooks = createMeteringEventHooks({ emit } as unknown as EventDispatcher)
    await hooks.priceMissing(makeRecord({ id: 'rec-9', priceMissing: true }))
    expect(emit).toHaveBeenCalledWith('ai_tokens.price.missing', 'tenant-1', expect.anything(), {
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      serviceTier: 'standard',
      usageRecordId: 'rec-9',
    })
  })
})

describe('createLedgerAuditHook', () => {
  /** The audit hook forwards the action + details to the dispatcher. */
  it('forwards a chain-verification audit', () => {
    const audit = jest.fn(() => Promise.resolve())
    createLedgerAuditHook({ audit } as unknown as EventDispatcher)('ai_tokens.chain.verified', {
      tenantId: 't1',
      valid: true,
    })
    expect(audit).toHaveBeenCalledWith('ai_tokens.chain.verified', { tenantId: 't1', valid: true })
  })
})

const WALLET_REF: WalletRef = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }

describe('createWalletEventHooks', () => {
  /** granted/depleted map the wallet ref to its scope and forward to the dispatcher; audit passes through. */
  it('fans wallet events through the dispatcher', async () => {
    const emit = jest.fn(() => Promise.resolve())
    const audit = jest.fn(() => Promise.resolve())
    const hooks = createWalletEventHooks({ emit, audit } as unknown as EventDispatcher)
    await hooks.granted(WALLET_REF, { walletId: 'w1', entryId: 'e1', amountNanoUsd: 100n })
    await hooks.depleted(WALLET_REF, { walletId: 'w1', balanceNanoUsd: 0n })
    await hooks.audit('ai_tokens.wallet.granted', { tenantId: 'tenant-1' })
    expect(emit).toHaveBeenCalledWith('ai_tokens.wallet.granted', 'tenant-1', { type: 'user', id: 'u1' }, { walletId: 'w1', entryId: 'e1', amountNanoUsd: 100n })
    expect(emit).toHaveBeenCalledWith('ai_tokens.wallet.depleted', 'tenant-1', { type: 'user', id: 'u1' }, { walletId: 'w1', balanceNanoUsd: 0n })
    expect(audit).toHaveBeenCalledWith('ai_tokens.wallet.granted', { tenantId: 'tenant-1' })
  })
})

describe('createBudgetEventHooks', () => {
  /** threshold/exceeded/projected forward to the dispatcher under their event types; audit passes through. */
  it('fans budget events through the dispatcher', async () => {
    const emit = jest.fn(() => Promise.resolve())
    const audit = jest.fn(() => Promise.resolve())
    const hooks = createBudgetEventHooks({ emit, audit } as unknown as EventDispatcher)
    const scope = { type: 'user', id: 'u1' } as const
    await hooks.thresholdCrossed('tenant-1', scope, { budgetId: 'b1', threshold: 0.8, usedFraction: 0.8, limit: {}, spent: {}, remaining: {}, resetsAt: null })
    await hooks.exceeded('tenant-1', scope, { budgetId: 'b1', policy: 'block', dimension: 'cost', limit: {}, spent: {}, resetsAt: null })
    await hooks.projectedExceeded('tenant-1', scope, { budgetId: 'b1', projectedAt: new Date('2026-07-01T00:00:00.000Z'), usedFraction: 0.9, resetsAt: null })
    await hooks.audit('ai_tokens.budget.upserted', { tenantId: 'tenant-1' })
    expect(emit).toHaveBeenCalledWith('ai_tokens.budget.threshold_crossed', 'tenant-1', scope, expect.objectContaining({ budgetId: 'b1', threshold: 0.8 }))
    expect(emit).toHaveBeenCalledWith('ai_tokens.budget.exceeded', 'tenant-1', scope, expect.objectContaining({ dimension: 'cost' }))
    expect(emit).toHaveBeenCalledWith('ai_tokens.budget.projected_exceeded', 'tenant-1', scope, expect.objectContaining({ budgetId: 'b1' }))
    expect(audit).toHaveBeenCalledWith('ai_tokens.budget.upserted', { tenantId: 'tenant-1' })
  })
})
