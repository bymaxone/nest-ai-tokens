/**
 * @fileoverview The pure arithmetic and snapshots of the budget service: spend deltas, the failing dimension of a
 * window, the used fraction, and the status of a budget. No state and no I/O. Internal — not part of the public barrel.
 * @layer server
 */

import type { Budget, BudgetStatus } from '../../shared'
import type { BudgetDelta, BudgetLimits, BudgetWindowSpend } from '../interfaces'
import type { CounterDimensionName } from './budget.keys'

/** A budget dimension over its limit, carrying the typed §16 block code (spend → 402, tokens/count → 429). */
export interface FailingDimension {
  dimension: CounterDimensionName
  code: 'AI_TOKENS_BUDGET_EXCEEDED' | 'AI_TOKENS_QUOTA_EXCEEDED'
}

/** Whether a record's feature matches a budget's features filter (empty/absent = all). */
export function featureMatches(features: string[] | undefined, feature: string): boolean {
  return features === undefined || features.length === 0 || features.includes(feature)
}

/** The limits object for a budget (only defined dimensions). */
export function limitsOf(budget: Budget): BudgetLimits {
  return {
    // Stryker disable next-line ConditionalExpression: CE true: spreading { nanoUsd: undefined } is equivalent to {} because all consumers check limits.nanoUsd !== undefined
    ...(budget.limitNanoUsd !== undefined ? { nanoUsd: budget.limitNanoUsd } : {}),
    // Stryker disable next-line ConditionalExpression: CE true: spreading { tokens: undefined } is equivalent to {} because all consumers check limits.tokens !== undefined
    ...(budget.limitTokens !== undefined ? { tokens: budget.limitTokens } : {}),
    // Stryker disable next-line ConditionalExpression: CE true: spreading { count: undefined } is equivalent to {} because all consumers check limits.count !== undefined
    ...(budget.limitCount !== undefined ? { count: budget.limitCount } : {}),
  }
}

/** Negate a delta across all three dimensions. */
export function negate(delta: BudgetDelta): BudgetDelta {
  return { nanoUsd: -delta.nanoUsd, tokens: -delta.tokens, count: -delta.count }
}

/** Add a delta to a window's spend (non-mutating). */
export function addSpend(spend: BudgetWindowSpend, delta: BudgetDelta): BudgetWindowSpend {
  return {
    spentNanoUsd: spend.spentNanoUsd + delta.nanoUsd,
    spentTokens: spend.spentTokens + delta.tokens,
    spentCount: spend.spentCount + delta.count,
  }
}

/** Map a limited budget/counter dimension to its typed §16 block code: spend → 402, tokens/count → 429. */
export function dimensionCode(name: CounterDimensionName): FailingDimension {
  return name === 'cost' ? { dimension: 'cost', code: 'AI_TOKENS_BUDGET_EXCEEDED' } : { dimension: name, code: 'AI_TOKENS_QUOTA_EXCEEDED' }
}

/** The first dimension whose spend exceeds its limit, with the typed error code (spend fallback). */
export function failingDimension(spend: BudgetWindowSpend, limits: BudgetLimits): FailingDimension {
  return failingDimensionOrNull(spend, limits) ?? dimensionCode('cost')
}

/** The first over-limit dimension, or `null` when every dimension is within its limit. */
export function failingDimensionOrNull(spend: BudgetWindowSpend, limits: BudgetLimits): FailingDimension | null {
  if (limits.nanoUsd !== undefined && spend.spentNanoUsd > limits.nanoUsd) return dimensionCode('cost')
  if (limits.tokens !== undefined && spend.spentTokens > limits.tokens) return dimensionCode('tokens')
  if (limits.count !== undefined && spend.spentCount > limits.count) return dimensionCode('count')
  return null
}

/** Fixed-point scale for the used fraction (six decimal digits) — see {@link ratio}. */
const USED_FRACTION_SCALE = 1_000_000n

/** The maximum used fraction across the limited dimensions (bounded float; 0 when unlimited). */
export function usedFraction(spend: BudgetWindowSpend, limits: BudgetLimits): number {
  const fractions: number[] = []
  if (limits.nanoUsd !== undefined) fractions.push(ratio(spend.spentNanoUsd, limits.nanoUsd))
  if (limits.tokens !== undefined) fractions.push(ratio(BigInt(spend.spentTokens), BigInt(limits.tokens)))
  if (limits.count !== undefined) fractions.push(ratio(BigInt(spend.spentCount), BigInt(limits.count)))
  return fractions.length === 0 ? 0 : Math.max(...fractions)
}

