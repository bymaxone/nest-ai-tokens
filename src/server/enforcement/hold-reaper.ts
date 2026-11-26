/**
 * @fileoverview `HoldReaper` — the periodic sweep that reclaims expired pending
 * holds (spec §8.3). A hold moves real wallet/budget headroom, so a crash between
 * `hold()` and `capture()` must not strand it: after `holds.ttlSeconds` the reaper
 * voids the pending record and runs the SAME restoration path as `release()`. It is
 * multi-replica-safe — the store's atomic `pending → released` transition means
 * exactly one replica wins each expired hold; a `null` claim is simply skipped.
 * Errors on one hold never abort the batch, and a failed expired-hold scan (e.g. a
 * dropped database connection) is logged and ends that sweep — the next tick retries;
 * no rejection ever escapes the timer. A plain `setInterval` under the module
 * lifecycle hooks (no `@nestjs/schedule` dependency); the interval is `unref()`'d so
 * it never blocks process exit. Internal — not part of the public barrel.
 * @layer server
 */

import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import type { ResolvedAiTokensOptions } from '../config'
import type { UsageRecord } from '../../shared'
import { describeError } from '../errors/describe-error'
import type { OwedEffects } from '../interfaces'
import type { LedgerService } from '../services/ledger.service'
import type { MeteringService } from '../services/metering.service'
import type { BudgetReferenceSweeper } from './budget-reference-sweeper'
import type { OrphanDebitSweeper } from './orphan-debit-sweeper'

/** The number of expired holds read at a time. */
const REAP_BATCH_SIZE = 100
/** The most batches of expired holds one sweep reclaims, so that no backlog keeps a sweep from ending. */
const REAP_BATCHES_PER_SWEEP = 100
/** The maximum number of owed rows the settlement sweep finishes per tick. */
const OWED_BATCH_SIZE = 100
/** Milliseconds per second (interval/TTL are configured in seconds). */
const MS_PER_SECOND = 1_000

/** Stable log key for a failed expired-hold scan (the sweep ends; the next tick retries). */
const SCAN_FAILED_LOG_KEY = 'ai_tokens.hold_reaper.scan_failed'
/** Stable log key for the rows the settlement sweep could not finish in a tick: one line with a count per tick. */
const SETTLEMENT_FAILED_LOG_KEY = 'ai_tokens.hold_reaper.settlement_sweep_failed'
/** Stable log key, written once at boot, for a store that keeps no effects-owed marker. */
const SETTLEMENT_INACTIVE_LOG_KEY = 'ai_tokens.hold_reaper.settlement_sweep_inactive'
/** Stable log key, written once at boot, for a wallet store that cannot list debits across wallets. */
const ORPHAN_INACTIVE_LOG_KEY = 'ai_tokens.hold_reaper.orphan_debit_sweep_inactive'
/** The grace used when the options carry no settlement section. */
const DEFAULT_GRACE_SECONDS = 300
/** Stable log key, written once per run of skipped ticks, for a tick that found the previous sweep still running. */
const TICK_SKIPPED_LOG_KEY = 'ai_tokens.hold_reaper.tick_skipped'
/** Stable log key, written once per stalled sweep, for a tick that abandoned a sweep that had run too long. */
const TICK_STALLED_LOG_KEY = 'ai_tokens.hold_reaper.tick_stalled'
/** Stable log key, written once per run of ticks, for a stalled sweep that cannot be abandoned while an earlier one is still running. */
const SWEEP_BLOCKED_LOG_KEY = 'ai_tokens.hold_reaper.sweep_blocked'
/** A sweep is abandoned once it has run for this many reaper intervals, or for the minimum below when that is longer. */
const STALL_AFTER_INTERVALS = 10
/** The shortest time a sweep may run before it is abandoned, in milliseconds. */
const STALL_AFTER_MIN_MS = 600_000
/** Stable log key for any other rejection out of a timer-driven sweep. */
const SWEEP_FAILED_LOG_KEY = 'ai_tokens.hold_reaper.sweep_failed'

/** A sweep the timer started, with the clock reading, in milliseconds, at which it started. */
interface TimedSweep {
  readonly startedAt: number
}

/** The resolved-options subset the reaper consumes. */
export type HoldReaperOptions = Pick<ResolvedAiTokensOptions, 'holds'> & Partial<Pick<ResolvedAiTokensOptions, 'settlement'>>

