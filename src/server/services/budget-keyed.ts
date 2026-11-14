/**
 * @fileoverview The keyed movements of `BudgetService`: what a movement is recorded under, which attempt holds a reference
 * on it, what a store's verdict on a consume means for the guard around it, and the refusal of a key that names another call.
 * @layer server
 */

import { AiTokensException } from '../errors'
import type { ApplicationOutcome, BudgetReference } from '../interfaces'
import { COMMITTED_REFERENCE } from '../utils/budget-references'
import type { FailingDimension } from './budget-math'

/** A live counter increment made during a guarded consume (kept for rollback). */
export interface CounterIncrement {
  key: string
  amount: bigint
}

/** The application a keyed movement is recorded under and the attempt that holds a reference on it. */
export interface Keyed {
  key: string
  attempt: string
}

/** The store's reference for a keyed movement of one budget. */
export function referenceOf(keyed: Keyed, budgetId: string): BudgetReference {
  return { key: keyed.key, budgetId, attempt: keyed.attempt }
}

/**
 * The keyed use of a movement, when a key is given. An attempt that names none holds the committed reference: the
 * movement belongs to a ledger row, and only that row's release gives it back.
 */
export function keyedOf(key: string | undefined, attempt: string | undefined): Keyed | undefined {
  return key === undefined ? undefined : { key, attempt: attempt ?? COMMITTED_REFERENCE }
}

/** What a store's verdict on a consume means for the guard: refused blocks, a mismatch refuses the key, a replay moved nothing. */
export function guardOf(outcome: ApplicationOutcome): GuardResult {
  if (outcome === 'mismatch') return { ok: false, increments: [], mismatch: true }
  return { ok: outcome !== 'refused', increments: [], replayed: outcome === 'replayed' }
}

/** The refusal of a key that names another call than this one: its movement is already recorded with another delta. */
export function keyNamesAnotherCall(): AiTokensException {
  // Stryker disable next-line ObjectLiteral,StringLiteral: error context is internal diagnostics; tests check error code only
  return new AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', undefined, { reason: 'the budget movement of this key was recorded with another amount' })
}

/**
 * The result of a guarded consume: whether it passed, the live counter increments
 * it made, and — when a counter fast-path reject decided the block — the failing
 * dimension so the caller raises the correct §16 code (the DB path defers to
 * {@link failingDimension} instead).
 */
export interface GuardResult {
  ok: boolean
  increments: CounterIncrement[]
  failing?: FailingDimension
  /** The application was already recorded by an earlier attempt, so nothing moved and the counters were left alone. */
  replayed?: boolean
  /** The application was recorded with another amount: the key names another call, and nothing moved. */
  mismatch?: boolean
}

