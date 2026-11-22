/**
 * @fileoverview What the public methods do with an argument of the right kind that cannot be used. A string with a NUL character and a
 * bigint outside what a `BIGINT` column holds are refused naming the argument, where a store would answer a store error that names
 * nothing. A date that answers once and then throws is read once at the entry, so the call completes on a copy; an object whose getter
 * throws is refused naming the field, never with the host's own error.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { AiTokensException } from './server/errors'
import { assertWalletRef, keysOf, readField } from './server/utils/argument-guards'
import { snapshotOf } from './server/utils/date-guards'

const MAX = 9_223_372_036_854_775_807n
/** The same bound as the text of a refusal. */
const LIMIT = '9223372036854775807'
const NUL = 'a\u0000b'

type Row = readonly [call: string, path: (string | number)[], value: unknown, reason: string]

const BIGINT = (name: string): string => `${name} must be a bigint from 0 to ${LIMIT}`
const NUL_REASON = (name: string): string => `${name} must not contain a NUL character`

const NUL_ROWS: Row[] = [
  ['ledger.findById', [0], NUL, NUL_REASON('id')],
  ['ledger.findByIdempotencyKey', [1], NUL, NUL_REASON('idempotencyKey')],
  ['ledger.verifyChain', [0], NUL, NUL_REASON('tenantId')],
  ['metering.getStatus', [0], NUL, NUL_REASON('tenantId')],
  ['metering.getStatus', [1, 'id'], NUL, NUL_REASON('scope.id')],
  ['metering.hold', [0, 'feature'], NUL, NUL_REASON('context.feature')],
  ['metering.reverse', [1], NUL, NUL_REASON('reason')],
  ['wallets.getBalance', [0, 'ownerId'], NUL, NUL_REASON('wallet.ownerId')],
  ['wallets.grant', [1, 'reason'], NUL, NUL_REASON('reason')],
  ['budgets.list', [0], NUL, NUL_REASON('tenantId')],
  ['budgets.removeBudget', [0], NUL, NUL_REASON('budgetId')],
  ['pricing.getPriceHistory', [1], NUL, NUL_REASON('model')],
  ['pricing.upsertPrice', [0, 'provider'], NUL, NUL_REASON('provider')],
  ['reports.summarize', [0, 'tenantId'], NUL, NUL_REASON('tenantId')],
]

const BIGINT_ROWS: Row[] = [
  ['wallets.grant', [1, 'amountNanoUsd'], MAX + 1n, `grant amount must be a bigint from 1 to ${LIMIT}`],
  ['wallets.debit', [1, 'amountNanoUsd'], MAX + 1n, `debit amount must be a bigint from 1 to ${LIMIT}`],
  ['wallets.refund', [1, 'amountNanoUsd'], 10n ** 40n, `refund amount must be a bigint from 1 to ${LIMIT}`],
  ['wallets.adjust', [1, 'amountNanoUsd'], -(10n ** 40n), `adjustment amount must be a non-zero bigint within -9223372036854775808 to ${LIMIT}`],
  ['wallets.adjust', [1, 'amountNanoUsd'], MAX + 1n, `adjustment amount must be a non-zero bigint within -9223372036854775808 to ${LIMIT}`],
  ['budgets.upsertBudget', [0, 'limitNanoUsd'], MAX + 1n, `limitNanoUsd must be a bigint from 0 to ${LIMIT} (§10.2)`],
  ['pricing.upsertPrice', [0, 'inputNanoUsdPerMillion'], MAX + 1n, BIGINT('inputNanoUsdPerMillion')],
  ['pricing.upsertPrice', [0, 'tierOutputNanoUsdPerMillion'], 10n ** 40n, BIGINT('tierOutputNanoUsdPerMillion')],
  ['metering.hold(amount)', [1, 'amountNanoUsd'], MAX + 1n, `amountNanoUsd of a hold estimate must be a bigint from 0 to ${LIMIT}`],
]

/** A date whose time methods answer their first call and throw on every later one: the guard consumes the first. */
function dateThatAnswersOnce(ms: number): Date {
  const date = new Date(ms)
  for (const method of ['getTime', 'valueOf', 'toISOString'] as const) {
    const original = Date.prototype[method] as (this: Date) => unknown
    let calls = 0
    Object.defineProperty(date, method, {
      value(this: Date): unknown {
        calls += 1
        if (calls > 1) throw new Error('host-private-text')
        return original.call(this)
      },
    })
  }
  return date
}

/** Every call and field that takes a date, and what the call needs besides it. */
const DATE_ROWS: readonly (readonly [string, (string | number)[]])[] = [
  ['budgets.upsertBudget', [0, 'anchorAt']],
  ['budgets.upsertBudget', [0, 'expiresAt']],
  ['budgets.rotateWindow', [2]],
  ['budgets.reconcileWindow', [2]],
  ['metering.record', [0, 'occurredAt']],
  ['metering.estimateCost', [0, 'at']],
  ['pricing.resolveRate', [0, 'at']],
  ['pricing.upsertPrice', [0, 'effectiveFrom']],
  ['ledger.query', [0, 'from']],
  ['ledger.sumCost', [0, 'to']],
  ['ledger.verifyChain', [1]],
  ['wallets.getEntries', [1, 'from']],
  ['wallets.grant', [1, 'effectiveAt']],
  ['wallets.grant', [1, 'expiresAt']],
  ['reports.summarize', [0, 'from']],
]