/**
 * Periodic sweep that reclaims expired spend-holds, restoring wallet balance
 * and budget headroom so the capacity is not permanently stranded after a
 * crash between `hold()` and `capture()` (see file overview).
 */
@Injectable()
export class HoldReaper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HoldReaper.name)
  private timer: ReturnType<typeof setInterval> | undefined
  /** The timer-driven sweep in flight: a tick that finds one within its bound does nothing, so a slow store is never swept twice at once. */
  private current: TimedSweep | undefined
  /** The sweep a tick abandoned and that has not settled: while it runs, no further sweep is started, so at most two run at once. */
  private abandoned: TimedSweep | undefined
  /** Whether the current run of blocked ticks has been logged. */
  // Stryker disable next-line BooleanLiteral: equivalent: a tick that can be blocked needs a sweep already abandoned, and starting a sweep sets the flag to false first, so the initial value is never read
  private blockedLogged = false
  /** How long a sweep may run before the next tick abandons it, in milliseconds. */
  private stallAfterMs = STALL_AFTER_MIN_MS
  /** Whether the current run of skipped ticks has been logged. */
  // Stryker disable next-line BooleanLiteral: equivalent: a tick that can skip needs a sweep already running, and starting that sweep sets the flag to false first, so the initial value is never read
  private skipLogged = false

  /**
   * @param ledger The ledger service (expired-hold scan + atomic void claim).
   * @param metering The metering facade (shared hold-restoration path).
   * @param options The resolved options carrying the hold TTL + sweep interval.
   * @param now The injected clock (testability).
   * @param references The sweep of budget references an attempt left behind, when budgets are enabled.
   * @param orphans The sweep of wallet debits no row stands behind, when wallets are enabled.
   */
  constructor(
    private readonly ledger: LedgerService,
    private readonly metering: MeteringService,
    private readonly options: HoldReaperOptions,
    private readonly now: () => Date = (): Date => new Date(),
    private readonly references?: BudgetReferenceSweeper,
    private readonly orphans?: OrphanDebitSweeper,
  ) {}

  /** Start the periodic sweep on module boot (interval `unref()`'d so it never blocks exit). */
  onApplicationBootstrap(): void {
    if (this.settlementEnabled() && !this.ledger.supportsOwedEffects()) this.logger.warn(`${SETTLEMENT_INACTIVE_LOG_KEY} the ledger store keeps no effects-owed marker`)
    if (this.settlementEnabled() && this.orphans !== undefined && this.ledger.supportsOwedEffects() && !this.orphans.supported) this.logger.warn(`${ORPHAN_INACTIVE_LOG_KEY} the wallet store lists no debits across wallets`)
    const intervalMs = this.options.holds.reaperIntervalSeconds * MS_PER_SECOND
    this.stallAfterMs = Math.max(STALL_AFTER_INTERVALS * intervalMs, STALL_AFTER_MIN_MS)
    this.timer = setInterval(() => {
      this.tick()
    }, intervalMs)
    this.timer.unref()
  }

  /**
   * One timer tick: a sweep, unless the previous one is still running, in which case one line per run of skipped ticks says so. A
   * sweep that has run for longer than the stall bound is abandoned with one line, and the tick starts a fresh one. At most two sweeps
   * run at once, each holding a store connection until the store gives it up: while an abandoned sweep is still running, a stalled one
   * is not abandoned and no sweep starts, with one line per run of such ticks, and the reaper resumes when either settles.
   */
  private tick(): void {
    const nowMs = this.now().getTime()
    if (this.current !== undefined) {
      const ranMs = nowMs - this.current.startedAt
      if (ranMs <= this.stallAfterMs) {
        if (!this.skipLogged) this.logger.warn(`${TICK_SKIPPED_LOG_KEY} the previous sweep is still running`)
        this.skipLogged = true
        return
      }
      if (this.abandoned !== undefined) {
        if (!this.blockedLogged) this.logger.warn(`${SWEEP_BLOCKED_LOG_KEY} two sweeps are still running, so no sweep starts until one settles`)
        this.blockedLogged = true
        return
      }
      this.logger.warn(`${TICK_STALLED_LOG_KEY} the previous sweep ran for ${String(Math.round(ranMs / MS_PER_SECOND))} seconds`)
      this.abandoned = this.current
    }
    this.skipLogged = false
    this.blockedLogged = false
    const sweep: TimedSweep = { startedAt: nowMs }
    this.current = sweep
    void this.run(sweep)
  }

  /** Run one sweep, log a failure of it, and clear the running flag. The wait is a native `await`: a chain would build its answer with `Promise[Symbol.species]`, read live. */
  private async run(sweep: TimedSweep): Promise<void> {
    try {
      await this.sweep()
    } catch (error) {
      this.logger.warn(`${SWEEP_FAILED_LOG_KEY} ${describeError(error)}`)
    } finally {
      if (this.current === sweep) this.current = undefined
      else this.abandoned = undefined
    }
  }

  /** Stop the sweep on shutdown (no open handles left for Jest). */
  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Reclaim the expired pending holds, then run the settlement sweeps. Batches are read while one comes back full, up to a bound, and
   * a batch of which no hold could be moved ends the reclaiming, so that the next tick retries it. For each hold: win the atomic
   * `pending → released` claim (a `null` result means another replica won — skip),
   * then run the shared restoration + `hold.released` emission. A failure on one
   * hold is logged and never aborts the batch; a failure of the expired-hold scan
   * itself is logged and ends this sweep without throwing (deterministic, idempotent,
   * safe to run repeatedly).
   */
  async sweep(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.options.holds.ttlSeconds * MS_PER_SECOND)
    for (let batch = 0; batch < REAP_BATCHES_PER_SWEEP; batch += 1) {
      let expired: UsageRecord[]
      try {
        expired = await this.ledger.findExpiredHolds(cutoff, REAP_BATCH_SIZE)
      } catch (error) {
        this.logger.warn(`${SCAN_FAILED_LOG_KEY} ${describeError(error)}`)
        return
      }
      const moved = await this.reap(expired)
      if (expired.length < REAP_BATCH_SIZE || !moved) break
    }
    await this.settleOwed()
    await this.sweepReferences()
    await this.sweepOrphans()
  }

  /** Release each of these holds and restore what it reserved; returns whether any left `pending`, here or on another replica. */
  private async reap(expired: readonly UsageRecord[]): Promise<boolean> {
    let moved = false
    for (const record of expired) {
      try {
        const claimed = await this.ledger.transition(record.id, 'pending', 'released', undefined, {})
        moved = true
        if (claimed === null) continue
        // Stryker disable next-line StringLiteral: 'expired' reason string is internal audit text; tests check that holds are released, not the reason string
        await this.metering.restoreReleasedHold(claimed, 'expired', true)
      // Stryker disable next-line BlockStatement: best-effort per-hold reaping; a failure on one hold never aborts the batch
      } catch {
        // Stryker disable next-line StringLiteral: logger text is internal observability
        this.logger.warn(`failed to reap expired hold ${record.id}`)
      }
    }
    return moved
  }

  /** Give the wallet debits no row stands behind their verdict, when the sweep is on and the stores can list them. */
  private async sweepOrphans(): Promise<void> {
    if (this.settlementEnabled()) await this.orphans?.sweep()
  }

  /** Give the references an attempt left behind their verdict, when the sweep is on and the store can list them. */
  private async sweepReferences(): Promise<void> {
    if (this.settlementEnabled()) await this.references?.sweep()
  }

  /** Whether the settlement sweep runs: on unless the options switch it off. */
  private settlementEnabled(): boolean {
    return this.options.settlement?.enabled ?? true
  }

  /**
   * Finish the effects of rows whose marker is older than the grace. Rows are selected without a lock, because every
   * leg is keyed and a second sweeper only repeats legs that move nothing. A row that fails stays marked for the next
   * tick; the tick logs one line with the count of failures, never one per row and never an amount.
   */
  private async settleOwed(): Promise<void> {
    if (!this.settlementEnabled() || !this.ledger.supportsOwedEffects()) return
    const graceSeconds = this.options.settlement?.graceSeconds ?? DEFAULT_GRACE_SECONDS
    let owed: OwedEffects[]
    try {
      owed = await this.ledger.findEffectsOwed(new Date(this.now().getTime() - graceSeconds * MS_PER_SECOND), OWED_BATCH_SIZE)
    } catch (error) {
      this.logger.warn(`${SCAN_FAILED_LOG_KEY} ${describeError(error)}`)
      return
    }
    const failed: string[] = []
    for (const item of owed) {
      try {
        await this.metering.settleOwedEffects(item)
      } catch {
        failed.push(item.record.id)
      }
    }
    if (failed.length > 0) this.logger.warn(`${SETTLEMENT_FAILED_LOG_KEY} count=${String(failed.length)} first=${String(failed.slice(0, 1))}`)
  }
}
