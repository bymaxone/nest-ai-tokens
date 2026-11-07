/**
 * @fileoverview The window kinds a budget may carry. The window math (`window-anchor`) reads only the kinds
 * of `BudgetWindowKind`, and a custom length has to give a valid date when added to a window start, so a budget
 * is checked against both before it is stored.
 * @layer server
 */

import { AiTokensException } from '../errors'

/** The longest custom window, in seconds: 100 years, far inside the range of a date. */
export const MAX_CUSTOM_SECONDS = 3_153_600_000

/**
 * Refuse a window kind the window math cannot read: one outside `BudgetWindowKind`, or a custom length that is
 * not a positive whole number of seconds up to {@link MAX_CUSTOM_SECONDS}.
 *
 * @param window The window value of a budget definition, unchecked input.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the value is not a supported window kind.
 */
export function assertWindowKind(window: unknown): void {
  if (window === 'day' || window === 'week' || window === 'month' || window === 'total') return
  const seconds = typeof window === 'object' && window !== null ? (window as { customSeconds?: unknown }).customSeconds : undefined
  if (typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_CUSTOM_SECONDS) return
  // Stryker disable next-line ObjectLiteral: error context is internal diagnostics; tests check error code only
  throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
    // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
    reason: "window must be 'day', 'week', 'month', 'total' or { customSeconds } with a positive whole number of seconds up to 3153600000 (100 years)",
  })
}