/** Every object argument whose field is read by a guard: the call, the path of the object, the field, and the name the refusal gives it. */
const GETTER_ROWS: readonly (readonly [string, (string | number)[], string, string])[] = [
  ['budgets.upsertBudget', [0], 'scope', 'scope'],
  ['budgets.upsertBudget', [0], 'id', 'id'],
  ['budgets.upsertBudget', [0], 'features', 'features'],
  ['metering.hold', [0], 'tenantId', 'context.tenantId'],
  ['metering.hold', [0], 'scope', 'context.scope'],
  ['metering.hold', [0, 'scope'], 'type', 'context.scope.type'],
  ['metering.hold', [0, 'scope'], 'id', 'context.scope.id'],
  ['metering.hold', [0], 'beneficiary', 'context.beneficiary'],
  ['metering.hold', [0], 'feature', 'context.feature'],
  ['metering.hold', [0], 'requestedBy', 'context.requestedBy'],
  ['metering.estimateCost', [0], 'provider', 'provider'],
  ['metering.estimateCost', [0], 'feature', 'feature'],
  ['metering.estimateCost', [0], 'scope', 'scope'],
  ['metering.estimateCost', [0], 'inputTokens', 'inputTokens'],
  ['metering.estimateCost', [0], 'maxOutputTokens', 'maxOutputTokens'],
  ['wallets.getBalance', [0], 'tenantId', 'wallet.tenantId'],
  ['wallets.getBalance', [0], 'ownerType', 'wallet.ownerType'],
  ['wallets.getBalance', [0], 'ownerId', 'wallet.ownerId'],
  ['metering.capture', [0], 'id', 'hold.id'],
]

/** Tenant ids the budget calls refuse: empty, not a string, and with a NUL character. */
const TENANT_ROWS: readonly (readonly [string, (string | number)[], unknown, string])[] = [
  ['budgets.upsertBudget', [0, 'tenantId'], '', 'tenantId must be a non-empty string'],
  ['budgets.removeBudget', [1], '', 'tenantId must be a non-empty string'],
  ['budgets.removeBudget', [1], 5, 'tenantId must be a non-empty string'],
  ['budgets.upsertBudget', [0, 'tenantId'], Symbol('x'), 'tenantId must be a non-empty string'],
  ['budgets.rotateWindow', [1], '', 'tenantId must be a non-empty string'],
  ['budgets.reconcileWindow', [1], '', 'tenantId must be a non-empty string'],
  ['budgets.upsertBudget', [0, 'tenantId'], NUL, NUL_REASON('tenantId')],
  ['budgets.removeBudget', [1], NUL, NUL_REASON('tenantId')],
]

/** Every object argument that is read once into a snapshot: a field whose getter answers once and throws afterwards must not fail the call. */
const ONCE_ROWS: readonly (readonly [string, (string | number)[], string])[] = [
  ['budgets.upsertBudget', [0], 'scope'],
  ['budgets.upsertBudget', [0], 'tenantId'],
  ['budgets.upsertBudget', [0], 'anchorAt'],
  ['wallets.grant', [1], 'reason'],
  ['wallets.grant', [1], 'effectiveAt'],
  ['wallets.debit', [1], 'idempotencyKey'],
  ['wallets.refund', [1], 'reason'],
  ['wallets.adjust', [1], 'amountNanoUsd'],
  ['wallets.getEntries', [1], 'limit'],
  ['wallets.getEntries', [1], 'from'],
  ['pricing.upsertPrice', [0], 'model'],
  ['pricing.upsertPrice', [0], 'effectiveFrom'],
  ['ledger.query', [0], 'tenantId'],
  ['ledger.query', [0], 'from'],
  ['reports.summarize', [0], 'tenantId'],
  ['reports.summarize', [0], 'from'],
]

/** Every object argument that is read into a snapshot by the names of its type. */
const SNAPSHOT_ROWS: readonly (readonly [string, (string | number)[]])[] = [
  ['budgets.upsertBudget', [0]],
  ['wallets.grant', [1]],
  ['wallets.debit', [1]],
  ['wallets.refund', [1]],
  ['wallets.adjust', [1]],
  ['wallets.getEntries', [1]],
  ['wallets.getBalance', [0]],
  ['pricing.upsertPrice', [0]],
  ['pricing.resolveRate', [0]],
  ['ledger.query', [0]],
  ['ledger.sumCost', [0]],
  ['reports.summarize', [0]],
  ['metering.hold', [0]],
  ['metering.hold', [0, 'scope']],
  ['metering.hold', [1]],
  ['metering.hold(amount)', [1]],
  ['metering.record', [0]],
  ['metering.record', [0, 'context']],
  ['metering.record', [0, 'context', 'scope']],
  ['metering.record', [0, 'preset']],
  ['metering.estimateCost', [0]],
  ['metering.getStatus', [1]],
  ['metering.capture', [0]],
  ['metering.capture', [0, 'scope']],
  ['metering.capture', [1]],
  ['metering.capture', [1, 'scope']],
  ['metering.capture', [3]],
  ['metering.release', [0]],
  ['metering.release', [0, 'scope']],
  ['metering.release', [1]],
  ['metering.release', [1, 'scope']],
  ['wallets.settleAdjustment', [0]],
  ['wallets.settleAdjustment', [1]],
]

