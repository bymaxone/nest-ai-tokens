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
import type { ApplicationOutcome, BudgetDelta, BudgetKey, BudgetLimits, BudgetReference, BudgetWindowSpend, CommitOutcome, DropOutcome, IBudgetStore } from '@bymax-one/nest-ai-tokens'
import { COMMITTED_REFERENCE } from '../../src/server/utils/budget-references'
import { AiTokensException } from '../../src/server/errors'

/** Construction options for the in-memory budget store. */
export interface InMemoryBudgetStoreOptions {
  /** Injected clock for the expiry filter; defaults to the real wall clock. */
  now?: () => Date
  /**
   * When a budget arrives without a `createdAt`, the store stamps it this many milliseconds AFTER the clock, as a
   * database that rounds a timestamp up does. Defaults to none.
   */
  unstampedCreatedAtOffsetMs?: number
}

/** A Map-backed budget store for unit/contract tests. */
export class InMemoryBudgetStore implements IBudgetStore {
  /** Budgets keyed by id. */
  private readonly budgets = new Map<string, Budget>()
  /** Window spend keyed by `${budgetId}|${windowStartISO}`. */
  private readonly windows = new Map<string, BudgetWindowSpend>()
  /** What each application moved, keyed by application and budget. */
  private readonly applications = new Map<string, { windowStart: Date; delta: BudgetDelta; active: boolean; references: Set<string> }>()
  private readonly now: () => Date
  private readonly unstampedOffsetMs: number

  constructor(options: InMemoryBudgetStoreOptions = {}) {
    this.now = options.now ?? ((): Date => new Date())
    this.unstampedOffsetMs = options.unstampedCreatedAtOffsetMs ?? 0
  }

  /** Compose the window map key. */
  private static applicationKey(application: { key: string; budgetId: string }): string {
    return JSON.stringify([application.key, application.budgetId])
  }

  private static windowKey(budgetId: string, windowStart: Date): string {
    return `${budgetId}|${windowStart.toISOString()}`
  }

  upsert(input: Omit<Budget, 'id' | 'createdAt'> & { id?: string; createdAt?: Date }): Promise<Budget> {
    const existing = input.id === undefined ? undefined : this.budgets.get(input.id)
    if (existing !== undefined && existing.tenantId !== input.tenantId) {
      return Promise.reject(new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'budget id is not available' }))
    }
    const budget: Budget = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? input.createdAt ?? new Date(this.now().getTime() + this.unstampedOffsetMs),
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

  conditionalConsume(budgetId: string, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Promise<boolean> {
    return Promise.resolve(this.tryConsume(budgetId, windowStart, delta, limits))
  }

  adjustWindow(budgetId: string, windowStart: Date, delta: BudgetDelta): Promise<void> {
    this.moveWindow(budgetId, windowStart, delta)
    return Promise.resolve()
  }

  consumeWindowOnce(reference: BudgetReference, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Promise<ApplicationOutcome> {
    // Critical section — synchronous, no await: the application is checked, recorded and referenced in one step.
    const found = this.applications.get(InMemoryBudgetStore.applicationKey(reference))
    if (found?.active === true) return Promise.resolve(this.replayOrMismatch(found, reference, windowStart, delta))
    if (!this.tryConsume(reference.budgetId, windowStart, delta, limits)) return Promise.resolve('refused')
    this.record(reference, windowStart, delta)
    return Promise.resolve('applied')
  }

  adjustWindowOnce(reference: BudgetReference, windowStart: Date, delta: BudgetDelta): Promise<'applied' | 'replayed' | 'mismatch'> {
    const found = this.applications.get(InMemoryBudgetStore.applicationKey(reference))
    if (found?.active === true) return Promise.resolve(this.replayOrMismatch(found, reference, windowStart, delta))
    this.moveWindow(reference.budgetId, windowStart, delta)
    this.record(reference, windowStart, delta)
    return Promise.resolve('applied')
  }

  commitReference(reference: BudgetReference): Promise<CommitOutcome> {
    const found = this.applications.get(InMemoryBudgetStore.applicationKey(reference))
    if (found === undefined) return Promise.resolve('absent')
    if (found.references.has(COMMITTED_REFERENCE)) {
      if (reference.attempt !== COMMITTED_REFERENCE) found.references.delete(reference.attempt)
      return Promise.resolve('already')
    }
    if (!found.references.delete(reference.attempt)) return Promise.resolve('gone')
    found.references.add(COMMITTED_REFERENCE)
    return Promise.resolve('committed')
  }

  dropReference(reference: BudgetReference): Promise<DropOutcome> {
    const found = this.applications.get(InMemoryBudgetStore.applicationKey(reference))
    if (found === undefined) return Promise.resolve('absent')
    if (!found.references.delete(reference.attempt)) return Promise.resolve('missing')
    if (!found.active || found.references.size > 0) return Promise.resolve('kept')
    this.moveWindow(reference.budgetId, found.windowStart, { nanoUsd: -found.delta.nanoUsd, tokens: -found.delta.tokens, count: -found.delta.count })
    found.active = false
    return Promise.resolve('unapplied')
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

  /** Record an application as active and held by the attempt. */
  private record(reference: BudgetReference, windowStart: Date, delta: BudgetDelta): void {
    this.applications.set(InMemoryBudgetStore.applicationKey(reference), { windowStart, delta, active: true, references: new Set([reference.attempt]) })
  }

  /** An active application met again: a replay (the attempt takes a reference) when it moved this window by this delta, else a mismatch. */
  private replayOrMismatch(found: { windowStart: Date; delta: BudgetDelta; references: Set<string> }, reference: BudgetReference, windowStart: Date, delta: BudgetDelta): 'replayed' | 'mismatch' {
    if (found.windowStart.getTime() !== windowStart.getTime() || !sameDelta(found.delta, delta)) return 'mismatch'
    found.references.add(reference.attempt)
    return 'replayed'
  }

  /** The fake's model of the atomic §10.8 multi-dimension conditional UPDATE: every dimension passes or nothing moves. */
  private tryConsume(budgetId: string, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): boolean {
    const window = this.ensureWindow(budgetId, windowStart)
    if (limits.nanoUsd !== undefined && window.spentNanoUsd + delta.nanoUsd > limits.nanoUsd) return false
    if (limits.tokens !== undefined && window.spentTokens + delta.tokens > limits.tokens) return false
    if (limits.count !== undefined && window.spentCount + delta.count > limits.count) return false
    window.spentNanoUsd += delta.nanoUsd
    window.spentTokens += delta.tokens
    window.spentCount += delta.count
    return true
  }

  /** A signed window move, each dimension floored at zero. */
  private moveWindow(budgetId: string, windowStart: Date, delta: BudgetDelta): void {
    const window = this.ensureWindow(budgetId, windowStart)
    window.spentNanoUsd = max0(window.spentNanoUsd + delta.nanoUsd)
    window.spentTokens = Math.max(0, window.spentTokens + delta.tokens)
    window.spentCount = Math.max(0, window.spentCount + delta.count)
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

/** Whether two deltas move every dimension alike. */
function sameDelta(a: BudgetDelta, b: BudgetDelta): boolean {
  return a.nanoUsd === b.nanoUsd && a.tokens === b.tokens && a.count === b.count
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
