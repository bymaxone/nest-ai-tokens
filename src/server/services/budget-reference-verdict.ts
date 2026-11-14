/**
 * @fileoverview The verdict of the budget-reference sweep. A reference an attempt left behind holds a budget movement
 * that nothing releases; the sweep looks at the ledger row under the reference's key and decides whether the movement
 * belongs to that row (keep it, under the committed name) or to nobody (give it back). The decision is a pure function of
 * the reference's kind and name, the state of the row, and whether the row is the same call; the surrounding code only
 * gathers those inputs and applies the result.
 * @layer server
 */

import type { Budget, UsageRecord, UsageStatus } from '../../shared'
import type { BudgetDelta, StaleReference } from '../interfaces'
import { CAPTURE_KEY_PREFIX, COMMITTED_REFERENCE, RECORD_KEY_PREFIX, RELEASE_KEY_PREFIX, RESERVE_KEY_PREFIX, REVERSE_KEY_PREFIX } from '../utils/budget-references'
import { sameScope } from '../utils/scope-wallet'
import { windowStartFor } from '../utils/window-anchor'
import { featureMatches } from './budget-math'
import { sumTokens } from './ledger.service'

/** What a reference's key says it belongs to: a hold's reservation or an enforced record's consumption. */
export type ReferenceKind = 'reserve' | 'record'

/** Whether a reference is the committed one (`row`) or was named by an attempt. */
export type ReferenceName = 'attempt' | 'row'

/** The ledger row under a reference's key: none, or its status. */
export type RowState = 'none' | 'pending' | 'posted' | 'reversed' | 'released'

/** What the sweep does with a reference: give it back, rename it to `row`, or leave it. */
export type ReferenceVerdict = 'drop' | 'commit' | 'keep'

/**
 * The verdict for one cell of the product.
 *
 * An attempt-named reference with no row, or whose row is not the same call, is dropped. One whose row is the same call is
 * renamed to `row` when that row is pending, posted or reversed, so a committed call is never under-counted; a reversed
 * row keeps its movement, because the reversal's own application already nets it. A hold row is never the same call as a
 * record, and a record row is never released. A `row` reference is left alone, except the reservation of a released hold,
 * which nothing released after the append and the commit.
 *
 * @param kind Whether the key names a hold or an enforced record.
 * @param name Whether the reference is `row` or named by an attempt.
 * @param state The state of the ledger row under the key.
 * @param same Whether that row is the same call as the attempt that took the reference.
 */
export function verdictFor(kind: ReferenceKind, name: ReferenceName, state: RowState, same: boolean): ReferenceVerdict {
  if (name === 'row') return kind === 'reserve' && state === 'released' ? 'drop' : 'keep'
  if (state === 'none' || state === 'released' || !same) return 'drop'
  if (kind === 'record' && state === 'pending') return 'drop'
  return 'commit'
}

/** The kind a key names, or `null` for a key the sweep does not judge (`capture:`, `reverse:`, `release:` take `row` directly). */
export function kindOf(key: string): ReferenceKind | null {
  if (key.startsWith(RESERVE_KEY_PREFIX)) return 'reserve'
  return key.startsWith(RECORD_KEY_PREFIX) ? 'record' : null
}

/** The key the ledger row of a reference is stored under. */
export function ledgerKeyOf(key: string, kind: ReferenceKind): string {
  return key.slice((kind === 'reserve' ? RESERVE_KEY_PREFIX : RECORD_KEY_PREFIX).length)
}

/**
 * Whether the ledger row is the same call as the attempt that took the reference, as far as the reference and its budget can
 * tell: the budget matches the row's tenant, payer and feature, and the row is enforced and not a system cost. A `record:`
 * reference must also have moved the window of the row's instant by the row's billed amount and tokens, for one call; a
 * `reserve:` reference compares neither, because a hold takes its window from the clock at the take and a capture
 * overwrites the billed amount, while the application already pins the delta.
 *
 * @param kind The kind of the reference.
 * @param reference The reference with the window and delta of its application.
 * @param budget The budget the reference names.
 * @param row The ledger row under the reference's key.
 */
export function isSameCall(kind: ReferenceKind, reference: StaleReference, budget: Budget, row: UsageRecord): boolean {
  if (budget.tenantId !== row.tenantId || !row.enforced || row.isSystemCost) return false
  if (budget.scope.type !== 'tenant' && !sameScope(budget.scope, row.scope)) return false
  if (!featureMatches(budget.features, row.feature)) return false
  if (kind === 'reserve') return true
  const expected: BudgetDelta = { nanoUsd: row.billedCostNanoUsd, tokens: sumTokens(row), count: 1 }
  return (
    windowStartFor(budget, row.occurredAt).getTime() === reference.windowStart.getTime() &&
    reference.delta.nanoUsd === expected.nanoUsd &&
    reference.delta.tokens === expected.tokens &&
    reference.delta.count === expected.count
  )
}

/**
 * The verdict for a stale reference, from what the sweep read.
 *
 * @param reference The stale reference.
 * @param budget The budget it names, or `null` when that budget no longer exists.
 * @param row The ledger row under the reference's key, or `null`.
 */
export function judge(reference: StaleReference, budget: Budget | null, row: UsageRecord | null): ReferenceVerdict {
  const kind = kindOf(reference.key)
  if (kind === null) return 'keep'
  const name: ReferenceName = reference.attempt === COMMITTED_REFERENCE ? 'row' : 'attempt'
  const state: RowState = row === null ? 'none' : row.status
  const same = row !== null && budget !== null && isSameCall(kind, reference, budget, row)
  return verdictFor(kind, name, state, same)
}

/** Where the ledger row of a budget application is found, and which of its states ends the application's use. */
export interface RowLookup {
  /** The row is stored under this idempotency key, or has this id. */
  by: 'key' | 'id'
  value: string
  /** Whether the row's status means the movement no longer needs its application to be replayable. */
  ended: (status: UsageStatus) => boolean
}

/**
 * How to find the ledger row an application belongs to and when that row has ended, for the pruning of applications; `null`
 * for a key the table does not know, whose application is then never deleted. A record's consumption and a capture end with
 * any status but `pending`; a reversal ends with `reversed`; the release of a hold's reservation ends with `released`. A
 * hold's own reservation ends when it was captured or reversed, and never when it was released: a released hold's reference
 * is given back by the verdict, and only the application that gives back leaves is deleted afterwards.
 */
export function lookupOf(key: string): RowLookup | null {
  const notPending = (status: UsageStatus): boolean => status !== 'pending'
  if (key.startsWith(RESERVE_KEY_PREFIX)) return { by: 'key', value: key.slice(RESERVE_KEY_PREFIX.length), ended: (status) => status === 'posted' || status === 'reversed' }
  if (key.startsWith(RECORD_KEY_PREFIX)) return { by: 'key', value: key.slice(RECORD_KEY_PREFIX.length), ended: notPending }
  if (key.startsWith(CAPTURE_KEY_PREFIX)) return { by: 'id', value: key.slice(CAPTURE_KEY_PREFIX.length), ended: notPending }
  if (key.startsWith(REVERSE_KEY_PREFIX)) return { by: 'id', value: key.slice(REVERSE_KEY_PREFIX.length), ended: (status) => status === 'reversed' }
  if (key.startsWith(RELEASE_KEY_PREFIX)) return { by: 'key', value: key.slice(RELEASE_KEY_PREFIX.length), ended: (status) => status === 'released' }
  return null
}