function at(args: unknown[], path: (string | number)[]): Record<string | number, unknown> {
  let target: unknown = args
  for (const step of path) target = (target as Record<string | number, unknown>)[step]
  return target as Record<string | number, unknown>
}

function setAt(args: unknown[], path: (string | number)[], value: unknown): void {
  at(args, path.slice(0, -1))[path.at(-1)!] = value
}

/** The reason of the typed refusal `run` raises, or `undefined` when it is accepted; any other failure is rethrown. */
async function reasonOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    const { error: body } = error.getResponse() as { error: { code: string; details?: { reason?: string } } }
    return `${body.code} ${body.details?.reason ?? ''}`
  }
  return undefined
}

async function callOf(name: string): Promise<{ run: (args: unknown[]) => unknown; args: unknown[] }> {
  const def = (await rig()).calls[name]
  if (def === undefined) throw new Error(`no call named ${name}`)
  return { run: def.run, args: await def.base() }
}

describe('a value of the right kind that cannot be stored', () => {
  it.each([...NUL_ROWS, ...BIGINT_ROWS])('refuses %s at %j naming the argument', async (name, path, value, reason) => {
    const { run, args } = await callOf(name)
    setAt(args, path, value)
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG ${reason}`)
  })

  it.each([['wallets.grant', MAX], ['wallets.adjust', MAX], ['wallets.adjust', -MAX - 1n], ['budgets.upsertBudget', MAX]] as const)('accepts the largest amounts a column holds: %s %p', async (name, value) => {
    const { run, args } = await callOf(name)
    setAt(args, name === 'budgets.upsertBudget' ? [0, 'limitNanoUsd'] : [1, 'amountNanoUsd'], value)
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })
})

describe('a date that answers once', () => {
  /** The guard consumes the one answer; the call goes on with a copy read at the entry, so no later read throws the host's error. */
  it.each(DATE_ROWS)('is accepted by %s at %j and no later read of it throws', async (name, path) => {
    const { run, args } = await callOf(name)
    setAt(args, path, dateThatAnswersOnce(86_400_000))
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })
})

describe('a tenant id the budget calls refuse', () => {
  it.each(TENANT_ROWS)('%s at %j refuses %j', async (name, path, value, reason) => {
    const { run, args } = await callOf(name)
    setAt(args, path, value)
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG ${reason}`)
  })
})

describe('a grant date that is not valid', () => {
  it.each(['effectiveAt', 'expiresAt'])('is refused naming grant %s', async (field) => {
    const { run, args } = await callOf('wallets.grant')
    setAt(args, [1, field], new Date(Number.NaN))
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG grant ${field} must be a valid date`)
  })
})

describe('an object whose getter throws', () => {
  it.each(GETTER_ROWS)('is refused by %s at %j for the field %s, naming %s', async (name, path, field, named) => {
    const { run, args } = await callOf(name)
    Object.defineProperty(at(args, path), field, {
      get(): never {
        throw new Error('host-private-text')
      },
      enumerable: true,
    })
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG ${named} could not be read`)
  })
})

describe('an object whose getter answers once', () => {
  /** The object is read into a snapshot at the entry, so the one answer is what is checked and used, and the call completes. */
  it.each(ONCE_ROWS)('is accepted by %s at %j for the field %s', async (name, path, field) => {
    const { run, args } = await callOf(name)
    const target = at(args, path)
    const value = target[field]
    let reads = 0
    Object.defineProperty(target, field, {
      get(): unknown {
        reads += 1
        if (reads > 1) throw new Error('host-private-text')
        return value
      },
      enumerable: true,
    })
    expect(await reasonOf(() => run(args))).toBeUndefined()
    expect(reads).toBe(1)
  })
})

describe('an input read by the names of its type', () => {
  /** The fields are read by name, so the keys of the host's object are never listed: a trap for it is never reached. */
  it.each(SNAPSHOT_ROWS)('does not list the keys of the input of %s at %j', async (name, path) => {
    const { run, args } = await callOf(name)
    let listed = 0
    const original = at(args, path.slice(0, -1))[path.at(-1)!] as object
    setAt(args, path, new Proxy(original, { ownKeys(target) { listed += 1; return Reflect.ownKeys(target) } }))
    await reasonOf(() => run(args))
    expect(listed).toBe(0)
  })
})

