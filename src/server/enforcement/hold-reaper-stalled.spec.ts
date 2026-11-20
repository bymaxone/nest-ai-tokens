/**
 * @fileoverview A sweep of the hold reaper that never settles must not stop the reaper for good: while it runs, every tick is
 * skipped, so a scan that hangs on a dead connection would leave expired holds, and the funds they lock, unreclaimed for as long as
 * the process lives. After a sweep has run for the longer of ten intervals and ten minutes, the next tick logs the stall once,
 * abandons that sweep and starts a fresh one; the abandoned sweep's late end changes nothing, and while it still runs a second stall starts no third sweep. Each case drives a scan that stays
 * pending on fake timers and counts the scans it was asked for.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { LedgerService } from '../services/ledger.service'
import type { MeteringService } from '../services/metering.service'
import { HoldReaper } from './hold-reaper'

const STALLED_LINE = 'ai_tokens.hold_reaper.tick_stalled'
const BLOCKED_LINE = 'ai_tokens.hold_reaper.sweep_blocked'
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

/** A ledger whose scans settle at once, except the numbered ones, which never settle; `hangs` says which, or `'all'`. */
function ledgerHangingAt(hangs: readonly number[] | 'all'): { ledger: LedgerService; scans: { total: number; active: number; startedAt: number[] } } {
  const scans = { total: 0, active: 0, startedAt: [] as number[] }
  const ledger = {
    findExpiredHolds: (): Promise<never[]> => {
      scans.total += 1
      scans.startedAt.push(Date.now())
      if (hangs === 'all' || hangs.includes(scans.total)) {
        scans.active += 1
        return new Promise<never[]>(() => undefined)
      }
      return Promise.resolve([])
    },
    supportsOwedEffects: (): boolean => false,
  } as unknown as LedgerService
  return { ledger, scans }
}

function reaperOver(ledger: LedgerService, reaperIntervalSeconds: number): HoldReaper {
  return new HoldReaper(ledger, {} as MeteringService, { holds: { ttlSeconds: 60, reaperIntervalSeconds } })
}

const linesStarting = (prefix: string): string[] => (Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith(prefix))
const stalledLines = (): string[] => linesStarting(STALLED_LINE)
const blockedLines = (): string[] => linesStarting(BLOCKED_LINE)

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

  /**
   * Invariant: the reaper never stops for good and never has more than two sweeps running, each of which holds a store connection until
   * the store gives it up. Each row says which scans never settle over 3000 seconds at a one-second interval, where the bound is 600
   * seconds, and what the reaper did: the scans it started, how many are still unsettled, the stall lines, the lines for a stalled sweep
   * it could not abandon while an earlier one ran, and the instant of its last scan, which shows when it stopped starting sweeps.
   */
  it.each([
    { name: 'no scan hangs', hangs: [] as number[], scans: 3000, unsettled: 0, stalled: 0, blocked: 0, lastScanAfter: 2999 },
    { name: 'one scan hangs for good', hangs: [1], scans: 2400, unsettled: 1, stalled: 1, blocked: 0, lastScanAfter: 2999 },
    { name: 'two scans hang for good', hangs: [1, 3], scans: 3, unsettled: 2, stalled: 1, blocked: 1, lastScanAfter: 602 },
    { name: 'every scan hangs for good', hangs: 'all' as const, scans: 2, unsettled: 2, stalled: 1, blocked: 1, lastScanAfter: 601 },
  ])('over 3000 seconds, when $name', async ({ hangs, scans: expectedScans, unsettled, stalled, blocked, lastScanAfter }) => {
    const { ledger, scans } = ledgerHangingAt(hangs)
    const reaper = reaperOver(ledger, 1)
    const start = Date.now()
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(3000 * 1000)
    reaper.onApplicationShutdown()
    expect({ scans: scans.total, unsettled: scans.active, stalled: stalledLines().length, blocked: blockedLines().length }).toEqual({ scans: expectedScans, unsettled, stalled, blocked })
    expect(Math.round(((scans.startedAt.at(-1) ?? start) - start) / 1000)).toBeGreaterThanOrEqual(lastScanAfter)
  })

  /** Invariant: the line for a stalled sweep that cannot be abandoned is one line per run of ticks, with no store detail. */
  it('logs the blocked ticks once, however long they last', async () => {
    const { ledger } = ledgerHangingAt('all')
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(3000 * 1000)
    reaper.onApplicationShutdown()
    expect(blockedLines()).toEqual([`${BLOCKED_LINE} two sweeps are still running, so no sweep starts until one settles`])
  })

  /** Invariant: while two sweeps run, a third is never started, and the end of either lets the reaper sweep again. */
  it('resumes when an abandoned sweep settles and never runs a third', async () => {
    const { ledger, scans, releaseNth } = hangingLedger()
    const reaper = reaperOver(ledger, 1)
    reaper.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(1300 * 1000)
    expect({ total: scans.total, active: scans.active }).toEqual({ total: 2, active: 2 })
    releaseNth(0)
    await jest.advanceTimersByTimeAsync(2_000)
    expect({ total: scans.total, active: scans.active }).toEqual({ total: 3, active: 2 })
    await jest.advanceTimersByTimeAsync(700 * 1000)
    reaper.onApplicationShutdown()
    expect({ total: scans.total, active: scans.active, stalled: stalledLines().length, blocked: blockedLines().length }).toEqual({ total: 3, active: 2, stalled: 2, blocked: 2 })
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
    expect({ blocked: blockedLines().length, stalled: stalledLines().length }).toEqual({ blocked: 0, stalled: 2 })
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
