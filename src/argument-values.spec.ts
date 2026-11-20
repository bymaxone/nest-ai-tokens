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

/** Every object argument whose field is read by a guard: the call, the path of the object, and the field. */
const GETTER_ROWS: readonly (readonly [string, (string | number)[], string])[] = [
  ['budgets.upsertBudget', [0], 'scope'],
  ['budgets.upsertBudget', [0], 'id'],
  ['budgets.upsertBudget', [0], 'features'],
  ['metering.hold', [0], 'tenantId'],
  ['metering.hold', [0, 'scope'], 'type'],
  ['metering.hold', [0], 'requestedBy'],
  ['metering.estimateCost', [0], 'inputTokens'],
  ['wallets.getBalance', [0], 'ownerId'],
  ['metering.capture', [0], 'id'],
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

describe('an object whose getter throws', () => {
  it.each(GETTER_ROWS)('is refused by %s at %j naming the field %s', async (name, path, field) => {
    const { run, args } = await callOf(name)
    Object.defineProperty(at(args, path), field, {
      get(): never {
        throw new Error('host-private-text')
      },
      enumerable: true,
    })
    const reason = await reasonOf(() => run(args))
    expect(reason).toMatch(/^AI_TOKENS_INVALID_CONFIG .* could not be read$/)
    expect(reason).toContain(field)
    expect(reason).not.toContain('host-private-text')
  })
})
