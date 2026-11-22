/**
 * @fileoverview The event hooks `BudgetService` fires, and the no-op hooks it uses until the event dispatcher is wired.
 * @layer server
 */

import type { BudgetExceededEventData, BudgetProjectedExceededEventData, BudgetThresholdCrossedEventData, MeteringScope } from '../../shared'

/** The event hooks `BudgetService` fires; the module wires them to the dispatcher. */
export interface BudgetEventHooks {
  thresholdCrossed(tenantId: string, scope: MeteringScope, data: BudgetThresholdCrossedEventData): void | Promise<void>
  exceeded(tenantId: string, scope: MeteringScope, data: BudgetExceededEventData): void | Promise<void>
  projectedExceeded(tenantId: string, scope: MeteringScope, data: BudgetProjectedExceededEventData): void | Promise<void>
  audit(action: string, details: Record<string, unknown>): void | Promise<void>
}

/** The no-op hooks used until the event dispatcher is wired. */
export const NOOP_BUDGET_HOOKS: BudgetEventHooks = {
  thresholdCrossed: (): void => undefined,
  exceeded: (): void => undefined,
  projectedExceeded: (): void => undefined,
  audit: (): void => undefined,
}
