/**
 * @fileoverview What every public method does with an argument of the wrong kind. Each call below is made once per argument and
 * once per field of an object argument, with each of eight hostile values (a string, a symbol, a function, an object that
 * converts itself to the sentinel, an array, an object with a getter, an invalid Date and a bigint) put in its place. A call may
 * accept the value or refuse it with the typed error; it may not fail with a raw `TypeError`, `RangeError` or `SyntaxError`, and
 * its message, its stack and its string form never carry the value. Only the `details` of a typed error may carry it, and only a
 * string that is an identifier the caller holds, which is the documented echo. A method added without a call here is a method
 * whose argument checks nobody decided about: this is the place to decide them.
 * @layer server
 */

import { inspect } from 'node:util'
import { rig } from '../test/fakes/call-registry'
import { AiTokensException } from './server/errors'

/** The value every hostile argument converts to, so that finding it in an error shows the error repeated the argument. */
const SENTINEL = 'SENTINEL_7c3f91'

/** The hostile values: each is made fresh for each call, because a call may keep or consume what it is given. */
const HOSTILE: Readonly<Record<string, () => unknown>> = {
  string: () => SENTINEL,
  symbol: () => Symbol(SENTINEL),
  function: () => Object.assign(() => 1, { toString: () => SENTINEL }),
  toStringObj: () => ({ toString: () => SENTINEL, toJSON: () => SENTINEL, valueOf: () => SENTINEL }),
  array: () => [SENTINEL, { a: SENTINEL }],
  getterObj: () => ({ get a() { return SENTINEL }, toString: () => SENTINEL }),
  date: () => Object.assign(new Date(Number.NaN), { note: SENTINEL, toString: () => SENTINEL }),
  bigint: () => 7777777777777777777n,
}

/** The digits of the hostile bigint, which a message could carry in place of the sentinel. */
const DIGITS = '7777777777777777777'

/** A plain object: not an array, a date or null, so its fields are arguments too. */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

/** The paths of every argument and of the fields of every object argument, two levels deep, not into a provider preset. */
function pathsOf(args: unknown[]): (string | number)[][] {
  const out: (string | number)[][] = []
  args.forEach((arg, index) => {
    out.push([index])
    if (!isObject(arg)) return
    for (const [name, inner] of Object.entries(arg)) {
      out.push([index, name])
      if (isObject(inner) && name !== 'preset') for (const deeper of Object.keys(inner)) out.push([index, name, deeper])
    }
  })
  return out
}

/** Put `value` at `path` in the arguments. */
function setAt(args: unknown[], path: (string | number)[], value: unknown): void {
  let target: unknown = args
  for (const step of path.slice(0, -1)) target = (target as Record<string | number, unknown>)[step]
  ;(target as Record<string | number, unknown>)[path.at(-1)!] = value
}

/** The text a surface of an error shows, or an empty string when reading the surface itself throws. */
function show(read: () => unknown): string {
  try {
    const value = read()
    return typeof value === 'string' ? value : JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner))
  } catch {
    return ''
  }
}

const carries = (text: string): boolean => text.includes(SENTINEL) || text.includes(DIGITS)

/** What went wrong with one outcome: a raw failure, or a surface that repeats the value; `undefined` when it is fine. */
function problemWith(error: unknown, hostile: string): string | undefined {
  if (error === undefined) return undefined
  if (!(error instanceof AiTokensException)) return `raw ${error instanceof Error ? error.name : typeof error}`
  const surfaces = { message: show(() => error.message), stack: show(() => error.stack), string: show(() => String(error)), inspected: show(() => inspect(error, { depth: 0 })) }
  const leaked = Object.entries(surfaces).find(([, text]) => carries(text))
  if (leaked !== undefined) return `repeats the value in its ${leaked[0]}`
  // The details of a typed error may carry a string the caller holds as an identifier, and nothing else.
  const published = show(() => error.getResponse())
  // The amount a caller asked a wallet to debit is part of the documented details of the refusal for funds it does not have.
  if (hostile === 'bigint' && published.includes('AI_TOKENS_INSUFFICIENT_CREDITS')) return undefined
  return hostile !== 'string' && carries(published) ? 'repeats the value in its response' : undefined
}

describe('every public method, given an argument of the wrong kind', () => {
  const names = ['metering.hold', 'metering.hold(amount)', 'metering.record', 'metering.estimateCost', 'metering.getStatus', 'metering.reverse', 'metering.capture', 'metering.release', 'wallets.getBalance', 'wallets.grant', 'wallets.debit', 'wallets.refund', 'wallets.adjust', 'wallets.getEntries', 'wallets.reconcile', 'budgets.upsertBudget', 'budgets.rotateWindow', 'budgets.reconcileWindow', 'budgets.list', 'budgets.status', 'budgets.removeBudget', 'ledger.findById', 'ledger.findByIdempotencyKey', 'ledger.query', 'ledger.sumCost', 'ledger.verifyChain', 'reports.summarize', 'pricing.resolveRate', 'pricing.upsertPrice', 'pricing.getPriceHistory']

  it('has a call for every method the matrix names', async () => {
    expect(Object.keys((await rig()).calls).sort()).toEqual([...names].sort())
  })

  it.each(names)('%s succeeds with the arguments the matrix starts from', async (name) => {
    const def = (await rig()).calls[name]
    if (def === undefined) throw new Error(`no call named ${name}`)
    try {
      await def.run(await def.base())
    } catch (error) {
      throw new Error(`${name}: ${error instanceof AiTokensException ? JSON.stringify(error.getResponse()) : String(error)}`)
    }
  })

  it.each(names)('%s fails with a typed error that repeats no value, or accepts it', async (name) => {
    const { calls } = await rig()
    const def = calls[name]
    if (def === undefined) throw new Error(`no call named ${name}`)
    const problems: string[] = []
    for (const path of pathsOf(await def.base())) {
      for (const [hostile, make] of Object.entries(HOSTILE)) {
        const args = await def.base()
        setAt(args, path, make())
        let error: unknown
        try {
          await def.run(args)
        } catch (thrown) {
          error = thrown
        }
        const problem = problemWith(error, hostile)
        if (problem !== undefined) problems.push(`${name} argument ${path.join('.')} as ${hostile}: ${problem}`)
      }
    }
    if (problems.length > 0) throw new Error(`${String(problems.length)} problems:\n${problems.join('\n')}`)
  })
})
