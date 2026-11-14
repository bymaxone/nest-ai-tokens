/**
 * @fileoverview An in-memory {@link IBudgetStore} for tests — a faithful stand-in
 * for the Prisma budget half: CRUD with server-assigned ids, `findMatching` over
 * the exact scope plus the tenant-wide scope (excluding expired budgets), an atomic
 * multi-dimension `conditionalConsume` that moves all three dimensions or none (the
 * fake's model of the §10.8 conditional UPDATE), signed `adjustWindow` floored at
 * zero, and window read/reset. Money is bigint nano-USD; token/count dimensions are
 * plain numbers. Lives under `test/` so it is not collected for coverage.
 * @layer test
 */

import { randomUUID } from 'node:crypto'
import type { Budget, MeteringScope } from '@bymax-one/nest-ai-tokens/shared'
import type { BudgetDelta, BudgetKey, BudgetLimits, BudgetWindowSpend, IBudgetStore } from '@bymax-one/nest-ai-tokens'
import { AiTokensException } from '../../src/server/errors'

/** Construction options for the in-memory budget store. */
export interface InMemoryBudgetStoreOptions {
  /** Injected clock for the expiry filter; defaults to the real wall clock. */
  now?: () => Date
}

/** A Map-backed budget store for unit/contract tests. */
export class InMemoryBudgetStore implements IBudgetStore {
  /** Budgets keyed by id. */
  private readonly budgets = new Map<string, Budget>()
  /** Window spend keyed by `${budgetId}|${windowStartISO}`. */
  private readonly windows = new Map<string, BudgetWindowSpend>()
  private readonly now: () => Date

  constructor(options: InMemoryBudgetStoreOptions = {}) {
    this.now = options.now ?? ((): Date => new Date())
  }

  /** Compose the window map key. */
  private static windowKey(budgetId: string, windowStart: Date): string {
    return `${budgetId}|${windowStart.toISOString()}`
  }

