/**
 * @fileoverview The single construction of a `BudgetService` under test, plus the
 * inputs and assertions its specs share.
 *
 * Every budget spec builds its subject from here. A spec that assembles its own
 * service can diverge from the others in the options it passes — the clock, the
 * counter store, the event hooks — and then agree with them about behaviour that
 * differs. Add a factory here rather than in one spec.
 * @layer test
 */

import type {
  AiTokensErrorResponse,
  BudgetExceededEventData,
  BudgetProjectedExceededEventData,
  BudgetThresholdCrossedEventData,
  MeteringScope,
  NewUsageRecord,
} from '../../src/shared'
import type { MeteringContext } from '../../src/server/interfaces'
import { AiTokensException } from '../../src/server/errors'
import { LedgerService } from '../../src/server/services/ledger.service'
import { BudgetService, type BudgetEventHooks, type BudgetServiceOptions, type UpsertBudgetInput } from '../../src/server/services/budget.service'
import { InMemoryBudgetStore } from './in-memory-budget-store'
import { InMemoryLedgerStore } from './in-memory-ledger-store'

export const TENANT = 't1'
export const USER_SCOPE: MeteringScope = { type: 'user', id: 'u1' }
export const NOW = new Date('2026-06-15T00:00:00.000Z')

/** Read the typed error code from a thrown `AiTokensException`. */
export function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** Assert a promise rejects with a specific `AiTokensException` code. */
export async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AiTokensException)
  expect(codeOf(thrown)).toBe(code)
}

/** A metering context (trusted input). */
export function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: TENANT, scope: USER_SCOPE, feature: 'workout.generate', ...over }
}

/** A budget upsert input scoped to the user with a cost limit; explicit `undefined` overrides drop the key. */
export function budgetInput(over: { [K in keyof UpsertBudgetInput]?: UpsertBudgetInput[K] | undefined } = {}): UpsertBudgetInput {
  const merged: Record<string, unknown> = { tenantId: TENANT, scope: USER_SCOPE, limitNanoUsd: 100n, window: 'month', ...over }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as UpsertBudgetInput
}

/** A recording budget event-hooks double. */
export function recordingHooks(): {
  hooks: BudgetEventHooks
  thresholds: BudgetThresholdCrossedEventData[]
  exceeded: BudgetExceededEventData[]
  projected: BudgetProjectedExceededEventData[]
  audits: string[]
} {
  const thresholds: BudgetThresholdCrossedEventData[] = []
  const exceeded: BudgetExceededEventData[] = []
  const projected: BudgetProjectedExceededEventData[] = []
  const audits: string[] = []
  return {
    thresholds,
    exceeded,
    projected,
    audits,
    hooks: {
      thresholdCrossed: (_t, _s, data): void => void thresholds.push(data),
      exceeded: (_t, _s, data): void => void exceeded.push(data),
      projectedExceeded: (_t, _s, data): void => void projected.push(data),
      audit: (action): void => void audits.push(action),
    },
  }
}

/** A fresh service over in-memory fakes with an injected clock. */
export function makeService(over: { options?: Partial<BudgetServiceOptions>; now?: () => Date } = {}): {
  service: BudgetService
  store: InMemoryBudgetStore
  ledgerStore: InMemoryLedgerStore
  thresholds: BudgetThresholdCrossedEventData[]
  exceeded: BudgetExceededEventData[]
  projected: BudgetProjectedExceededEventData[]
  audits: string[]
} {
  const now = over.now ?? ((): Date => NOW)
  const store = new InMemoryBudgetStore({ now })
  const ledgerStore = new InMemoryLedgerStore()
  const ledger = new LedgerService(ledgerStore)
  const rec = recordingHooks()
  const options: BudgetServiceOptions = {
    enabled: true,
    defaultPolicy: 'block',
    alertThresholds: [0.8, 1],
    failClosed: true,
    ...over.options,
  }
  const service = new BudgetService(store, ledger, options, now, rec.hooks)
  return { service, store, ledgerStore, ...rec }
}

/** Build a full usage record for ledger seeding. */
export function usageRecord(over: Partial<NewUsageRecord> = {}): NewUsageRecord {
  return {
    tenantId: TENANT,
    scope: USER_SCOPE,
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    feature: 'workout.generate',
    tags: [],
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    imageInTokens: 0,
    imageOutTokens: 0,
    totalTokens: 100,
    priceVersionId: null,
    rawCostNanoUsd: 0n,
    surchargeNanoUsd: 0n,
    billedCostNanoUsd: 25n,
    markupMultiplier: 1,
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    idempotencyKey: 'seed',
    isSystemCost: false,
    enforced: true,
    occurredAt: new Date('2026-06-10T00:00:00.000Z'),
    ...over,
  }
}

