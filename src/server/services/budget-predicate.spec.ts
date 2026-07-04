import type { Budget, UsageRecord } from '../../shared'
import { recordConsumesBudget } from './budget-predicate'

/** A budget whose only relevant field here is its features filter. */
function makeBudget(features?: string[]): Budget {
  return {
    id: 'b1',
    tenantId: 't1',
    scope: { type: 'user', id: 'u1' },
    ...(features !== undefined ? { features } : {}),
    limitNanoUsd: 1_000n,
    window: 'month',
    softThresholds: [0.8, 1],
    policy: 'block',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  }
}

/** A record that consumes the window by default; `over` flips one clause. */
function makeRecord(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    tenantId: 't1',
    scope: { type: 'user', id: 'u1' },
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    feature: 'workout.generate',
    tags: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
    totalTokens: 0,
    priceVersionId: null,
    rawCostNanoUsd: 0n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 0n,
    markupMultiplier: 1,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    idempotencyKey: 'k1',
    isSystemCost: false,
    enforced: true,
    occurredAt: new Date('2026-06-15T00:00:00.000Z'),
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
    ...over,
  }
}

const START = new Date('2026-06-01T00:00:00.000Z')
const END = new Date('2026-07-01T00:00:00.000Z')

describe('recordConsumesBudget (§10.7 predicate)', () => {
  /** The baseline record satisfies all five clauses. */
  it('consumes when every clause holds', () => {
    expect(recordConsumesBudget(makeRecord(), makeBudget(), START, END)).toBe(true)
  })

  /** Clause 1: only enforcement-path records consume. */
  it('excludes non-enforced records', () => {
    expect(recordConsumesBudget(makeRecord({ enforced: false }), makeBudget(), START, END)).toBe(false)
  })

  /** Clause 2: system costs never consume. */
  it('excludes system costs', () => {
    expect(recordConsumesBudget(makeRecord({ isSystemCost: true }), makeBudget(), START, END)).toBe(false)
  })

  /** Clause 3: the feature filter gates consumption; embeddings pass through a scoped budget. */
  it('applies the feature filter', () => {
    expect(recordConsumesBudget(makeRecord(), makeBudget(['workout.generate']), START, END)).toBe(true)
    expect(recordConsumesBudget(makeRecord({ feature: 'embeddings' }), makeBudget(['workout.generate']), START, END)).toBe(false)
    expect(recordConsumesBudget(makeRecord({ feature: 'anything' }), makeBudget([]), START, END)).toBe(true)
  })

  /** Clause 4: only posted or reversed records consume (a reversal nets against its negation). */
  it('applies the status filter', () => {
    expect(recordConsumesBudget(makeRecord({ status: 'reversed' }), makeBudget(), START, END)).toBe(true)
    expect(recordConsumesBudget(makeRecord({ status: 'pending' }), makeBudget(), START, END)).toBe(false)
    expect(recordConsumesBudget(makeRecord({ status: 'released' }), makeBudget(), START, END)).toBe(false)
  })

  /** Clause 5: occurredAt must fall inside the half-open window. */
  it('applies the window bound', () => {
    expect(recordConsumesBudget(makeRecord({ occurredAt: new Date('2026-05-31T23:59:59.000Z') }), makeBudget(), START, END)).toBe(false)
    expect(recordConsumesBudget(makeRecord({ occurredAt: END }), makeBudget(), START, END)).toBe(false)
    expect(recordConsumesBudget(makeRecord({ occurredAt: new Date('2030-01-01T00:00:00.000Z') }), makeBudget(), START, null)).toBe(true)
  })

  /** windowStart is inclusive (>=): a record AT the start timestamp is consumed — kills EQ mutation (>= → >). */
  it('includes a record whose occurredAt equals windowStart', () => {
    expect(recordConsumesBudget(makeRecord({ occurredAt: START }), makeBudget(), START, END)).toBe(true)
  })
})
