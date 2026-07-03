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
import type { BudgetDelta, BudgetLimits, BudgetWindowSpend, IBudgetStore } from '@bymax-one/nest-ai-tokens'

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
    const budget: Budget = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? this.now(),
    }
    this.budgets.set(budget.id, budget)
    return Promise.resolve({ ...budget })
  }

  remove(budgetId: string): Promise<void> {
    this.budgets.delete(budgetId)
    return Promise.resolve()
  }

  findBudgetById(budgetId: string): Promise<Budget | null> {
    const budget = this.budgets.get(budgetId)
    return Promise.resolve(budget === undefined ? null : { ...budget })
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

  setWindowStart(budgetId: string, windowStart: Date): Promise<void> {
    this.windows.set(InMemoryBudgetStore.windowKey(budgetId, windowStart), {
      spentNanoUsd: 0n,
      spentTokens: 0,
      spentCount: 0,
    })
    return Promise.resolve()
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
