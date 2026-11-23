/**
 * @fileoverview What the guard around a store changes: every argument and every resolved row is a copy that holds only what it has, a store
 * is guarded once, and nothing else about the store changes: its methods, its properties and the methods it does not have.
 * @layer server
 */

import { types } from 'node:util'
import { guardedStore } from './guarded-store'
import { setRealmGuard } from './prototype-guard'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them; the guard is proven in prototype-guard.spec.ts.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

/** A store whose rows are class instances and plain objects, and that keeps what it was handed. */
class Store {
  readonly kept: unknown[] = []
  readonly label = 'store'

  find(): Promise<{ id: string; nested: { n: number } }> {
    return Promise.resolve({ id: 'r1', nested: { n: 1 } })
  }

  findSync(): { id: string } {
    return { id: 'sync' }
  }

  keep(input: unknown): Promise<void> {
    this.kept.push(input)
    return Promise.resolve()
  }
}

describe('guardedStore', () => {
  it('hands the store a copy of each argument and the caller a copy of each resolved row', async () => {
    const store = new Store()
    const guarded = guardedStore(store)
    const input = { a: 1 }
    await guarded.keep(input)
    expect(store.kept[0]).not.toBe(input)
    expect(Object.getPrototypeOf(store.kept[0])).toBeNull()
    const row = await guarded.find()
    expect(Object.getPrototypeOf(row)).toBeNull()
    expect(Object.getPrototypeOf(row.nested)).toBeNull()
    expect(row).toEqual(expect.objectContaining({ id: 'r1' }))
  })

  it('copies a row a method returns without a promise', () => {
    const row = guardedStore(new Store()).findSync()
    expect(Object.getPrototypeOf(row)).toBeNull()
    expect(row.id).toBe('sync')
  })

  it('does not find a key planted on Object.prototype on a row, and does not take a planted function for a method', async () => {
    Object.defineProperty(Object.prototype, 'extraUnits', { value: { planted: 1 }, configurable: true, writable: true, enumerable: false })
    Object.defineProperty(Object.prototype, 'summarize', { value: () => 'planted', configurable: true, writable: true, enumerable: false })
    try {
      const guarded = guardedStore(new Store())
      expect((await guarded.find() as Record<string, unknown>).extraUnits).toBeUndefined()
      expect((guarded as unknown as Record<string, unknown>).summarize).toBeUndefined()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'extraUnits')
      Reflect.deleteProperty(Object.prototype, 'summarize')
    }
  })

  it('answers a property that is not a method, and a symbol, as the store does', () => {
    const store = new Store()
    const guarded = guardedStore(store)
    expect(guarded.label).toBe('store')
    expect(Reflect.get(guarded, Symbol.toStringTag)).toBe(Reflect.get(store, Symbol.toStringTag))
  })

  it('calls the method the store has now, so a method put in its place is the one that runs', async () => {
    const store = new Store()
    const guarded = guardedStore(store)
    jest.spyOn(store, 'find').mockResolvedValue({ id: 'spied', nested: { n: 2 } })
    expect((await guarded.find()).id).toBe('spied')
  })

  it('guards a store once, however many services are given it', () => {
    const store = new Store()
    const once = guardedStore(store)
    expect(guardedStore(once)).toBe(once)
    expect(guardedStore(store)).not.toBe(once)
  })

  /** A row is a record: a `then` field of its own does not make it a promise, and it is not awaited. */
  it('returns a row with a then of its own as a row, and awaits a promise and an object that is no record', async () => {
    const row = { id: 'r1', then: (resolve: (value: string) => void): void => resolve('output') }
    class Entity {
      readonly id = 'e1'
    }
    const store = {
      entity: (): unknown => new Entity(),
      row: (): unknown => row,
      promise: (): Promise<{ id: string }> => Promise.resolve({ id: 'p1' }),
      builder: (): unknown => new (class Query {
        then(resolve: (value: { id: string }) => void): void {
          resolve({ id: 'q1' })
        }
      })(),
    }
    const guarded = guardedStore(store)
    const returned = guarded.row() as { id: string }
    // An instance of a class with no then is a record: it comes back at once, as a copy, and is not wrapped in a promise.
    const entity = guarded.entity()
    expect(types.isPromise(entity)).toBe(false)
    expect((entity as { id: string }).id).toBe('e1')
    expect(returned.id).toBe('r1')
    expect(await guarded.promise()).toEqual({ id: 'p1' })
    // The guard itself awaits what is no record and has a then: it hands back a promise of the copy, not the builder.
    const built = guarded.builder()
    expect(types.isPromise(built)).toBe(true)
    expect(await (built as Promise<{ id: string }>)).toEqual({ id: 'q1' })
  })

  /** A row nested deeper than a store returns is refused with the library's error and never handed on uncopied, in either direction. */
  it('refuses a row and an argument nested too deep with the typed error, and passes a getter\'s own error through', () => {
    let deep: unknown = { id: 'leaf' }
    for (let level = 0; level < 10; level += 1) deep = { next: deep }
    const guarded = guardedStore({
      keep: (input: unknown): Promise<unknown> => Promise.resolve(input),
      returns: (): unknown => deep,
      scalar: (): number | null => null,
      broken: (): unknown => ({ get id(): string { throw new TypeError('own getter failure') } }),
    })
    const nameOf = (run: () => unknown): string => {
      try {
        run()
      } catch (error) {
        return (error as Error).name
      }
      return 'none'
    }
    expect(nameOf(() => guarded.returns())).toBe('AiTokensException')
    expect(nameOf(() => guarded.keep(deep))).toBe('AiTokensException')
    expect(guarded.scalar()).toBeNull()
    expect(nameOf(() => guarded.broken())).toBe('TypeError')
  })

  /** A store the host froze cannot have its properties changed, and the proxy must not have to: its methods are still wrapped. */
  it('guards a frozen plain-object store and a store with a method that is not configurable', async () => {
    const frozen = Object.freeze({ findById: (id: string): Promise<{ id: string }> => Promise.resolve({ id }), label: 'frozen' })
    const guarded = guardedStore(frozen)
    const row = await guarded.findById('r1')
    expect(Object.getPrototypeOf(row)).toBeNull()
    expect(row.id).toBe('r1')
    expect(guarded.label).toBe('frozen')
    const sealed = Object.defineProperty({}, 'find', { value: (): { id: string } => ({ id: 's1' }), writable: false, configurable: false, enumerable: true }) as { find(): { id: string } }
    expect(Object.getPrototypeOf(guardedStore(sealed).find())).toBeNull()
  })

  /** The engine reads the fields of the descriptor a trap returns through its prototype chain: a planted `get` or `set` made `Object.hasOwn` throw. */
  it.each(['get', 'set', 'value', 'writable'])('answers a question about a descriptor when %s is planted on Object.prototype, without throwing', (key) => {
    const store = { find: (): number => 1, label: 'store' }
    const guarded = guardedStore(store)
    Object.defineProperty(Object.prototype, key, { value: key === 'get' || key === 'set' ? (): number => 1 : true, configurable: true, writable: true })
    try {
      expect(Object.hasOwn(guarded, 'find')).toBe(true)
      expect(Object.hasOwn(guarded, 'absent')).toBe(false)
      expect(Reflect.getOwnPropertyDescriptor(guarded, 'label')?.value).toBe('store')
      expect(Object.keys(guarded)).toEqual(['find', 'label'])
    } finally {
      Reflect.deleteProperty(Object.prototype, key)
    }
  })

  it('answers the questions about its keys and its names as the store does', () => {
    class Store {
      readonly label = 'store'
      find(): { id: string } {
        return { id: 'c1' }
      }
    }
    const store = new Store()
    const guarded = guardedStore(store)
    expect('find' in guarded).toBe(true)
    expect('absent' in guarded).toBe(false)
    expect(Object.keys(guarded)).toEqual(['label'])
    expect(Object.getPrototypeOf(guarded)).toBe(Store.prototype)
    expect(Object.getOwnPropertyDescriptor(guarded, 'label')?.value).toBe('store')
    expect(Object.getOwnPropertyDescriptor(guarded, 'absent')).toBeUndefined()
  })

  it('lets what a method throws through, as the store raised it', () => {
    const store = { fail: (): never => { throw new Error('boom') } }
    expect(() => guardedStore(store).fail()).toThrow('boom')
  })
})