describe('an input whose fields are accessors of its class', () => {
  /** The documented fields of a filter class that holds them as getters reach the store: the date bound still applies. */
  it('keeps a date bound that a class holds as a getter', async () => {
    const getEntries = (await rig()).calls['wallets.getEntries']
    if (getEntries === undefined) throw new Error('no call')
    const [ref] = await getEntries.base()
    class LaterThan2100 {
      get from(): Date {
        return new Date('2100-01-01T00:00:00Z')
      }
    }
    const everything = (await getEntries.run([ref, {}])) as { entries: unknown[] }
    const bounded = (await getEntries.run([ref, new LaterThan2100()])) as { entries: unknown[] }
    expect(everything.entries.length).toBeGreaterThan(0)
    expect(bounded.entries).toHaveLength(0)
  })

  /** An accessor of the class is read exactly once, whatever the checks and the uses of the call do with the field. */
  it('reads a getter of the class once', async () => {
    const { run, args } = await callOf('wallets.getEntries')
    let reads = 0
    class Counting {
      get limit(): number {
        reads += 1
        if (reads > 1) throw new Error('host-private-text')
        return 5
      }
    }
    setAt(args, [1], new Counting())
    expect(await reasonOf(() => run(args))).toBeUndefined()
    expect(reads).toBe(1)
  })

  it('keeps the fields of an object created from a prototype', async () => {
    const { run, args } = await callOf('wallets.getEntries')
    setAt(args, [1], Object.create({ limit: 'many' }))
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG limit must be a whole number of 0 or more')
  })

  /** The walk stops before `Object.prototype`, so a key added to it by another library is not read as a field of the input. */
  it('does not read a key added to Object.prototype', async () => {
    const { run, args } = await callOf('wallets.getEntries')
    setAt(args, [1], {})
    Object.defineProperty(Object.prototype, 'limit', { value: 'many', configurable: true, enumerable: false })
    try {
      expect(await reasonOf(() => run(args))).toBeUndefined()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'limit')
    }
  })

  /** A Proxy whose prototype is itself, or a chain too long to be a class hierarchy, is refused at once and never walked for ever. */
  it.each([
    ['a prototype that is the object itself', (): object => { const self: object = new Proxy({}, { getPrototypeOf: () => self }); return self }],
    ['a chain of 40 prototypes', (): object => { let proto: object = {}; for (let level = 0; level < 40; level += 1) proto = Object.create(proto) as object; return proto }],
  ])('refuses %s naming the first field read', async (_label, make) => {
    const { run, args } = await callOf('wallets.getEntries')
    setAt(args, [1], make())
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG from could not be read')
  })

  it('accepts a class hierarchy of ten levels', async () => {
    const { run, args } = await callOf('wallets.getEntries')
    let proto: object = { limit: 5 }
    for (let level = 0; level < 9; level += 1) proto = Object.create(proto) as object
    setAt(args, [1], Object.create(proto))
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })

  /** The case list of the prototype walk, one row each: every way a chain can be hostile is refused naming the input, and every way it can be odd but honest is read. */
  const HOSTILE_CHAINS: readonly (readonly [string, () => object])[] = [
    ['a getPrototypeOf trap that throws', () => new Proxy({}, { getPrototypeOf: (): never => { throw new Error('host-private-text') } })],
    ['a getPrototypeOf trap that returns a new Proxy each time', () => { const make = (): object => new Proxy({}, { getPrototypeOf: make }); return make() }],
  ]
  const HONEST_CHAINS: readonly (readonly [string, () => object])[] = [
    ['an ownKeys trap that throws, which is never called', () => new Proxy({}, { ownKeys: (): never => { throw new Error('host-private-text') } })],
    ['a prototype Proxy whose ownKeys trap throws, which is never called', () => Object.create(new Proxy({}, { ownKeys: (): never => { throw new Error('host-private-text') } })) as object],
    ['a null prototype', () => Object.assign(Object.create(null) as object, { limit: 5 })],
    ['an own __proto__ key', () => JSON.parse('{"__proto__":{"limit":"many"},"limit":5}') as object],
    ['a frozen object', () => Object.freeze({ limit: 5 })],
    ['a class that holds its fields as getters and a method', () => new (class { get limit(): number { return Number('5') }; describe(): string { return 'filter' } })()],
  ]

  it.each(HOSTILE_CHAINS)('refuses %s naming the first field read', async (_label, make) => {
    const { run, args } = await callOf('wallets.getEntries')
    setAt(args, [1], make())
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG from could not be read')
  })

  it.each(HONEST_CHAINS)('reads %s', async (_label, make) => {
    const { run, args } = await callOf('wallets.getEntries')
    setAt(args, [1], make())
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })

  it('refuses a getter of the class that throws, naming the field', async () => {
    const { run, args } = await callOf('wallets.getEntries')
    class Throwing {
      get from(): Date {
        throw new Error('host-private-text')
      }
    }
    setAt(args, [1], new Throwing())
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG from could not be read')
  })
})