/**
 * The used fraction of one dimension, computed with bigint math so nano-USD spend/limits
 * above `Number.MAX_SAFE_INTEGER` never lose precision — a raw `Number()` on either
 * operand would round and could report a full or over-limit budget as under (or vice
 * versa), corrupting thresholds, projection, and `status.usedFraction`. Scales by a fixed
 * factor, divides as bigint, then converts the small scaled quotient to a float. A zero
 * limit is a hard block (§10.2) — fully used at zero spend, over beyond it.
 */
export function ratio(spent: bigint, limit: bigint): number {
  if (limit === 0n) return spent > 0n ? Number.POSITIVE_INFINITY : 1
  return Number((spent * USED_FRACTION_SCALE) / limit) / Number(USED_FRACTION_SCALE)
}

/** The limit snapshot (present dimensions only) for an event payload. */
export function limitSnapshot(limits: BudgetLimits): { nanoUsd?: bigint; tokens?: number; count?: number } {
  return {
    // Stryker disable next-line ConditionalExpression: CE true: spreading { nanoUsd: undefined } is equivalent to {} for event consumers who check field !== undefined
    ...(limits.nanoUsd !== undefined ? { nanoUsd: limits.nanoUsd } : {}),
    // Stryker disable next-line ConditionalExpression: CE true: spreading { tokens: undefined } is equivalent to {} for event consumers who check field !== undefined
    ...(limits.tokens !== undefined ? { tokens: limits.tokens } : {}),
    // Stryker disable next-line ConditionalExpression: CE true: spreading { count: undefined } is equivalent to {} for event consumers who check field !== undefined
    ...(limits.count !== undefined ? { count: limits.count } : {}),
  }
}

/** The spend snapshot (all three dimensions) for an event payload. */
export function spendSnapshot(spend: BudgetWindowSpend): { nanoUsd: bigint; tokens: number; count: number } {
  return { nanoUsd: spend.spentNanoUsd, tokens: spend.spentTokens, count: spend.spentCount }
}

/** The remaining snapshot (limited dimensions only, floored at zero) for an event payload. */
export function remainingSnapshot(limits: BudgetLimits, spend: BudgetWindowSpend): { nanoUsd?: bigint; tokens?: number; count?: number } {
  return {
    // Stryker disable next-line ConditionalExpression: CE true: spreading { nanoUsd: undefined } is equivalent to {} for event consumers who check field !== undefined
    ...(limits.nanoUsd !== undefined ? { nanoUsd: max0(limits.nanoUsd - spend.spentNanoUsd) } : {}),
    // Stryker disable next-line ConditionalExpression: CE true: spreading { tokens: undefined } is equivalent to {} for event consumers who check field !== undefined
    ...(limits.tokens !== undefined ? { tokens: Math.max(0, limits.tokens - spend.spentTokens) } : {}),
    // Stryker disable next-line ConditionalExpression: CE true: spreading { count: undefined } is equivalent to {} for event consumers who check field !== undefined
    ...(limits.count !== undefined ? { count: Math.max(0, limits.count - spend.spentCount) } : {}),
  }
}

/** Assemble a {@link BudgetStatus} from a budget and its located window (§10.6). */
export function buildStatus(budget: Budget, windowStart: Date, resetsAt: Date | null, spend: BudgetWindowSpend): BudgetStatus {
  const limits = limitsOf(budget)
  return {
    budgetId: budget.id,
    // Stryker disable next-line ConditionalExpression: CE true: spreading { features: undefined } is equivalent to {} because status consumers check features !== undefined
    ...(budget.features !== undefined ? { features: budget.features } : {}),
    window: budget.window,
    windowStart,
    resetsAt,
    policy: budget.policy,
    limit: limitSnapshot(limits),
    spent: spendSnapshot(spend),
    remaining: remainingSnapshot(limits, spend),
    usedFraction: usedFraction(spend, limits),
  }
}

/** Floor a bigint at zero. */
export function max0(value: bigint): bigint {
  // Stryker disable next-line EqualityOperator: value <= 0n: when value = 0n, both branches yield 0n (equivalent); distinguishable only for value = 0n case which produces the same output
  return value < 0n ? 0n : value
}
