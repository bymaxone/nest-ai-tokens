/**
 * @fileoverview A snapshot reads what a shape says and nothing the realm adds: the parts of a shape (`nested`, `raw`, `limits`) and the entry
 * of each are the shape's own, so a key planted on `Object.prototype` under their names changes no snapshot and refuses no call, and a `get`
 * or a `set` planted there does not reach the descriptors the snapshot is built with.
 * @layer server
 */

import { readShape } from './date-guards'
import { setRealmGuard } from './prototype-guard'
import { viewOf } from './usage-view'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it. */
function planted<T>(key: string, value: unknown, run: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

const SHAPE = { fields: { id: true, tags: true, extraUnits: true, unitRates: true, inner: true }, nested: { inner: { fields: { n: true } } } }
const INPUT = { id: 'r1', tags: ['a'], extraUnits: { web_search: 7 }, unitRates: { web_search: 5n }, inner: { n: 1 } }

/** The snapshot of the input as the shape describes it, with nothing planted. */
const CLEAN = readShape(INPUT, SHAPE, '')

describe('readShape beneath a polluted realm', () => {
  it.each([
    ['nested', { extraUnits: { fields: {} }, unitRates: { fields: {} } }],
    ['raw', ['id', 'extraUnits']],
    ['raw', 5],
    ['limits', { extraUnits: 0, tags: 0, unitRates: 0 }],
    ['limits', new Proxy({}, { get: () => 0 })],
    ['extraUnits', { fields: {} }],
    ['unitRates', { fields: {} }],
    ['tags', { fields: {} }],
    ['usage', 5],
  ])('reads the same snapshot when %s is planted', (key, value) => {
    const snapshot = planted(key, value, () => readShape(INPUT, SHAPE, ''))
    expect(snapshot).toEqual(CLEAN)
    expect(Object.getPrototypeOf(snapshot)).toBeNull()
  })

  it('reads the same snapshot of a shape that lists a nested part when a key named like a field is planted on Object.prototype', () => {
    const shape = { fields: { extraUnits: true, inner: true }, nested: { inner: { fields: { n: true } } } }
    const snapshot = planted('extraUnits', { fields: {} }, () => readShape({ extraUnits: { web_search: 7 }, inner: { n: 2 } }, shape, ''))
    expect(snapshot).toEqual({ extraUnits: { web_search: 7 }, inner: { n: 2 } })
  })

  it.each(['get', 'set', 'value', 'writable', 'enumerable', 'configurable'])('builds the snapshot when %s is planted, whether a value or an accessor', (key) => {
    const snapshot = planted(key, key === 'get' || key === 'set' ? (): number => 1 : true, () => readShape(INPUT, SHAPE, ''))
    expect(snapshot).toEqual(CLEAN)
  })
})

describe('the view of a raw response beneath a polluted realm', () => {
  it.each(['get', 'set', 'value', 'writable'])('lists the fields of an object, a list and a class instance when %s is planted, as it does when nothing is', (key) => {
    class Response {
      readonly model = 'gpt-5'
    }
    const objects = [{ model: 'gpt-5', usage: { n: 1 } }, ['a', 'b'], new Response()]
    const clean = objects.map((raw) => Object.keys(viewOf(raw)))
    const planted_ = objects.map((raw) => planted(key, key === 'get' || key === 'set' ? (): number => 1 : true, () => Object.keys(viewOf(raw))))
    expect(planted_).toEqual(clean)
  })
})