describe('the fields a snapshot lists', () => {
  class Base {
    get inherited(): number {
      return Number('1')
    }
  }
  class Derived extends Base {
    own = 2
  }

  it('lists the own fields and the accessors of the class chain, and nothing from Object.prototype', () => {
    expect(keysOf({ a: 1, b: 2 }, 'input')).toEqual(['a', 'b'])
    expect(keysOf(new Derived(), 'input').sort()).toEqual(['inherited', 'own'])
  })

  it('lists a field the host defined as not enumerable, own or in a nested object', () => {
    const hidden = Object.defineProperty({ shown: 1 }, 'hiddenOwn', { get: () => Number('2'), enumerable: false })
    expect(keysOf(hidden, 'input').sort()).toEqual(['hiddenOwn', 'shown'])
    const copy = snapshotOf({ nested: hidden }, { nested: true })
    expect(Object.keys(copy.nested).sort()).toEqual(['hiddenOwn', 'shown'])
  })

  it('does not list the constructor of a class', () => {
    expect(keysOf(new Derived(), 'input')).not.toContain('constructor')
  })

  it('copies the fields named, a getter of a class among them, as enumerable data that a spread and Object.keys see', () => {
    const copy = snapshotOf(new Derived(), { inherited: true, own: true })
    expect(Object.keys(copy).sort()).toEqual(['inherited', 'own'])
    expect(Object.assign({}, copy)).toEqual({ inherited: 1, own: 2 })
  })
})

