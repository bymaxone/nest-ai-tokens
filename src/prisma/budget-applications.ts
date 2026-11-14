/**
 * @fileoverview The keyed budget movements of the Prisma store: a consume, an adjust or a give-back that happens
 * once per application, however many attempts and instances make it. Split out of the store class so `index.ts`
 * stays focused on the store methods; the statements themselves are builders in `adapter-sql.ts`.
 * @layer prisma
 */

import type { ApplicationOutcome, BudgetApplication, BudgetDelta, BudgetLimits, UnapplyOutcome } from '../server'
import { adjustWindowSql, applicationExistsSql, consumeWindowSql, ensureWindowSql, recordApplicationSql, unapplySql } from './budget-statements'
import type { SqlClient, SqlExecutor } from './raw-client'

/** What `unapplySql` returns for an application that was active. */
interface MovedRow {
  windowStart: Date
  spentNanoUsd: bigint
  spentTokens: bigint
  spentCount: number
}

/** Thrown inside the transaction to roll the application back when a limit refuses the consume. */
class RefusedByLimit extends Error {}

/** The keyed budget movements over one client. */
export class BudgetApplications {
  constructor(private readonly prisma: SqlClient) {}

  /** Consume a window once per application; a limit that refuses it rolls the application back with the move. */
  async consume(application: BudgetApplication, windowStart: Date, delta: BudgetDelta, limits: BudgetLimits): Promise<ApplicationOutcome> {
    try {
      return await this.prisma.transaction(async (tx) => {
        if (!(await this.record(tx, application, windowStart, delta))) return 'replayed'
        await tx.execute(ensureWindowSql(application.budgetId, windowStart))
        const moved = await tx.query<{ id: string }[]>(consumeWindowSql(application.budgetId, windowStart, delta, limits))
        if (moved[0] === undefined) throw new RefusedByLimit()
        return 'applied'
      })
    } catch (error) {
      if (error instanceof RefusedByLimit) return 'refused'
      throw error
    }
  }

  /** Move a window once per application, without a limit. */
  adjust(application: BudgetApplication, windowStart: Date, delta: BudgetDelta): Promise<'applied' | 'replayed'> {
    return this.prisma.transaction(async (tx) => {
      if (!(await this.record(tx, application, windowStart, delta))) return 'replayed'
      await tx.execute(ensureWindowSql(application.budgetId, windowStart))
      await tx.execute(adjustWindowSql(application.budgetId, windowStart, delta))
      return 'applied'
    })
  }

  /** Give an application back: subtract what it moved from the window it moved, once. */
  unapply(application: BudgetApplication): Promise<UnapplyOutcome> {
    return this.prisma.transaction(async (tx) => {
      const rows = await tx.query<MovedRow[]>(unapplySql(application))
      const moved = rows[0]
      if (moved === undefined) return (await tx.query<unknown[]>(applicationExistsSql(application))).length > 0 ? 'already' : 'absent'
      const delta = { nanoUsd: -moved.spentNanoUsd, tokens: -Number(moved.spentTokens), count: -moved.spentCount }
      await tx.execute(ensureWindowSql(application.budgetId, moved.windowStart))
      await tx.execute(adjustWindowSql(application.budgetId, moved.windowStart, delta))
      return 'unapplied'
    })
  }

  /** Whether this attempt recorded the application, so that it is the one that moves the window. */
  private async record(tx: SqlExecutor, application: BudgetApplication, windowStart: Date, delta: BudgetDelta): Promise<boolean> {
    return (await tx.query<unknown[]>(recordApplicationSql(application, windowStart, delta))).length > 0
  }
}
