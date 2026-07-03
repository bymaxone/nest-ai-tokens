/**
 * @fileoverview Pure budget-window anchoring math (spec §10.1/§10.3). A budget's
 * window either anchors to CALENDAR UTC (no `anchorAt`: day = midnight UTC, week =
 * Sunday 00:00 UTC, month = the 1st 00:00 UTC) or to a per-subject `anchorAt`
 * instant that repeats every window with MONTH-END CLAMPING — a Jan 31 monthly
 * anchor yields Feb 28/29, Mar 31, … — which is how subscription-renewal quotas are
 * expressed. `'total'` never rotates (`resetsAt` is `null`); `{ customSeconds }` is
 * a fixed-length rolling window epoch-aligned to `anchorAt ?? createdAt`. These are
 * pure functions of an explicit `at`; the service injects its clock. Everything is
 * computed in UTC.
 * @layer server
 */

import type { Budget } from '../../shared'

/** The budget fields the anchoring math reads. */
export type WindowAnchorBudget = Pick<Budget, 'window' | 'anchorAt' | 'createdAt'>

/** A fixed-length (non-calendar-month) window kind. */
type FixedWindow = 'day' | 'week' | { customSeconds: number }

/** Milliseconds in one day. */
const DAY_MS = 86_400_000
/** Milliseconds in one week. */
const WEEK_MS = DAY_MS * 7

/** Start of the UTC day containing `at`. */
function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** Start of the UTC week (Sunday 00:00 UTC) containing `at`. */
function startOfUtcWeek(at: Date): Date {
  const day = startOfUtcDay(at)
  return new Date(day.getTime() - day.getUTCDay() * DAY_MS)
}

/** Start of the UTC month (1st 00:00 UTC) containing `at`. */
function startOfUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
}

/** Days in a UTC month (a 0-based month index that may over/underflow the year). */
function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** Add `months` to an anchor, clamping the day of month to the target month's length. */
function addMonthsClamped(anchor: Date, months: number): Date {
  const targetIndex = anchor.getUTCMonth() + months
  const year = anchor.getUTCFullYear() + Math.floor(targetIndex / 12)
  const month = ((targetIndex % 12) + 12) % 12
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, month))
  return new Date(
    Date.UTC(year, month, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()),
  )
}

/** Whole-month count from `anchor` to a same-anchored `windowStart`. */
function monthsBetween(anchor: Date, windowStart: Date): number {
  return (windowStart.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (windowStart.getUTCMonth() - anchor.getUTCMonth())
}

/** The month index `k` such that `addMonthsClamped(anchor, k)` is the window containing `at`. */
function anchoredMonthIndex(anchor: Date, at: Date): number {
  const estimate = monthsBetween(anchor, at)
  return addMonthsClamped(anchor, estimate).getTime() <= at.getTime() ? estimate : estimate - 1
}

/** The fixed period (ms) of a `'day'`/`'week'`/custom window. */
function periodMsOf(window: FixedWindow): number {
  if (window === 'day') return DAY_MS
  if (window === 'week') return WEEK_MS
  return window.customSeconds * 1_000
}

/** The epoch-aligned start of a fixed-length window containing `at`, anchored at `anchor`. */
function fixedWindowStart(anchor: Date, periodMs: number, at: Date): Date {
  const k = Math.floor((at.getTime() - anchor.getTime()) / periodMs)
  return new Date(anchor.getTime() + k * periodMs)
}

/**
 * The start of the window that contains `at` for a budget.
 *
 * @param budget The window kind, optional anchor, and creation instant.
 * @param at The instant to locate (typically the injected clock's now).
 * @returns The window's start instant (UTC).
 */
export function windowStartFor(budget: WindowAnchorBudget, at: Date): Date {
  if (budget.window === 'total') return new Date((budget.anchorAt ?? budget.createdAt).getTime())
  if (budget.window === 'month') {
    if (budget.anchorAt === undefined) return startOfUtcMonth(at)
    return addMonthsClamped(budget.anchorAt, anchoredMonthIndex(budget.anchorAt, at))
  }
  if (budget.anchorAt !== undefined) return fixedWindowStart(budget.anchorAt, periodMsOf(budget.window), at)
  if (budget.window === 'day') return startOfUtcDay(at)
  if (budget.window === 'week') return startOfUtcWeek(at)
  return fixedWindowStart(budget.createdAt, periodMsOf(budget.window), at)
}

/**
 * The instant a window resets (its exclusive upper bound), or `null` for `'total'`.
 *
 * @param budget The window kind, optional anchor, and creation instant.
 * @param windowStart A start produced by {@link windowStartFor} for the same budget.
 * @returns The reset instant, or `null` when the window never rotates.
 */
export function resetsAtFor(budget: WindowAnchorBudget, windowStart: Date): Date | null {
  if (budget.window === 'total') return null
  if (budget.window === 'month') {
    if (budget.anchorAt === undefined) {
      return new Date(Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + 1, 1))
    }
    return addMonthsClamped(budget.anchorAt, monthsBetween(budget.anchorAt, windowStart) + 1)
  }
  return new Date(windowStart.getTime() + periodMsOf(budget.window))
}