describe('a list or an object nested in an input', () => {
  const throwing = (target: unknown[]): unknown[] => new Proxy(target, { get: (): never => { throw new Error('host-private-text') } })
  const withLength = (target: unknown[], length: unknown): unknown[] => new Proxy(target, { get: (inner, key) => (key === 'length' ? length : (Reflect.get(inner, key) as unknown)) })

  const LIST_ROWS: readonly (readonly [string, (string | number)[], string, string])[] = [
    ['budgets.upsertBudget', [0], 'features', 'features'],
    ['budgets.upsertBudget', [0], 'softThresholds', 'softThresholds'],
    ['ledger.query', [0], 'status', 'status'],
    ['reports.summarize', [0], 'groupBy', 'groupBy'],
  ]

  it.each(LIST_ROWS)('refuses a Proxy list that throws at %s %j for %s', async (name, path, field, named) => {
    const { run, args } = await callOf(name)
    at(args, path)[field] = throwing(['day'])
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG ${named} could not be read`)
  })

  it.each([['a negative length', -1], ['a length that is not a number', 'many'], ['a list of two million elements', 2_000_000], ['a fraction', 1.5]])('refuses a list with %s', async (_label, length) => {
    const { run, args } = await callOf('budgets.upsertBudget')
    at(args, [0]).features = withLength(['a'], length)
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG features could not be read')
  })

  it('reads each element of a list once', async () => {
    const { run, args } = await callOf('budgets.upsertBudget')
    const reads = new Map<string, number>()
    at(args, [0]).features = new Proxy(['a', 'b'], {
      get(target, key): unknown {
        reads.set(String(key), (reads.get(String(key)) ?? 0) + 1)
        return Reflect.get(target, key) as unknown
      },
    })
    expect(await reasonOf(() => run(args))).toBeUndefined()
    expect([reads.get('length'), reads.get('0'), reads.get('1')]).toEqual([1, 1, 1])
  })

  it('reads a getter of a nested object once', async () => {
    const { run, args } = await callOf('budgets.upsertBudget')
    let reads = 0
    at(args, [0]).scope = { type: 'user', get id(): string { reads += 1; if (reads > 1) throw new Error('host-private-text'); return 'u1' } }
    expect(await reasonOf(() => run(args))).toBeUndefined()
    expect(reads).toBe(1)
  })

  it('refuses an object that contains itself, and nesting deeper than eight levels', async () => {
    const { run, args } = await callOf('budgets.upsertBudget')
    const loop: Record<string, unknown> = { type: 'user', id: 'u' }
    loop.self = loop
    at(args, [0]).scope = loop
    expect(await reasonOf(() => run(args))).toMatch(/^AI_TOKENS_INVALID_CONFIG scope.*could not be read$/)
    let deep: Record<string, unknown> = { type: 'user', id: 'u' }
    for (let level = 0; level < 9; level += 1) deep = { inner: deep }
    at(args, [0]).scope = deep
    expect(await reasonOf(() => run(args))).toMatch(/could not be read$/)
  })

  it('keeps the values of honest nested lists and objects', async () => {
    const { run, args } = await callOf('budgets.upsertBudget')
    at(args, [0]).features = ['f1', 'f2']
    at(args, [0]).softThresholds = [0.5, 1]
    at(args, [0]).scope = { type: 'user', id: 'nested' }
    const budget = (await run(args)) as { features?: string[]; softThresholds: number[]; scope: { type: string; id: string } }
    expect(budget.features).toEqual(['f1', 'f2'])
    expect(budget.softThresholds).toEqual([0.5, 1])
    expect({ ...budget.scope }).toEqual({ type: 'user', id: 'nested' })
  })

  /** The caps are refusals with the library code and the field named, on the line and one step past it, never a silent cut. */
  it.each([[100_000, undefined], [100_001, 'features could not be read']])('reads a list of %s elements: %s', async (length, refusal) => {
    const { run, args } = await callOf('budgets.upsertBudget')
    at(args, [0]).features = new Proxy([], { get: (target, key) => (key === 'length' ? length : key === 'constructor' ? Array : Reflect.get(target, key) as unknown) })
    const reason = await reasonOf(() => run(args))
    expect(reason).toBe(refusal === undefined ? 'AI_TOKENS_INVALID_CONFIG features must be a list of strings' : `AI_TOKENS_INVALID_CONFIG ${refusal}`)
  })

  it.each([[6, undefined], [7, 'scope.n1.n2.n3.n4.n5.n6.n7 could not be read']])('reads an object nested %s levels below the scope: %s', async (levels, refusal) => {
    const { run, args } = await callOf('budgets.upsertBudget')
    let nested: Record<string, unknown> = {}
    for (let level = levels; level >= 1; level -= 1) nested = { [`n${String(level)}`]: nested }
    at(args, [0]).scope = { type: 'user', id: 'u', ...nested }
    const reason = await reasonOf(() => run(args))
    expect(reason).toBe(refusal === undefined ? undefined : `AI_TOKENS_INVALID_CONFIG ${refusal}`)
  })

  it('names the element of a list that cannot be read, and the field of a nested object', async () => {
    const { run, args } = await callOf('budgets.upsertBudget')
    at(args, [0]).features = new Proxy(['a', 'b'], { get: (target, key) => { if (key === '1') throw new Error('host-private-text'); return Reflect.get(target, key) as unknown } })
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG features[1] could not be read')
    at(args, [0]).features = ['a']
    at(args, [0]).scope = { type: 'user', get id(): string { throw new Error('host-private-text') } }
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG scope.id could not be read')
  })

  it('counts the nesting of lists inside lists against the cap', async () => {
    const { run, args } = await callOf('budgets.upsertBudget')
    let nested: unknown[] = []
    for (let level = 0; level < 9; level += 1) nested = [nested]
    at(args, [0]).features = nested
    expect(await reasonOf(() => run(args))).toMatch(/^AI_TOKENS_INVALID_CONFIG features(\[0\])+ could not be read$/)
  })

  it('copies a nested object to one whose fields are enumerable', () => {
    const copy = snapshotOf({ inner: { b: 1, c: 2 } }, { inner: true })
    expect(Object.keys(copy.inner).sort()).toEqual(['b', 'c'])
  })

  /** A key of the host's object is the host's, or an end user's: it never reaches a refusal as it is. */
  describe('a hostile key of a nested object', () => {
    const HOSTILE_KEYS: readonly (readonly [string, string])[] = [
      ['a line break', 'bad\nkey SENTINEL'],
      ['a bidirectional control', 'bad\u202Ekey SENTINEL'],
      ['10000 characters', `${'k'.repeat(10_000)}SENTINEL`],
    ]

    it.each(HOSTILE_KEYS)('is written as a marker when it holds %s and its getter throws', async (_label, key) => {
      const { run, args } = await callOf('budgets.upsertBudget')
      const scope: Record<string, unknown> = { type: 'user', id: 'u' }
      Object.defineProperty(scope, key, { get: (): never => { throw new Error('host-private-text') }, enumerable: true })
      at(args, [0]).scope = scope
      expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG scope.<key> could not be read')
    })

    it.each(HOSTILE_KEYS)('is written as a marker when it holds %s and the nesting under it is too deep', async (_label, key) => {
      const { run, args } = await callOf('budgets.upsertBudget')
      let deep: Record<string, unknown> = {}
      for (let level = 0; level < 9; level += 1) deep = { [key]: deep }
      at(args, [0]).scope = { type: 'user', id: 'u', ...deep }
      const reason = (await reasonOf(() => run(args))) ?? ''
      expect(reason).toMatch(/^AI_TOKENS_INVALID_CONFIG scope(\.<key>)+ could not be read$/)
      expect(reason).not.toContain('SENTINEL')
    })

    it('is written as it is when it is a plain key', async () => {
      const { run, args } = await callOf('budgets.upsertBudget')
      const scope: Record<string, unknown> = { type: 'user', id: 'u' }
      Object.defineProperty(scope, 'plainKey1', { get: (): never => { throw new Error('host-private-text') }, enumerable: true })
      at(args, [0]).scope = scope
      expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG scope.plainKey1 could not be read')
    })

    it('is never read at the top of the input, where fields are read by the names of their type', async () => {
      const { run, args } = await callOf('budgets.upsertBudget')
      Object.defineProperty(at(args, [0]), 'bad\nkey SENTINEL', { get: (): never => { throw new Error('host-private-text') }, enumerable: true })
      expect(await reasonOf(() => run(args))).toBeUndefined()
    })
  })
})

describe('a field the host defines as not enumerable', () => {
  /** The services read a field by name, so a field defined without enumerability is still the caller's field and must reach the check and the store. */
  it.each([['ledger.query', 'tenantId', 5, 'AI_TOKENS_INVALID_CONFIG tenantId must be a string'], ['wallets.getEntries', 'limit', 'many', 'AI_TOKENS_INVALID_CONFIG limit must be a whole number of 0 or more']] as const)('reaches the check of %s for %s', async (name, field, value, reason) => {
    const { run, args } = await callOf(name)
    const target = name === 'ledger.query' ? at(args, [0]) : at(args, [1])
    Object.defineProperty(target, field, { value, enumerable: false, configurable: true })
    expect(await reasonOf(() => run(args))).toBe(reason)
  })

  it('keeps a non-enumerable field that is valid, as the same value the store sees', async () => {
    const getEntries = (await rig()).calls['wallets.getEntries']
    if (getEntries === undefined) throw new Error('no call')
    const [ref] = await getEntries.base()
    const filter = Object.defineProperty({}, 'from', { value: new Date('2100-01-01T00:00:00Z'), enumerable: false })
    const page = (await getEntries.run([ref, filter])) as { entries: unknown[] }
    expect(page.entries).toHaveLength(0)
  })
})

describe('an input from another realm', () => {
  /** A `vm` context has its own `Object.prototype`: a nested object of it is copied with its own fields and not with the methods of that root. */
  it('is copied with its own fields only, a nested object included', async () => {
    const { run, args } = await callOf('budgets.upsertBudget')
    at(args, [0]).scope = runInNewContext("({ type: 'user', id: 'foreign' })")
    const budget = (await run(args)) as { scope: Record<string, unknown> }
    expect(Object.keys(budget.scope).sort()).toEqual(['id', 'type'])
    expect(budget.scope).toEqual(expect.objectContaining({ type: 'user', id: 'foreign' }))
  })

  it('is read by name at the top of the input, with the fields of its own realm', async () => {
    const { run, args } = await callOf('wallets.getEntries')
    args[1] = runInNewContext('({ limit: 5 })')
    expect(await reasonOf(() => run(args))).toBeUndefined()
    args[1] = runInNewContext("({ limit: 'many' })")
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG limit must be a whole number of 0 or more')
  })
})

describe('the keys of a nested record', () => {
  /** The first `AiTokensException` reason a call raises, or `undefined` when it returns. */
  function refusal(run: () => unknown): string | undefined {
    try {
      run()
    } catch (error) {
      if (!(error instanceof AiTokensException)) throw error
      return (error.getResponse() as { error: { details?: { reason?: string } } }).error.details?.reason
    }
    return undefined
  }

  it('lists a class chain of 31 levels and refuses one of 40, naming the object', () => {
    const chain = (levels: number): object => {
      let proto: object = { deep: 1 }
      for (let level = 1; level < levels; level += 1) proto = Object.create(proto) as object
      return Object.create(proto) as object
    }
    expect(keysOf(chain(30), 'input')).toEqual(['deep'])
    expect(refusal(() => keysOf(chain(40), 'input'))).toBe('input could not be read')
  })

  it('refuses a chain that never ends, naming the object', () => {
    const make = (): object => new Proxy({}, { getPrototypeOf: make })
    expect(refusal(() => keysOf(make(), 'input'))).toBe('input could not be read')
  })

  it('does not list what the Object.prototype of another realm holds', () => {
    expect(keysOf(runInNewContext('({ a: 1 })') as object, 'input')).toEqual(['a'])
    expect(keysOf(runInNewContext('new (class { get g() { return 1 } })()') as object, 'input')).toEqual(['g'])
  })

  it('reads the prototype of each level of the chain once', () => {
    let reads = 0
    const level = new Proxy({ inherited: 1 }, { getPrototypeOf: (target) => { reads += 1; return Reflect.getPrototypeOf(target) } })
    expect(keysOf(Object.create(level) as object, 'input')).toEqual(['inherited'])
    expect(reads).toBe(1)
  })

  it('lists the own keys of an object with no prototype', () => {
    expect(keysOf(Object.assign(Object.create(null) as object, { only: 1 }), 'input')).toEqual(['only'])
  })

  it('names the object when a trap throws', () => {
    const hostile = new Proxy({}, { ownKeys: (): never => { throw new Error('host-private-text') } })
    expect(refusal(() => keysOf(hostile, 'record'))).toBe('record could not be read')
  })
})

describe('the reference of a wallet', () => {
  const refusal = (value: unknown): string | undefined => {
    try {
      assertWalletRef(value)
    } catch (error) {
      if (!(error instanceof AiTokensException)) throw error
      return (error.getResponse() as { error: { details?: { reason?: string } } }).error.details?.reason
    }
    return undefined
  }

  it('is refused naming the wallet, or the field that is not a string', () => {
    expect(refusal(5)).toBe('wallet must be an object')
    expect(refusal({ tenantId: 1, ownerType: 'user', ownerId: 'u' })).toBe('wallet.tenantId must be a string')
    expect(refusal({ tenantId: 't', ownerType: 1, ownerId: 'u' })).toBe('wallet.ownerType must be a string')
    expect(refusal({ tenantId: 't', ownerType: 'user', ownerId: 1 })).toBe('wallet.ownerId must be a string')
    expect(refusal({ tenantId: 't', ownerType: 'user', ownerId: 'u' })).toBeUndefined()
  })

  it.each(['tenantId', 'ownerType', 'ownerId'])('is refused by wallets.getBalance naming %s when reading it throws', async (field) => {
    const { run, args } = await callOf('wallets.getBalance')
    Object.defineProperty(args[0], field, { get: (): never => { throw new Error('host-private-text') } })
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG wallet.${field} could not be read`)
  })
})

