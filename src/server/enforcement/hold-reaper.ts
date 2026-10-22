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
import type { LedgerService } from '../services/ledger.service'
import type { MeteringService } from '../services/metering.service'

/** The maximum number of expired holds reclaimed per sweep. */
const REAP_BATCH_SIZE = 100
/** Milliseconds per second (interval/TTL are configured in seconds). */
const MS_PER_SECOND = 1_000

/** Stable log key for a failed expired-hold scan (the sweep ends; the next tick retries). */
const SCAN_FAILED_LOG_KEY = 'ai_tokens.hold_reaper.scan_failed'
/** Stable log key for any other rejection out of a timer-driven sweep. */
const SWEEP_FAILED_LOG_KEY = 'ai_tokens.hold_reaper.sweep_failed'

/**
 * Summarise a caught error for a log line: its `name`, `message` and `code` only —
 * never the full object, whose driver-specific fields may carry connection details.
 * @param error The caught value (not necessarily an `Error`).
 * @returns `name=… message=… code=…`, or a fixed marker for a non-`Error` value.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'non-Error rejection'
  const { code } = error as { code?: unknown }
  const suffix = typeof code === 'string' || typeof code === 'number' ? ` code=${String(code)}` : ''
  return `name=${error.name} message=${JSON.stringify(error.message)}${suffix}`
}

/** The resolved-options subset the reaper consumes. */
export type HoldReaperOptions = Pick<ResolvedAiTokensOptions, 'holds'>

/**
 * Periodic sweep that reclaims expired spend-holds, restoring wallet balance
 * and budget headroom so the capacity is not permanently stranded after a
 * crash between `hold()` and `capture()` (see file overview).
 */
@Injectable()
export class HoldReaper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HoldReaper.name)
  private timer: ReturnType<typeof setInterval> | undefined

  /**
   * @param ledger The ledger service (expired-hold scan + atomic void claim).
   * @param metering The metering facade (shared hold-restoration path).
   * @param options The resolved options carrying the hold TTL + sweep interval.
   * @param now The injected clock (testability).
   */
  constructor(
    private readonly ledger: LedgerService,
    private readonly metering: MeteringService,
    private readonly options: HoldReaperOptions,
    private readonly now: () => Date = (): Date => new Date(),
  ) {}

  /** Start the periodic sweep on module boot (interval `unref()`'d so it never blocks exit). */
  onApplicationBootstrap(): void {
    const intervalMs = this.options.holds.reaperIntervalSeconds * MS_PER_SECOND
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.warn(`${SWEEP_FAILED_LOG_KEY} ${describeError(error)}`)
      })
    }, intervalMs)
    this.timer.unref()
  }

  /** Stop the sweep on shutdown (no open handles left for Jest). */
  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Reclaim one batch of expired pending holds. For each: win the atomic
   * `pending → released` claim (a `null` result means another replica won — skip),
   * then run the shared restoration + `hold.released` emission. A failure on one
   * hold is logged and never aborts the batch; a failure of the expired-hold scan
   * itself is logged and ends this sweep without throwing (deterministic, idempotent,
   * safe to run repeatedly).
   */
  async sweep(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.options.holds.ttlSeconds * MS_PER_SECOND)
    let expired: UsageRecord[]
    try {
      expired = await this.ledger.findExpiredHolds(cutoff, REAP_BATCH_SIZE)
    } catch (error) {
      this.logger.warn(`${SCAN_FAILED_LOG_KEY} ${describeError(error)}`)
      return
    }
    for (const record of expired) {
      try {
        const claimed = await this.ledger.transition(record.id, 'pending', 'released')
        if (claimed === null) continue
        // Stryker disable next-line StringLiteral: 'expired' reason string is internal audit text; tests check that holds are released, not the reason string
        await this.metering.restoreReleasedHold(claimed, 'expired', true)
      // Stryker disable next-line BlockStatement: best-effort per-hold reaping; a failure on one hold never aborts the batch
      } catch {
        // Stryker disable next-line StringLiteral: logger text is internal observability
        this.logger.warn(`failed to reap expired hold ${record.id}`)
      }
    }
  }
}
