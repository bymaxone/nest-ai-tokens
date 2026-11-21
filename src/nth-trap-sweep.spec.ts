/**
 * @fileoverview The Nth-trap sweep. Every object a host passes to a public method is wrapped in a Proxy whose Nth trap throws (any
 * `get`, `has`, `ownKeys`, `getOwnPropertyDescriptor` or `getPrototypeOf` on it or on anything read from it), and N is counted up from
 * 1 until a run reaches fewer than N traps. Each run must end accepted or in the typed refusal, never in the host's own error, so a
 * read of host data that the guards did not make once, and make safe, shows up here at the first N that reaches it, without a
 * hand-written case for it.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { AiTokensException } from './server/errors'

const SECRET = 'host-private-text'
const MAX_TRAPS = 400

/** A counter shared by every Proxy of one run: the trap number that throws, and how many traps ran. */
interface Run {
  failAt: number
  traps: number
}

/** Wrap a value, and everything read from it, so that the `failAt`-th trap of the run throws. */
function hostile<T>(value: T, run: Run): T {
  if (typeof value !== 'object' || value === null || value instanceof Date) return value
  const trap = (): void => {
    run.traps += 1
    if (run.traps === run.failAt) throw new Error(SECRET)
  }
  return new Proxy(value, {
    get(target, key) {
      trap()
      return hostile(Reflect.get(target, key) as unknown, run)
    },
    has(target, key) {
      trap()
      return Reflect.has(target, key)
    },
    ownKeys(target) {
      trap()
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, key) {
      trap()
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    getPrototypeOf(target) {
      trap()
      return Reflect.getPrototypeOf(target)
    },
  })
}

/** How a run ended: accepted, refused with the typed error, or failed with anything else (the thing the sweep looks for). */
async function outcome(run: () => unknown): Promise<'accepted' | 'refused' | 'host error'> {
  try {
    await run()
    return 'accepted'
  } catch (error) {
    return error instanceof AiTokensException ? 'refused' : 'host error'
  }
}

/** The object arguments of each call, by position, that the sweep wraps. */
async function objectArgs(name: string): Promise<number[]> {
  const def = (await rig()).calls[name]
  if (def === undefined) throw new Error(`no call named ${name}`)
  const args = await def.base()
  return args.flatMap((arg, index) => (typeof arg === 'object' && arg !== null && !(arg instanceof Date) ? [index] : []))
}

/**
 * The arguments whose live reads the guards do not make once yet, by call and position. Each entry is a gap with a name: the sweep fails
 * when an argument that is not listed leaks, and when a listed one no longer leaks, so the list only ever shrinks.
 */
const KNOWN_GAPS: readonly string[] = [
  'metering.hold arg 0',
  'metering.hold arg 1',
  'metering.hold(amount) arg 0',
  'metering.hold(amount) arg 1',
  'metering.record arg 0',
  'metering.estimateCost arg 0',
  'metering.capture arg 0',
  'metering.capture arg 1',
  'metering.capture arg 2',
  'metering.capture arg 3',
  'metering.release arg 0',
  'metering.release arg 1',
]

/** The call and the position of every object argument of every call. */
async function allObjectArgs(): Promise<string[]> {
  const names = Object.keys((await rig()).calls)
  const keys: string[] = []
  for (const name of names) for (const index of await objectArgs(name)) keys.push(`${name} arg ${String(index)}`)
  return keys
}

/** The traps, in order, at which a call throws the host's own error, for the object argument at `index`. */
async function leaksOf(name: string, index: number): Promise<number[]> {
  const leaks: number[] = []
  for (let failAt = 1; failAt <= MAX_TRAPS; failAt += 1) {
    const def = (await rig()).calls[name]
    if (def === undefined) throw new Error(`no call named ${name}`)
    const args = await def.base()
    const run: Run = { failAt, traps: 0 }
    args[index] = hostile(args[index], run)
    const result = await outcome(() => def.run(args))
    if (run.traps < failAt) break
    if (result === 'host error') leaks.push(failAt)
  }
  return leaks
}

describe('the Nth trap of a host object', () => {
  it('has more than thirty object arguments of the registry to sweep', async () => {
    expect((await allObjectArgs()).length).toBeGreaterThan(30)
  })

  it('leaks the host error from no argument that is not a named gap, and from every named gap', async () => {
    const unexpected: string[] = []
    const mended: string[] = []
    for (const key of await allObjectArgs()) {
      const [name, index] = key.split(' arg ') as [string, string]
      const leaks = await leaksOf(name, Number(index))
      const gap = KNOWN_GAPS.includes(key)
      if (leaks.length > 0 && !gap) unexpected.push(`${key}: first at trap ${String(leaks[0])}`)
      if (leaks.length === 0 && gap) mended.push(key)
    }
    expect({ unexpected, mended }).toEqual({ unexpected: [], mended: [] })
  }, 600_000)
})