  upsert(input: Omit<Budget, 'id' | 'createdAt'> & { id?: string }): Promise<Budget> {
    const existing = input.id === undefined ? undefined : this.budgets.get(input.id)
    if (existing !== undefined && existing.tenantId !== input.tenantId) {
      return Promise.reject(new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'budget id is not available' }))
    }
    const budget: Budget = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? this.now(),
    }
    this.budgets.set(budget.id, budget)
    return Promise.resolve({ ...budget })
  }

  remove(key: BudgetKey): Promise<void> {
    if (this.budgets.get(key.id)?.tenantId === key.tenantId) this.budgets.delete(key.id)
    return Promise.resolve()
  }

  findBudgetById(key: BudgetKey): Promise<Budget | null> {
    const budget = this.budgets.get(key.id)
    return Promise.resolve(budget === undefined || budget.tenantId !== key.tenantId ? null : { ...budget })
  }

  findMatching(tenantId: string, scope: MeteringScope): Promise<Budget[]> {
    const now = this.now()
    const matched = [...this.budgets.values()].filter((budget) => {
      if (budget.tenantId !== tenantId) return false
      if (budget.expiresAt !== undefined && budget.expiresAt <= now) return false
      return isTenantWide(budget.scope) || isExactScope(budget.scope, scope)
    })
    return Promise.resolve(matched.map((budget) => ({ ...budget })))
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async only so the atomic body below returns a settled promise; there is no await inside the critical section.
  async conditionalConsume(
    budgetId: string,
    windowStart: Date,
    delta: BudgetDelta,
    limits: BudgetLimits,
  ): Promise<boolean> {
    // Critical section — synchronous, no await: the fake's model of the atomic §10.8
    // multi-dimension conditional UPDATE. Every dimension passes or nothing moves.
    const window = this.ensureWindow(budgetId, windowStart)
    if (limits.nanoUsd !== undefined && window.spentNanoUsd + delta.nanoUsd > limits.nanoUsd) return false
    if (limits.tokens !== undefined && window.spentTokens + delta.tokens > limits.tokens) return false
    if (limits.count !== undefined && window.spentCount + delta.count > limits.count) return false
    window.spentNanoUsd += delta.nanoUsd
    window.spentTokens += delta.tokens
    window.spentCount += delta.count
    return true
  }

  adjustWindow(budgetId: string, windowStart: Date, delta: BudgetDelta): Promise<void> {
    const window = this.ensureWindow(budgetId, windowStart)
    window.spentNanoUsd = max0(window.spentNanoUsd + delta.nanoUsd)
    window.spentTokens = Math.max(0, window.spentTokens + delta.tokens)
    window.spentCount = Math.max(0, window.spentCount + delta.count)
    return Promise.resolve()
  }

  getWindow(budgetId: string, windowStart: Date): Promise<BudgetWindowSpend | null> {
    const window = this.windows.get(InMemoryBudgetStore.windowKey(budgetId, windowStart))
    return Promise.resolve(window === undefined ? null : { ...window })
  }

  setWindowStart(key: BudgetKey, windowStart: Date): Promise<void> {
    if (this.budgets.get(key.id)?.tenantId !== key.tenantId) return Promise.resolve()
    this.windows.set(InMemoryBudgetStore.windowKey(key.id, windowStart), {
      spentNanoUsd: 0n,
      spentTokens: 0,
      spentCount: 0,
    })
    return Promise.resolve()
  }

  /** Test helper — create or replace a budget WITHOUT the tenant check, as a tenant-blind store would. */
  upsertAnyTenant(input: Omit<Budget, 'id' | 'createdAt'> & { id?: string }): Promise<Budget> {
    const existing = input.id === undefined ? undefined : this.budgets.get(input.id)
    const budget: Budget = { ...input, id: input.id ?? randomUUID(), createdAt: existing?.createdAt ?? this.now() }
    this.budgets.set(budget.id, budget)
    return Promise.resolve({ ...budget })
  }

  /** Test helper — the tenants that own `budgetId` (zero or one), for a store double that ignores the tenant. */
  tenantsOf(budgetId: string): string[] {
    const budget = this.budgets.get(budgetId)
    return budget === undefined ? [] : [budget.tenantId]
  }

  /** Test helper — every budget matching the scope across ALL tenants, as a tenant-blind store would answer. */
  findMatchingAnyTenant(scope: MeteringScope): Promise<Budget[]> {
    return Promise.resolve(
      [...this.budgets.values()].filter((budget) => isTenantWide(budget.scope) || isExactScope(budget.scope, scope)).map((budget) => ({ ...budget })),
    )
  }

  /** Test helper — force a window's spend counters (drift injection for reconcile). */
  forceWindow(budgetId: string, windowStart: Date, spend: BudgetWindowSpend): void {
    this.windows.set(InMemoryBudgetStore.windowKey(budgetId, windowStart), { ...spend })
  }

  /** Fetch or create (zeroed) the window row for first-touch consumption. */
  private ensureWindow(budgetId: string, windowStart: Date): BudgetWindowSpend {
    const key = InMemoryBudgetStore.windowKey(budgetId, windowStart)
    let window = this.windows.get(key)
    if (window === undefined) {
      window = { spentNanoUsd: 0n, spentTokens: 0, spentCount: 0 }
      this.windows.set(key, window)
    }
    return window
  }
}

/** Whether a budget is scoped tenant-wide (matches every subject in the tenant). */
function isTenantWide(scope: MeteringScope): boolean {
  return scope.type === 'tenant'
}

/** Structural equality of two scopes. */
function isExactScope(a: MeteringScope, b: MeteringScope): boolean {
  return a.type === b.type && a.id === b.id
}

/** Floor a bigint at zero. */
function max0(value: bigint): bigint {
  return value < 0n ? 0n : value
}
