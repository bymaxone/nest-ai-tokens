/**
 * @fileoverview The timer of the hold reaper never starts a sweep while the previous one is still running: a scan that hangs on
 * a degraded store would otherwise stack one more sweep, and one more pooled connection, on every tick. A run of skipped ticks
 * is logged once, and the sweep resumes when the running one ends.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { LedgerService } from '../services/ledger.service'
import { HoldReaper } from './hold-reaper'

const SKIPPED_LINE = 'ai_tokens.hold_reaper.tick_skipped'

/** A ledger whose expired-hold scan stays pending until `release` is called, counting concurrent and total scans. */
function hangingLedger(): { ledger: LedgerService; scans: { active: number; peak: number; total: number }; release: () => void } {
  const scans = { active: 0, peak: 0, total: 0 }
  const pending: (() => void)[] = []
  const ledger = {
    findExpiredHolds: (): Promise<never[]> => {
      scans.total += 1
      scans.active += 1
      scans.peak = Math.max(scans.peak, scans.active)
      return new Promise<never[]>((resolve) => {
        pending.push(() => {
          scans.active -= 1
          resolve([])
        })
      })
    },
    supportsOwedEffects: (): boolean => false,
  } as unknown as LedgerService
  return { ledger, scans, release: () => pending.splice(0).forEach((done) => done()) }
}

function reaperOver(ledger: LedgerService): HoldReaper {
  return new HoldReaper(ledger, {} as never, { holds: { ttlSeconds: 60, reaperIntervalSeconds: 1 } })
}

describe('HoldReaper timer without overlap', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  /** Invariant: ten ticks while one sweep hangs start exactly one sweep. */
  it('starts no sweep while the previous one is running', async () => {
    const { ledger, scans } = hangingLedger()
    const reaper = reaperOver(ledger)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(10_000)
    reaper.onApplicationShutdown()
    expect(scans).toMatchObject({ peak: 1, total: 1 })
  })

  /** Invariant: the skipped ticks of one streak are one log line, with no store detail. */
  it('logs a run of skipped ticks once', async () => {
    const { ledger } = hangingLedger()
    const reaper = reaperOver(ledger)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(10_000)
    reaper.onApplicationShutdown()
    const lines = (Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith(SKIPPED_LINE))
    expect(lines).toHaveLength(1)
  })

  /** Invariant: when the running sweep ends the next tick sweeps again, and a later streak is logged again. */
  it('resumes when the running sweep ends and logs the next streak', async () => {
    const { ledger, scans, release } = hangingLedger()
    const reaper = reaperOver(ledger)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(3_000)
    release()
    await jest.advanceTimersByTimeAsync(1_000)
    expect(scans.total).toBe(2)
    await jest.advanceTimersByTimeAsync(3_000)
    reaper.onApplicationShutdown()
    const lines = (Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith(SKIPPED_LINE))
    expect(lines).toHaveLength(2)
    expect(scans.peak).toBe(1)
  })
})