describe('a field the host does not have', () => {
  it('is absent from the snapshot, and so is one set to undefined', () => {
    const copy = snapshotOf<{ a: number; b?: number | undefined; c?: number }>({ a: 1, b: undefined }, { a: true, b: true, c: true })
    expect(Object.keys(copy)).toEqual(['a'])
  })
})

describe('an object that answers by a get trap and holds no key of its own', () => {
  /** A Proxy over an empty target: `Object.hasOwn` says it has no key, and only its `get` trap knows the values. */
  const lazy = (source: Record<string, unknown>): object => new Proxy({}, { get: (_target, key) => source[key as string] })

  it.each([
    ['wallets.getBalance', [0], { tenantId: 't', ownerType: 'user', ownerId: 'u' }],
    ['budgets.status', [1], { type: 'user', id: 'u' }],
    ['budgets.list', [1], { type: 'user', id: 'u' }],
  ] as const)('is read by %s at %j', async (name, path, source) => {
    const { run, args } = await callOf(name)
    const own = { ...at(args, path.slice(0, -1))[path.at(-1)!] as object, ...source }
    setAt(args, [...path], lazy(own))
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })

  it('is read by pricing.resolveRate', async () => {
    const { run, args } = await callOf('pricing.resolveRate')
    setAt(args, [0], lazy({ ...(args[0] as object), model: 'gpt-4o' }))
    expect(await reasonOf(() => run(args))).toBeUndefined()
  })

  it('keeps a field of a filter, so that a value that is not valid is refused and not dropped', async () => {
    const { run, args } = await callOf('wallets.getEntries')
    setAt(args, [1], lazy({ limit: 'many' }))
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG limit must be a whole number of 0 or more')
  })

  it('keeps the elements of a list whose length and elements are answered by the trap', async () => {
    const { run, args } = await callOf('ledger.query')
    const answered = (items: string[]): object => new Proxy([], { get: (_target, key) => (key === 'length' ? items.length : items[Number(key)]) })
    setAt(args, [0, 'features'], answered(['f']))
    expect(((await run(args)) as unknown[]).length).toBeGreaterThan(0)
    setAt(args, [0, 'features'], answered(['no-such-feature']))
    expect(await run(args)).toEqual([])
  })
})

