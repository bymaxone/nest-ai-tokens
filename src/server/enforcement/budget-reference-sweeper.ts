/**
 * @fileoverview The sweep of budget references an attempt left behind. A keyed budget movement holds one reference per
 * attempt; an attempt that dies between the take and the commit leaves its reference, and with it the movement, counted
 * for nobody. The sweep lists the references that are older than the grace, looks at the ledger row under each key, and
 * gives each the verdict of `verdictFor`: give it back, rename it to `row`, or leave it. It is idempotent, takes no lock,
 * and a second sweeper only repeats verdicts that already took effect. A tick walks a bounded number of pages from an
 * in-memory cursor that wraps, so the kept `row` references of live calls cannot starve the ones that need a verdict.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { Budget, UsageRecord } from '../../shared'
import type { IBudgetStore, StaleCursor, StaleReference, StaleReferenceQuery, StaleSelection } from '../interfaces'
import type { LedgerService } from '../services/ledger.service'
import { judge, kindOf, ledgerKeyOf, lookupOf } from '../services/budget-reference-verdict'

/** The references read per page. */
const PAGE_SIZE = 100
/** The most pages a tick walks for each selection. */
const PAGES_PER_TICK = 5
/** Milliseconds per second. */
const MS_PER_SECOND = 1_000
/** Stable log key for a failed listing of references (the tick ends; the next one retries). */
const SCAN_FAILED_LOG_KEY = 'ai_tokens.budget_reference_sweep.scan_failed'
/** Stable log line, once per tick, while an owed marker older than the retention pauses the deletion of given-back applications. */
const PRUNE_SKIPPED_LOG_KEY = 'ai_tokens.budget_reference_sweep.prune_skipped given-back pruning skipped: an owed marker is older than the retention'
/** Stable log key for the references a tick could not settle: one line with a count per tick. */
const SETTLE_FAILED_LOG_KEY = 'ai_tokens.budget_reference_sweep.settle_failed'

/** The times the sweep reads. */
export interface BudgetReferenceSweeperOptions {
  /** A reference named by an attempt is judged once it is older than this. */
  graceSeconds: number
  /** The committed reservation of a hold is judged once it is older than this plus the grace. */
  holdTtlSeconds: number
  /** An application that ended, or was given back, is deleted once it is older than this. */
  retentionSeconds: number
}

/** Tuning of the walk, for tests. */
export interface BudgetReferenceSweepTuning {
  pageSize?: number
  pages?: number
}

/** The store's listing of stale references, bound to the store. */
type ListStale = (query: StaleReferenceQuery) => Promise<StaleReference[]>

/** Summarise a caught error for a log line without the driver's own fields. */
function describe(error: unknown): string {
  return error instanceof Error ? `name=${error.name} message=${JSON.stringify(error.message)}` : 'non-Error rejection'
}

/** The sweep of stale budget references over one budget store and one ledger. */
export class BudgetReferenceSweeper {
  private readonly logger = new Logger(BudgetReferenceSweeper.name)
  private readonly cursors: Record<StaleSelection, StaleCursor | undefined> = { attempt: undefined, held: undefined, retained: undefined }
  private readonly pageSize: number
  private readonly pages: number

  constructor(
    private readonly store: IBudgetStore,
    private readonly ledger: LedgerService,
    private readonly options: BudgetReferenceSweeperOptions,
    private readonly now: () => Date = (): Date => new Date(),
    tuning: BudgetReferenceSweepTuning = {},
  ) {
    this.pageSize = tuning.pageSize ?? PAGE_SIZE
    this.pages = tuning.pages ?? PAGES_PER_TICK
  }

  /** Walk one tick: a bounded number of pages of each selection, one summary line for what could not be settled. */
  async sweep(): Promise<void> {
    const list = this.store.findStaleReferences?.bind(this.store)
    if (list === undefined) return
    const failed = { count: 0 }
    const graceMs = this.options.graceSeconds * MS_PER_SECOND
    const now = this.now().getTime()
    const settle = (reference: StaleReference, budgets: Map<string, Promise<Budget | null>>): Promise<void> => this.settle(reference, budgets)
    await this.walk(list, 'attempt', new Date(now - graceMs), failed, settle)
    await this.walk(list, 'held', new Date(now - graceMs - this.options.holdTtlSeconds * MS_PER_SECOND), failed, settle)
    await this.prune(list, new Date(now - this.options.retentionSeconds * MS_PER_SECOND), failed)
    if (failed.count > 0) this.logger.warn(`${SETTLE_FAILED_LOG_KEY} count=${String(failed.count)}`)
  }

