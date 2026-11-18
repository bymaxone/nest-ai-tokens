/**
 * @fileoverview A sweep of the hold reaper that never settles must not stop the reaper for good: while it runs, every tick is
 * skipped, so a scan that hangs on a dead connection would leave expired holds, and the funds they lock, unreclaimed for as long as
 * the process lives. After a sweep has run for the longer of ten intervals and ten minutes, the next tick logs the stall once,
 * abandons that sweep and starts a fresh one; the abandoned sweep's late end changes nothing. Each case drives a scan that stays
 * pending on fake timers and counts the scans it was asked for.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { LedgerService } from '../services/ledger.service'
import type { MeteringService } from '../services/metering.service'
import { HoldReaper } from './hold-reaper'

const STALLED_LINE = 'ai_tokens.hold_reaper.tick_stalled'
const MINUTE_MS = 60_000

/** A ledger whose expired-hold scans stay pending until released one by one, counting the scans started. */
function hangingLedger(): { ledger: LedgerService; scans: { total: number; active: number }; releaseNth: (index: number) => void } {
  const scans = { total: 0, active: 0 }
  const pending: (() => void)[] = []
  const ledger = {
    findExpiredHolds: (): Promise<never[]> => {
      scans.total += 1
      scans.active += 1
      return new Promise<never[]>((resolve) => {
        pending.push(() => {
          scans.active -= 1
          resolve([])
        })
      })
    },
    supportsOwedEffects: (): boolean => false,
  } as unknown as LedgerService
  return { ledger, scans, releaseNth: (index) => pending[index]?.() }
}

function reaperOver(ledger: LedgerService, reaperIntervalSeconds: number): HoldReaper {
  return new HoldReaper(ledger, {} as MeteringService, { holds: { ttlSeconds: 60, reaperIntervalSeconds } })
}

const stalledLines = (): string[] => (Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith(STALLED_LINE))

describe('HoldReaper with a sweep that never settles', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  /** Invariant: a sweep stuck for ten minutes does not keep the reaper from sweeping on the next tick. */
  it('starts a fresh sweep once the running one has stalled for ten minutes', async () => {
    const { ledger, scans } = hangingLedger()
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(9 * MINUTE_MS)
    expect(scans.total).toBe(1)
    await jest.advanceTimersByTimeAsync(2 * MINUTE_MS)
    reaper.onApplicationShutdown()
    expect(scans.total).toBe(2)
  })

  /** Invariant: a sweep that has run for exactly the bound is not abandoned, one that has run longer is. */
  it('abandons a sweep only after it has run longer than the bound', async () => {
    const { ledger, scans } = hangingLedger()
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(10 * MINUTE_MS + 1_000)
    expect(scans.total).toBe(1)
    await jest.advanceTimersByTimeAsync(1_000)
    reaper.onApplicationShutdown()
    expect(scans.total).toBe(2)
  })

  /** Invariant: the stall is one line with the time it ran and nothing a store wrote, and a later stall is a later line. */
  it('logs each stalled sweep once, with no store detail', async () => {
    const built = hangingLedger()
    const { ledger } = built
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    const { releaseNth } = built
    await jest.advanceTimersByTimeAsync(11 * MINUTE_MS)
    expect(stalledLines()).toHaveLength(1)
    expect(stalledLines()[0]).toBe(`${STALLED_LINE} the previous sweep ran for 601 seconds`)
    releaseNth(0)
    await jest.advanceTimersByTimeAsync(11 * MINUTE_MS)
    reaper.onApplicationShutdown()
    expect(stalledLines()).toHaveLength(2)
  })

  /** Invariant: the end of an abandoned sweep, however late, does not mark the fresh sweep as finished. */
  it('keeps skipping ticks while the fresh sweep runs, whatever the abandoned one does', async () => {
    const { ledger, scans, releaseNth } = hangingLedger()
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(11 * MINUTE_MS)
    expect(scans.total).toBe(2)
    releaseNth(0)
    await jest.advanceTimersByTimeAsync(5_000)
    reaper.onApplicationShutdown()
    expect(scans.total).toBe(2)
  })

  /** Invariant: once the fresh sweep ends, the reaper goes on sweeping on every tick. */
  it('goes on sweeping after the fresh sweep ends', async () => {
    const { ledger, scans, releaseNth } = hangingLedger()
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(11 * MINUTE_MS)
    releaseNth(1)
    await jest.advanceTimersByTimeAsync(3_000)
    reaper.onApplicationShutdown()
    expect(scans.total).toBeGreaterThanOrEqual(3)
  })

  /** Invariant: the bound is the longer of ten intervals and ten minutes, so a long interval is not abandoned early. */
  it('waits ten intervals when that is longer than ten minutes', async () => {
    const { ledger, scans } = hangingLedger()
    const reaper = reaperOver(ledger, 120)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(21 * MINUTE_MS)
    expect(scans.total).toBe(1)
    await jest.advanceTimersByTimeAsync(4 * MINUTE_MS)
    reaper.onApplicationShutdown()
    expect(scans.total).toBe(2)
  })

  /** Invariant: with every scan hanging, at most one abandoned sweep and one fresh one are ever running, however long it goes on. */
  it('never has more than two sweeps running when every scan hangs', async () => {
    const { ledger, scans } = hangingLedger()
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS)
    reaper.onApplicationShutdown()
    expect(scans.total).toBe(2)
    expect(scans.active).toBe(2)
  })

  /** Invariant: once the abandoned sweep ends, a later stall of the fresh one can be abandoned in its turn. */
  it('abandons the fresh sweep once the abandoned one has ended', async () => {
    const { ledger, scans, releaseNth } = hangingLedger()
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(11 * MINUTE_MS)
    releaseNth(0)
    await jest.advanceTimersByTimeAsync(11 * MINUTE_MS)
    reaper.onApplicationShutdown()
    expect(scans.total).toBe(3)
  })

  /** Invariant: a sweep that ends on its own is never abandoned, however many intervals pass. */
  it('logs no stall for sweeps that end', async () => {
    const ledger = { findExpiredHolds: (): Promise<never[]> => Promise.resolve([]), supportsOwedEffects: (): boolean => false } as unknown as LedgerService
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(30 * MINUTE_MS)
    reaper.onApplicationShutdown()
    expect(stalledLines()).toHaveLength(0)
  })
})
