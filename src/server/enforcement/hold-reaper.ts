/**
 * @fileoverview `HoldReaper` — the periodic sweep that reclaims expired pending
 * holds (spec §8.3). A hold moves real wallet/budget headroom, so a crash between
 * `hold()` and `capture()` must not strand it: after `holds.ttlSeconds` the reaper
 * voids the pending record and runs the SAME restoration path as `release()`. It is
 * multi-replica-safe — the store's atomic `pending → released` transition means
 * exactly one replica wins each expired hold; a `null` claim is simply skipped.
 * Errors on one hold never abort the batch. A plain `setInterval` under the module
 * lifecycle hooks (no `@nestjs/schedule` dependency); the interval is `unref()`'d so
 * it never blocks process exit. Internal — not part of the public barrel.
 * @layer server
 */

import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import type { ResolvedAiTokensOptions } from '../config'
import { LedgerService } from '../services/ledger.service'
import { MeteringService } from '../services/metering.service'

/** The maximum number of expired holds reclaimed per sweep. */
const REAP_BATCH_SIZE = 100
/** Milliseconds per second (interval/TTL are configured in seconds). */
const MS_PER_SECOND = 1_000

/** The resolved-options subset the reaper consumes. */
export type HoldReaperOptions = Pick<ResolvedAiTokensOptions, 'holds'>

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
    this.timer = setInterval(() => void this.sweep(), intervalMs)
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
   * hold is logged and never aborts the batch (deterministic, idempotent, safe to
   * run repeatedly).
   */
  async sweep(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.options.holds.ttlSeconds * MS_PER_SECOND)
    const expired = await this.ledger.findExpiredHolds(cutoff, REAP_BATCH_SIZE)
    for (const record of expired) {
      try {
        const claimed = await this.ledger.transition(record.id, 'pending', 'released')
        if (claimed === null) continue
        await this.metering.restoreReleasedHold(claimed, 'expired', true)
      } catch {
        this.logger.warn(`failed to reap expired hold ${record.id}`)
      }
    }
  }
}
