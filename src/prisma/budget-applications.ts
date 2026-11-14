/**
 * @fileoverview The keyed budget movements of the Prisma store: a consume or an adjust that happens once per
 * application however many attempts and instances make it, the references that attempts hold on it, and the commit and
 * the drop of a reference. The statements are builders in `budget-statements.ts`; every operation is one transaction
 * that locks the application row first.
 * @layer prisma
 */

import type { ApplicationOutcome, BudgetDelta, BudgetLimits, BudgetReference, CommitOutcome, DropOutcome } from '../server'
import { COMMITTED_REFERENCE } from '../server/utils/budget-references'
import {
  adjustWindowSql,
  anyReferenceSql,
  consumeWindowSql,
  deleteReferenceSql,
  ensureWindowSql,
  lockApplicationSql,
  recordApplicationSql,
  referenceHeldSql,
  renameReferenceSql,
  takeReferenceSql,
  unapplySql,
} from './budget-statements'
import type { SqlClient, SqlExecutor } from './raw-client'

/** What `lockApplicationSql` returns. */
interface StateRow {
  windowStart: Date
  spentNanoUsd: bigint
  spentTokens: bigint
  spentCount: number
  unappliedAt: Date | null
}

/** Thrown inside the transaction to roll the application back when a limit refuses the consume. */
class RefusedByLimit extends Error {}

/** The most times a take re-runs its insert when the application it found was given back meanwhile. */
const TAKE_ATTEMPTS = 3

/** The keyed budget movements over one client. */
export class BudgetApplications {
  constructor(private readonly prisma: SqlClient) {}

  /** Consume a window once per application; a limit that refuses it rolls the application and the reference back. */
  async consume(reference: BudgetReference, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Promise<ApplicationOutcome> {
    try {
      return await this.prisma.transaction((tx) => this.take(tx, reference, windowStart, delta, limits))
    } catch (error) {
      if (error instanceof RefusedByLimit) return 'refused'
      throw error
    }
  }

  /** Move a window once per application, without a limit. */
  adjust(reference: BudgetReference, windowStart: Date, delta: BudgetDelta): Promise<'applied' | 'replayed' | 'mismatch'> {
    return this.prisma.transaction(async (tx) => (await this.take(tx, reference, windowStart, delta)) as 'applied' | 'replayed' | 'mismatch')
  }

  /** Make the attempt's reference the committed one, or drop it when another attempt of the call already holds that name. */
  commit(reference: BudgetReference): Promise<CommitOutcome> {
    return this.prisma.transaction(async (tx) => {
      if ((await tx.query<StateRow[]>(lockApplicationSql(reference)))[0] === undefined) return 'absent'
      if ((await tx.query<unknown[]>(referenceHeldSql(reference, COMMITTED_REFERENCE))).length > 0) {
        if (reference.attempt !== COMMITTED_REFERENCE) await tx.execute(deleteReferenceSql(reference))
        return 'already'
      }
      return (await tx.query<unknown[]>(renameReferenceSql(reference, COMMITTED_REFERENCE))).length > 0 ? 'committed' : 'gone'
    })
  }

  /** Drop the attempt's reference; the movement goes back with the last one. */
  drop(reference: BudgetReference): Promise<DropOutcome> {
    return this.prisma.transaction(async (tx) => {
      const [state] = await tx.query<StateRow[]>(lockApplicationSql(reference))
      if (state === undefined) return 'absent'
      if ((await tx.query<unknown[]>(deleteReferenceSql(reference))).length === 0) return 'missing'
      if (state.unappliedAt !== null || (await tx.query<unknown[]>(anyReferenceSql(reference))).length > 0) return 'kept'
      const [moved] = await tx.query<StateRow[]>(unapplySql(reference))
      if (moved === undefined) return 'kept'
      const delta = { nanoUsd: -moved.spentNanoUsd, tokens: -Number(moved.spentTokens), count: -moved.spentCount }
      await tx.execute(ensureWindowSql(reference.budgetId, moved.windowStart))
      await tx.execute(adjustWindowSql(reference.budgetId, moved.windowStart, delta))
      return 'unapplied'
    })
  }

  /** Record or find the application, take the attempt's reference and, for a new application, move the window. */
  private async take(tx: SqlExecutor, reference: BudgetReference, windowStart: Date, delta: BudgetDelta, limits?: BudgetLimits): Promise<ApplicationOutcome> {
    for (let round = 0; round < TAKE_ATTEMPTS; round++) {
      const fresh = (await tx.query<unknown[]>(recordApplicationSql(reference, windowStart, delta))).length > 0
      if (!fresh) {
        const [state] = await tx.query<StateRow[]>(lockApplicationSql(reference))
        if (state?.unappliedAt !== null) continue
        if (!sameMovement(state, windowStart, delta)) return 'mismatch'
      }
      await tx.execute(takeReferenceSql(reference))
      if (!fresh) return 'replayed'
      await tx.execute(ensureWindowSql(reference.budgetId, windowStart))
      if (limits !== undefined) {
        const moved = await tx.query<{ id: string }[]>(consumeWindowSql(reference.budgetId, windowStart, delta, limits))
        if (moved[0] === undefined) throw new RefusedByLimit()
      } else {
        await tx.execute(adjustWindowSql(reference.budgetId, windowStart, delta))
      }
      return 'applied'
    }
    throw new Error(`budget application ${reference.key} kept changing while it was taken`)
  }
}

/** Whether an application moved this very window by this very delta. */
function sameMovement(state: StateRow, windowStart: Date, delta: BudgetDelta): boolean {
  return state.windowStart.getTime() === windowStart.getTime() && state.spentNanoUsd === delta.nanoUsd && Number(state.spentTokens) === delta.tokens && state.spentCount === delta.count
}
