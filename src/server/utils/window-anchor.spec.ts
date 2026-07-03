import type { BudgetWindowKind } from '../../shared'
import { resetsAtFor, windowStartFor, type WindowAnchorBudget } from './window-anchor'

/** Build a window-anchor budget input. */
function budget(window: BudgetWindowKind, over: Partial<WindowAnchorBudget> = {}): WindowAnchorBudget {
  return { window, createdAt: new Date('2026-01-15T00:00:00.000Z'), ...over }
}

/** ISO shorthand. */
function d(iso: string): Date {
  return new Date(iso)
}

describe('windowStartFor / resetsAtFor', () => {
  /** 'total' pins the window to anchorAt ?? createdAt and never resets. */
  it("handles 'total' windows", () => {
    const anchored = budget('total', { anchorAt: d('2026-03-01T00:00:00.000Z') })
    expect(windowStartFor(anchored, d('2030-01-01T00:00:00.000Z'))).toEqual(d('2026-03-01T00:00:00.000Z'))
    expect(resetsAtFor(anchored, d('2026-03-01T00:00:00.000Z'))).toBeNull()
    const unanchored = budget('total')
    expect(windowStartFor(unanchored, d('2030-01-01T00:00:00.000Z'))).toEqual(d('2026-01-15T00:00:00.000Z'))
  })

  /** Calendar day/week/month default to UTC boundaries when anchorAt is absent. */
  it('anchors calendar day/week/month to UTC boundaries', () => {
    expect(windowStartFor(budget('day'), d('2026-06-15T13:45:00.000Z'))).toEqual(d('2026-06-15T00:00:00.000Z'))
    expect(resetsAtFor(budget('day'), d('2026-06-15T00:00:00.000Z'))).toEqual(d('2026-06-16T00:00:00.000Z'))

    const weekStart = windowStartFor(budget('week'), d('2026-06-17T10:00:00.000Z'))
    expect(weekStart.getUTCDay()).toBe(0) // Sunday
    expect(weekStart.getTime()).toBeLessThanOrEqual(d('2026-06-17T10:00:00.000Z').getTime())
    expect(resetsAtFor(budget('week'), weekStart)).toEqual(new Date(weekStart.getTime() + 7 * 86_400_000))

    expect(windowStartFor(budget('month'), d('2026-06-15T00:00:00.000Z'))).toEqual(d('2026-06-01T00:00:00.000Z'))
    expect(resetsAtFor(budget('month'), d('2026-06-01T00:00:00.000Z'))).toEqual(d('2026-07-01T00:00:00.000Z'))
  })

  /** A Jan 31 monthly anchor clamps to Feb 28 then Mar 31 (the renewal-quota primitive). */
  it('clamps a Jan 31 monthly anchor to short months', () => {
    const jan31 = budget('month', { anchorAt: d('2026-01-31T00:00:00.000Z') })
    const feb = windowStartFor(jan31, d('2026-02-10T00:00:00.000Z'))
    expect(feb).toEqual(d('2026-01-31T00:00:00.000Z'))
    expect(resetsAtFor(jan31, feb)).toEqual(d('2026-02-28T00:00:00.000Z'))

    const mar = windowStartFor(jan31, d('2026-03-05T00:00:00.000Z'))
    expect(mar).toEqual(d('2026-02-28T00:00:00.000Z'))
    expect(resetsAtFor(jan31, mar)).toEqual(d('2026-03-31T00:00:00.000Z'))
  })

  /** A leap February clamps a Jan 31 anchor to Feb 29. */
  it('clamps to Feb 29 in a leap year', () => {
    const jan31 = budget('month', { anchorAt: d('2024-01-31T00:00:00.000Z') })
    const start = windowStartFor(jan31, d('2024-02-15T00:00:00.000Z'))
    expect(resetsAtFor(jan31, start)).toEqual(d('2024-02-29T00:00:00.000Z'))
  })

  /** An anchor exactly at a clamped boundary locates that window (the <= branch). */
  it('locates the window whose start equals the query instant', () => {
    const jan31 = budget('month', { anchorAt: d('2026-01-31T00:00:00.000Z') })
    expect(windowStartFor(jan31, d('2026-02-28T00:00:00.000Z'))).toEqual(d('2026-02-28T00:00:00.000Z'))
  })

  /** A query before the anchor rolls back to the prior anchored month. */
  it('handles a query before the anchor', () => {
    const jun15 = budget('month', { anchorAt: d('2026-06-15T00:00:00.000Z') })
    expect(windowStartFor(jun15, d('2026-06-10T00:00:00.000Z'))).toEqual(d('2026-05-15T00:00:00.000Z'))
  })

  /** Anchored day/week windows repeat every fixed period from the anchor instant. */
  it('anchors day/week windows to the anchor instant', () => {
    const day = budget('day', { anchorAt: d('2026-06-10T08:00:00.000Z') })
    const start = windowStartFor(day, d('2026-06-12T09:00:00.000Z'))
    expect(start).toEqual(d('2026-06-12T08:00:00.000Z'))
    expect(resetsAtFor(day, start)).toEqual(d('2026-06-13T08:00:00.000Z'))

    const week = budget('week', { anchorAt: d('2026-06-01T00:00:00.000Z') })
    expect(windowStartFor(week, d('2026-06-16T00:00:00.000Z'))).toEqual(d('2026-06-15T00:00:00.000Z'))
  })

  /** Custom-seconds windows epoch-align to anchorAt, or createdAt when absent. */
  it('handles custom-seconds windows', () => {
    const daily: BudgetWindowKind = { customSeconds: 86_400 }
    const anchored = budget(daily, { anchorAt: d('2026-06-01T00:00:00.000Z') })
    const start = windowStartFor(anchored, d('2026-06-03T12:00:00.000Z'))
    expect(start).toEqual(d('2026-06-03T00:00:00.000Z'))
    expect(resetsAtFor(anchored, start)).toEqual(d('2026-06-04T00:00:00.000Z'))

    const hourly = budget({ customSeconds: 3_600 }, { createdAt: d('2026-06-01T00:00:00.000Z') })
    expect(windowStartFor(hourly, d('2026-06-01T02:30:00.000Z'))).toEqual(d('2026-06-01T02:00:00.000Z'))
  })
})