  /** Walk pages of one selection from its cursor; an empty page wraps the cursor to the start and ends the walk. */
  private async walk(list: ListStale, selection: StaleSelection, olderThan: Date, failed: { count: number }, handle: (reference: StaleReference, budgets: Map<string, Promise<Budget | null>>) => Promise<void>): Promise<void> {
    for (let page = 0; page < this.pages; page++) {
      const after = this.cursors[selection]
      let found: StaleReference[]
      try {
        found = await list({ selection, olderThan, limit: this.pageSize, ...(after === undefined ? {} : { after }) })
      } catch (error) {
        this.logger.warn(`${SCAN_FAILED_LOG_KEY} ${describe(error)}`)
        return
      }
      const last = found[found.length - 1]
      if (last === undefined) {
        this.cursors[selection] = undefined
        return
      }
      this.cursors[selection] = { createdAt: last.createdAt, key: last.key, budgetId: last.budgetId, attempt: last.attempt }
      const budgets = new Map<string, Promise<Budget | null>>()
      for (const reference of found) {
        try {
          await handle(reference, budgets)
        } catch {
          failed.count += 1
        }
      }
    }
  }

  /**
   * Delete what no longer protects anything: the applications given back before the retention, and the applications whose
   * committed reference belongs to a row that ended, with no effects owed, once they are older than the retention. A pending
   * hold, a row that still owes effects, a row that cannot be found and a key the table does not know are left alone.
   */
  private async prune(list: ListStale, before: Date, failed: { count: number }): Promise<void> {
    if (this.store.pruneGivenBack !== undefined) {
      try {
        // A given-back application names no row, so it stays while any row still owes effects past the retention: a retry of
        // that row's release would otherwise find no application and give the movement back a second time.
        if (await this.owesBefore(before)) this.logger.warn(PRUNE_SKIPPED_LOG_KEY)
        else await this.store.pruneGivenBack(before, this.pageSize)
      } catch {
        failed.count += 1
      }
    }
    if (this.store.pruneApplication === undefined) return
    await this.walk(list, 'retained', before, failed, (reference) => this.pruneOne(reference, before))
  }

  /** Delete one application when the row it belongs to ended and owes nothing. */
  private async pruneOne(reference: StaleReference, before: Date): Promise<void> {
    const lookup = lookupOf(reference.key)
    if (lookup === null) return
    const row = lookup.by === 'key' ? await this.ledger.findByIdempotencyKey(reference.tenantId, lookup.value) : await this.ledger.findById(lookup.value)
    if (row?.tenantId !== reference.tenantId || !lookup.ended(row.status)) return
    // A reversal's marker is on the compensating row, which the original names, so both rows are read.
    if (this.ledger.supportsOwedEffects() && (await this.owesEffects(row))) return
    await this.store.pruneApplication?.(reference, before)
  }

  /** Whether any row has owed its effects since before `before`; a ledger that keeps no marker owes nothing. */
  private async owesBefore(before: Date): Promise<boolean> {
    return this.ledger.supportsOwedEffects() && (await this.ledger.findEffectsOwed(before, 1)).length > 0
  }

  /** Whether the row, or the compensating row that reversed it, still owes effects. */
  private async owesEffects(row: UsageRecord): Promise<boolean> {
    if ((await this.ledger.findEffectsOwedFor(row.id)) !== null) return true
    return row.reversedByRecordId !== undefined && (await this.ledger.findEffectsOwedFor(row.reversedByRecordId)) !== null
  }

  /** Give one reference its verdict and apply it. */
  private async settle(reference: StaleReference, budgets: Map<string, Promise<Budget | null>>): Promise<void> {
    const kind = kindOf(reference.key)
    if (kind === null) return
    let budget = budgets.get(reference.budgetId)
    if (budget === undefined) {
      budget = this.store.findBudgetById({ tenantId: reference.tenantId, id: reference.budgetId })
      budgets.set(reference.budgetId, budget)
    }
    const row: UsageRecord | null = await this.ledger.findByIdempotencyKey(reference.tenantId, ledgerKeyOf(reference.key, kind))
    const verdict = judge(reference, await budget, row)
    if (verdict === 'drop') await this.store.dropReference(reference)
    else if (verdict === 'commit') await this.store.commitReference(reference)
  }
}
