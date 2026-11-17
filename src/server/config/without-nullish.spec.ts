/**
 * @fileoverview `withoutNullish` returns a copy of the module options in which a key that holds `undefined` or `null` is absent,
 * at the top level and inside each group, so the copy never carries a key that only looks present. Each case lists the keys of
 * the copy and compares them with the keys that hold a value.
 * @layer server
 */

import { makeFullStore } from '../../../test/fakes/full-store'
import { withoutNullish } from './without-nullish'

describe('withoutNullish', () => {
  const store = makeFullStore(true)

  /** A key holding undefined or null is absent from the copy, not present with that value. */
  it.each([undefined, null])('leaves a top-level key that holds %p out of the copy', (value) => {
    const copy = withoutNullish({ store, tokenizer: value, scopeResolver: value, markup: 2 } as never)
    expect(Object.keys(copy).sort()).toEqual(['markup', 'store'])
  })

  it.each([undefined, null])('leaves a key of a group that holds %p out of the group', (value) => {
    const copy = withoutNullish({ store, holds: { ttlSeconds: value, reaperIntervalSeconds: 60 }, telemetry: { sink: value, metrics: false } } as never)
    expect(Object.keys(copy.holds ?? {})).toEqual(['reaperIntervalSeconds'])
    expect(Object.keys(copy.telemetry ?? {})).toEqual(['metrics'])
  })

  /** A group that is not an object, such as a string, is left as it is for the validators. */
  it('leaves a group that is a string or an array as it was given', () => {
    expect(withoutNullish({ store, holds: 'x' } as never).holds).toBe('x')
    const list: unknown[] = []
    expect(withoutNullish({ store, holds: list } as never).holds).toBe(list)
  })

  /** A group that is a class instance is read through its prototype, so a getter counts as a key. */
  it('reads the getters of a class-instance group', () => {
    class Holds {
      constructor(private readonly seconds: number) {}
      get ttlSeconds(): number {
        return this.seconds
      }
    }
    expect(withoutNullish({ store, holds: new Holds(30) }).holds).toEqual({ ttlSeconds: 30 })
  })
})
