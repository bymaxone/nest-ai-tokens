/**
 * @fileoverview What a budget status says about access: whether a hard budget has no headroom left on a limited dimension.
 * @layer server
 */

import type { BudgetStatus } from '../../shared'

/** Whether a hard (`'block'`) budget has no headroom on a limited dimension. */
export function isHardExhausted(status: BudgetStatus): boolean {
  if (status.policy !== 'block') return false
  if (status.limit.nanoUsd !== undefined && status.spent.nanoUsd >= status.limit.nanoUsd) return true
  if (status.limit.tokens !== undefined && status.spent.tokens >= status.limit.tokens) return true
  return status.limit.count !== undefined && status.spent.count >= status.limit.count
}