describe('a chain that ends in an object the host built', () => {
  it('gives up the keys of a null-prototype object that ends the chain, whatever its constructor says, and keeps its own', () => {
    const ancestor = Object.assign(Object.create(null) as object, { constructor: function Own() { return 1 }, surcharge: 7 })
    const child = Object.create(ancestor) as object
    expect(keysOf(child, 'input')).toEqual([])
    expect(readField(child, 'surcharge', 'input')).toBeUndefined()
    expect(readField(child, 'constructor', 'input')).toBeUndefined()
    expect(readField(ancestor, 'surcharge', 'input')).toBe(7)
    expect(keysOf(Object.assign(Object.create(ancestor) as object, { own: 1 }), 'input')).toEqual(['own'])
  })

  it('keeps a method a class shares with the root, and the fields of an object that is the root itself', () => {
    class Shared {
      toString(): string {
        return 'own'
      }
    }
    expect(readField(new Shared(), 'toString', 'input')).toBe(Shared.prototype.toString)
    expect(readField(Object.prototype, 'hasOwnProperty', 'input')).toBe(Object.prototype.hasOwnProperty)
  })

  /** A realm: its `Object.prototype`, and a host object that is made in that same realm, so that the pollution is the one the object inherits. */
  function realmOf(name: 'this realm' | 'another realm'): { root: Record<string, unknown>; host: () => object } {
    if (name === 'this realm') return { root: Object.prototype as unknown as Record<string, unknown>, host: () => ({ a: 1 }) }
    const context = createContext({})
    return { root: runInContext('Object.prototype', context) as Record<string, unknown>, host: () => runInContext('({ a: 1 })', context) as object }
  }

  it.each(['this realm', 'another realm'] as const)('does not read a key planted on the Object.prototype of %s after its constructor is overwritten or deleted', (name) => {
    const { root: prototype, host } = realmOf(name)
    const saved = Object.getOwnPropertyDescriptor(prototype, 'constructor')
    const planted = ['isSystemCost', 'limit']
    try {
      for (const key of planted) Object.defineProperty(prototype, key, { value: 1, configurable: true, writable: true, enumerable: false })
      expect(Object.getPrototypeOf(host())).toBe(prototype)
      expect((host() as Record<string, unknown>).isSystemCost).toBe(1)
      for (const change of [() => Object.defineProperty(prototype, 'constructor', { value: 5, configurable: true, writable: true }), () => Reflect.deleteProperty(prototype, 'constructor')]) {
        change()
        expect(readField(host(), 'isSystemCost', 'input')).toBeUndefined()
        expect(readField(host(), 'a', 'input')).toBe(1)
        expect(keysOf(host(), 'input')).toEqual(['a'])
      }
    } finally {
      for (const key of planted) Reflect.deleteProperty(prototype, key)
      if (saved !== undefined) Object.defineProperty(prototype, 'constructor', saved)
    }
  })

  it('still skips the Object.prototype of the realm and of another realm', () => {
    expect(readField(runInNewContext('({})') as object, 'toString', 'input')).toBeUndefined()
    expect(readField({}, 'toString', 'input')).toBeUndefined()
    expect(keysOf(Object.create(runInNewContext('({ a: 1 })') as object) as object, 'input')).toEqual(['a'])
  })
})
