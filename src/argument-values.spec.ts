/**
 * @fileoverview What the public methods do with an argument of the right kind that cannot be used. A string with a NUL character and a
 * bigint outside what a `BIGINT` column holds are refused naming the argument, where a store would answer a store error that names
 * nothing. A date that answers once and then throws is read once at the entry, so the call completes on a copy; an object whose getter
 * throws is refused naming the field, never with the host's own error.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { AiTokensException } from './server/errors'

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

/** Every object argument that is listed into a snapshot, and what its refusal calls it when listing its keys throws. */
const KEYS_ROWS: readonly (readonly [string, (string | number)[], string])[] = [
  ['budgets.upsertBudget', [0], 'input'],
  ['wallets.grant', [1], 'grant input'],
  ['wallets.debit', [1], 'input'],
  ['wallets.refund', [1], 'input'],
  ['wallets.adjust', [1], 'input'],
  ['wallets.getEntries', [1], 'input'],
  ['pricing.upsertPrice', [0], 'input'],
  ['ledger.query', [0], 'input'],
  ['ledger.sumCost', [0], 'input'],
  ['reports.summarize', [0], 'input'],
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

describe('an object whose keys cannot be listed', () => {
  it.each(KEYS_ROWS)('is refused by %s at %j naming %s', async (name, path, named) => {
    const { run, args } = await callOf(name)
    const hostile = new Proxy({}, {
      ownKeys(): never {
        throw new Error('host-private-text')
      },
    })
    setAt(args, path, hostile)
    expect(await reasonOf(() => run(args))).toBe(`AI_TOKENS_INVALID_CONFIG ${named} could not be read`)
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
  ])('refuses %s naming the input', async (_label, make) => {
    const { run, args } = await callOf('wallets.getEntries')
    setAt(args, [1], make())
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG input could not be read')
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
    ['an ownKeys trap that throws', () => new Proxy({}, { ownKeys: (): never => { throw new Error('host-private-text') } })],
    ['a prototype Proxy whose ownKeys trap throws', () => Object.create(new Proxy({}, { ownKeys: (): never => { throw new Error('host-private-text') } })) as object],
    ['a getPrototypeOf trap that returns a new Proxy each time', () => { const make = (): object => new Proxy({}, { getPrototypeOf: make }); return make() }],
  ]
  const HONEST_CHAINS: readonly (readonly [string, () => object])[] = [
    ['a null prototype', () => Object.assign(Object.create(null) as object, { limit: 5 })],
    ['an own __proto__ key', () => JSON.parse('{"__proto__":{"limit":"many"},"limit":5}') as object],
    ['a frozen object', () => Object.freeze({ limit: 5 })],
    ['a class that holds its fields as getters and a method', () => new (class { get limit(): number { return Number('5') }; describe(): string { return 'filter' } })()],
  ]

  it.each(HOSTILE_CHAINS)('refuses %s naming the input', async (_label, make) => {
    const { run, args } = await callOf('wallets.getEntries')
    setAt(args, [1], make())
    expect(await reasonOf(() => run(args))).toBe('AI_TOKENS_INVALID_CONFIG input could not be read')
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
