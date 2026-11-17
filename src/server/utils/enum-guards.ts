/**
 * @fileoverview The documented values of the options that pick a behaviour, and the guards that test for them. A value that is
 * not documented is refused where it enters, and where a stored value is read a policy that is not documented counts as `block`,
 * so a typo, an old row or a hand edit can never mean "no limit".
 * @layer server
 */

import type { BudgetPolicy, RatingMode } from '../../shared'

/** The budget policies: `block` refuses a call over the limit, `throttle` and `allow` do not. */
export const BUDGET_POLICIES: readonly BudgetPolicy[] = ['block', 'throttle', 'allow']

/** The rating modes: from the price table, or from the cost the provider reported. */
export const RATING_MODES: readonly RatingMode[] = ['rate-table', 'provider-reported']

/** Whether a value is one of the documented budget policies. */
export function isBudgetPolicy(value: unknown): value is BudgetPolicy {
  return BUDGET_POLICIES.some((policy) => policy === value)
}

/** Whether a value is one of the documented rating modes. */
export function isRatingMode(value: unknown): value is RatingMode {
  return RATING_MODES.some((mode) => mode === value)
}

/** The policy a budget is evaluated with: its own when documented, and `block` otherwise, never an absence of limit. */
export function effectivePolicy(policy: unknown): BudgetPolicy {
  return isBudgetPolicy(policy) ? policy : 'block'
}
