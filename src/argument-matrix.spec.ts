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
import { makeFullStore } from '../test/fakes/full-store'
import { InMemoryLedgerStore } from '../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../test/fakes/in-memory-wallet-store'
import { TENANT, USER_SCOPE, makeService } from '../test/fakes/budget-fixtures'
import { applyDefaults } from './server/config'
import { AiTokensException } from './server/errors'
import { providerPresets } from './server/config/provider-presets'
import { LedgerService } from './server/services/ledger.service'
import { MarkupResolver } from './server/services/markup.resolver'
import { MeteringService } from './server/services/metering.service'
import { PricingService } from './server/services/pricing.service'
import { UsageReportService } from './server/services/usage-report.service'
import { WalletService } from './server/services/wallet.service'

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

/** The arguments of a call as the call reads them; each is cast to the type the method takes, which is the point of the matrix. */
type Args = [never, never, never, never]

interface Rig {
  readonly calls: Record<string, { run: (args: unknown[]) => unknown; base: () => unknown[] | Promise<unknown[]> }>
}

/** The services over in-memory stores, and every public method as a call with the arguments that make it succeed. */
async function rig(): Promise<Rig> {
  const options = applyDefaults({ store: makeFullStore(), markup: 1, pricing: { seedFromSnapshot: false, strict: true } })
  const pricingStore = new InMemoryPricingStore()
  const pricing = new PricingService(options, pricingStore)
  const ledgerStore = new InMemoryLedgerStore()
  const ledger = new LedgerService(ledgerStore, options)
  const metering = new MeteringService(ledger, pricing, new MarkupResolver(options), options)
  const wallets = new WalletService(new InMemoryWalletStore(), { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' })
  const { service: budgets } = makeService()
  const reports = new UsageReportService(ledgerStore, pricingStore, { currency: 'USD', reporting: { maxExportRows: 1000 } })
  await pricing.upsertPrice({ provider: 'openai', model: 'gpt-4o', operation: 'chat', inputNanoUsdPerMillion: 2_500_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  const ref = (): { tenantId: string; ownerType: 'user'; ownerId: string } => ({ tenantId: TENANT, ownerType: 'user', ownerId: 'u' })
  const scope = (): typeof USER_SCOPE => ({ ...USER_SCOPE })
  await wallets.grant(ref(), { amountNanoUsd: 900_000_000_000n, effectiveAt: new Date('2020-01-01'), idempotencyKey: 'seed', reason: 'r' })
  const budget = await budgets.upsertBudget({ tenantId: TENANT, scope: scope(), window: 'day', limitCount: 1_000_000 })
  const preset = providerPresets.openaiChat
  let n = 0
  const next = (): string => String((n += 1))
  const key = (): string => `k${next()}`
  const context = (): Record<string, unknown> => ({ tenantId: TENANT, scope: scope(), feature: 'f', idempotencyKey: key(), baseModel: 'gpt-4o' })
  const caller = (): Record<string, unknown> => ({ tenantId: TENANT, scope: scope() })
  const estimate = (): Record<string, unknown> => ({ provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 10, maxOutputTokens: 10 })
  const usage = (): Record<string, unknown> => ({ model: 'gpt-4o', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })
  const seeded = await metering.record({ usage: usage(), preset: { ...preset }, context: context() } as never)
  const heldHold = (): Promise<unknown> => metering.hold(context() as never, estimate() as never)
  const entry = (): Record<string, unknown> => ({ amountNanoUsd: 5n, idempotencyKey: key(), reason: 'r' })
  const call = (fn: (a: Args) => unknown, base: () => unknown[] | Promise<unknown[]>): Rig['calls'][string] => ({ run: (args) => fn(args as Args), base })
  return {
    calls: {
      'metering.hold': call((a) => metering.hold(a[0], a[1]), () => [context(), estimate()]),
      'metering.hold(amount)': call((a) => metering.hold(a[0], a[1]), () => [context(), { amountNanoUsd: 5n }]),
      'metering.record': call((a) => metering.record(a[0]), () => [{ usage: usage(), preset: { ...preset }, context: context() }]),
      'metering.estimateCost': call((a) => metering.estimateCost(a[0]), () => [{ ...estimate(), feature: 'f' }]),
      'metering.getStatus': call((a) => metering.getStatus(a[0], a[1]), () => [TENANT, scope()]),
      'metering.reverse': call((a) => metering.reverse(a[0], a[1]), () => [seeded.id, 'why']),
      'metering.capture': call((a) => metering.capture(a[0], a[1], a[2], a[3]), async () => [await heldHold(), caller(), usage(), { ...preset }]),
      'metering.release': call((a) => metering.release(a[0], a[1], a[2]), async () => [await heldHold(), caller(), 'why']),
      'wallets.getBalance': call((a) => wallets.getBalance(a[0]), () => [ref()]),
      'wallets.grant': call((a) => wallets.grant(a[0], a[1]), () => [ref(), entry()]),
      'wallets.debit': call((a) => wallets.debit(a[0], a[1]), () => [ref(), entry()]),
      'wallets.refund': call((a) => wallets.refund(a[0], a[1]), () => [ref(), entry()]),
      'wallets.adjust': call((a) => wallets.adjust(a[0], a[1]), () => [ref(), entry()]),
      'wallets.getEntries': call((a) => wallets.getEntries(a[0], a[1]), () => [ref(), { limit: 5 }]),
      'wallets.reconcile': call((a) => wallets.reconcile(a[0]), () => [ref()]),
      'budgets.upsertBudget': call((a) => budgets.upsertBudget(a[0]), () => [{ tenantId: TENANT, scope: { type: 'user', id: `b${next()}` }, window: 'day', limitCount: 5, limitNanoUsd: 100n, limitTokens: 10 }]),
      'budgets.rotateWindow': call((a) => budgets.rotateWindow(a[0], a[1], a[2]), () => [budget.id, TENANT, new Date()]),
      'budgets.reconcileWindow': call((a) => budgets.reconcileWindow(a[0], a[1], a[2]), () => [budget.id, TENANT, new Date()]),
      'budgets.list': call((a) => budgets.list(a[0], a[1]), () => [TENANT, scope()]),
      'budgets.status': call((a) => budgets.status(a[0], a[1]), () => [TENANT, scope()]),
      'budgets.removeBudget': call((a) => budgets.removeBudget(a[0], a[1]), () => [`${budget.id}x`, TENANT]),
      'ledger.findById': call((a) => ledger.findById(a[0]), () => ['abc']),
      'ledger.findByIdempotencyKey': call((a) => ledger.findByIdempotencyKey(a[0], a[1]), () => [TENANT, 'abc']),
      'ledger.query': call((a) => ledger.query(a[0]), () => [{ tenantId: TENANT, limit: 5 }]),
      'ledger.sumCost': call((a) => ledger.sumCost(a[0]), () => [{ tenantId: TENANT }]),
      'ledger.verifyChain': call((a) => ledger.verifyChain(a[0]), () => [TENANT]),
      'reports.summarize': call((a) => reports.summarize(a[0]), () => [{ tenantId: TENANT, from: new Date(0), to: new Date(), groupBy: ['feature'] }]),
      'pricing.resolveRate': call((a) => pricing.resolveRate(a[0]), () => [{ provider: 'openai', model: 'gpt-4o', operation: 'chat', at: new Date() }]),
      'pricing.upsertPrice': call((a) => pricing.upsertPrice(a[0]), () => [{ provider: 'openai', model: `m${next()}`, operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n }]),
      'pricing.getPriceHistory': call((a) => pricing.getPriceHistory(a[0], a[1], a[2]), () => ['openai', 'gpt-4o', 'chat']),
    },
  }
}

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
