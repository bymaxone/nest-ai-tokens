/**
 * @fileoverview What a refusal of an argument names. The matrix proves that an argument of the wrong kind is refused with the typed
 * error and never repeats the value; this table proves the reason names the argument it refused, one row for each argument and field
 * the guards check, so that a caller who reads the reason knows which argument to fix. A value of the right kind for the same argument
 * is accepted, so that a guard cannot refuse more than it should.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { AiTokensException } from './server/errors'

/** A number: the wrong kind for an identifier and for an object. */
const NUMBER = 5
/** A string: the wrong kind for a count and for an array. */
const STRING = 'x'

/** One argument of one call: where it is, what is put there, and the reason the refusal gives. */
type Row = readonly [call: string, path: (string | number)[], value: unknown, reason: string]

const TEXT = (name: string): string => `${name} must be a string`
const OBJECT = (name: string): string => `${name} must be an object`
const COUNT = (name: string): string => `${name} must be a whole number of 0 or more`

const CONTEXT_ROWS: Row[] = [
  ['metering.hold', [0], NUMBER, OBJECT('context')],
  ['metering.hold', [0], null, OBJECT('context')],
  ['metering.hold', [0], [], OBJECT('context')],
  ['metering.hold', [0, 'tenantId'], NUMBER, TEXT('context.tenantId')],
  ['metering.hold', [0, 'scope'], NUMBER, OBJECT('context.scope')],
  ['metering.hold', [0, 'scope', 'type'], NUMBER, TEXT('context.scope.type')],
  ['metering.hold', [0, 'scope', 'id'], NUMBER, TEXT('context.scope.id')],
  ['metering.hold', [0, 'beneficiary'], NUMBER, OBJECT('context.beneficiary')],
  ['metering.hold', [0, 'feature'], NUMBER, TEXT('context.feature')],
  ['metering.hold', [0, 'requestedBy'], NUMBER, TEXT('context.requestedBy')],
  ['metering.hold', [0, 'baseModel'], NUMBER, TEXT('context.baseModel')],
  ['metering.hold', [0, 'idempotencyKey'], NUMBER, TEXT('context.idempotencyKey')],
  ['metering.hold', [0, 'correlationId'], NUMBER, TEXT('context.correlationId')],
  ['metering.hold', [0, 'systemCostCategory'], NUMBER, TEXT('context.systemCostCategory')],
  ['metering.record', [0], NUMBER, OBJECT('input')],
  ['metering.record', [0, 'context'], NUMBER, OBJECT('context')],
  ['metering.record', [0, 'context', 'tenantId'], NUMBER, TEXT('context.tenantId')],
]

const ESTIMATE_ROWS: Row[] = [
  ['metering.hold', [1], NUMBER, OBJECT('estimate')],
  ['metering.hold', [1, 'provider'], NUMBER, TEXT('estimate.provider')],
  ['metering.hold', [1, 'model'], NUMBER, TEXT('estimate.model')],
  ['metering.hold', [1, 'operation'], NUMBER, TEXT('estimate.operation')],
  ['metering.hold', [1, 'serviceTier'], NUMBER, TEXT('estimate.serviceTier')],
  ['metering.hold', [1, 'inputTokens'], STRING, COUNT('inputTokens of a hold estimate')],
  ['metering.estimateCost', [0], NUMBER, OBJECT('input')],
  ['metering.estimateCost', [0, 'provider'], NUMBER, TEXT('provider')],
  ['metering.estimateCost', [0, 'model'], NUMBER, TEXT('model')],
  ['metering.estimateCost', [0, 'operation'], NUMBER, TEXT('operation')],
  ['metering.estimateCost', [0, 'serviceTier'], NUMBER, TEXT('serviceTier')],
  ['metering.estimateCost', [0, 'feature'], NUMBER, TEXT('feature')],
  ['metering.estimateCost', [0, 'scope'], NUMBER, OBJECT('scope')],
  ['metering.estimateCost', [0, 'scope'], { type: NUMBER, id: 'u' }, TEXT('scope.type')],
  ['metering.estimateCost', [0, 'scope'], { type: 'user', id: NUMBER }, TEXT('scope.id')],
  ['metering.estimateCost', [0, 'inputTokens'], STRING, COUNT('inputTokens')],
  ['metering.estimateCost', [0, 'maxOutputTokens'], STRING, COUNT('maxOutputTokens')],
  ['pricing.resolveRate', [0], NUMBER, OBJECT('input')],
  ['pricing.resolveRate', [0, 'provider'], NUMBER, TEXT('provider')],
  ['pricing.resolveRate', [0, 'model'], NUMBER, TEXT('model')],
  ['pricing.resolveRate', [0, 'operation'], NUMBER, TEXT('operation')],
  ['pricing.resolveRate', [0, 'serviceTier'], NUMBER, TEXT('serviceTier')],
]

const STORE_ROWS: Row[] = [
  ['ledger.findByIdempotencyKey', [0], NUMBER, TEXT('tenantId')],
  ['ledger.findByIdempotencyKey', [1], NUMBER, TEXT('idempotencyKey')],
  ['ledger.query', [0], NUMBER, OBJECT('filter')],
  ['ledger.query', [0, 'limit'], STRING, COUNT('limit')],
  ['ledger.query', [0, 'offset'], STRING, COUNT('offset')],
  ['ledger.sumCost', [0], NUMBER, OBJECT('filter')],
  ['wallets.getBalance', [0], NUMBER, OBJECT('wallet')],
  ['wallets.getBalance', [0, 'tenantId'], NUMBER, TEXT('wallet.tenantId')],
  ['wallets.getBalance', [0, 'ownerType'], NUMBER, TEXT('wallet.ownerType')],
  ['wallets.getBalance', [0, 'ownerId'], NUMBER, TEXT('wallet.ownerId')],
  ['wallets.getEntries', [1], NUMBER, OBJECT('filter')],
  ['wallets.getEntries', [1, 'limit'], STRING, COUNT('limit')],
  ['wallets.getEntries', [1, 'offset'], STRING, COUNT('offset')],
  ['reports.summarize', [0], NUMBER, OBJECT('input')],
  ['reports.summarize', [0, 'groupBy'], NUMBER, 'groupBy must be an array'],
  ['reports.summarize', [0, 'groupBy'], ['nonsense'], 'groupBy must name only the documented dimensions'],
  ['reports.summarize', [0, 'groupBy'], ['toString'], 'groupBy must name only the documented dimensions'],
  ['reports.summarize', [0, 'groupBy'], ['day', NUMBER], 'groupBy must name only the documented dimensions'],
  ['reports.summarize', [0, 'groupBy'], [{ toString: () => 'day' }], 'groupBy must name only the documented dimensions'],
]

const LIST = (name: string): string => `${name} must be a list of strings`
const AMOUNT = (name: string): string => `${name} must be a bigint of 0 or more`
const ENTRY_CALLS = ['wallets.grant', 'wallets.debit', 'wallets.refund', 'wallets.adjust']

const IDENTIFIER_ROWS: Row[] = [
  ['metering.getStatus', [0], NUMBER, TEXT('tenantId')],
  ['metering.getStatus', [1], NUMBER, OBJECT('scope')],
  ['metering.getStatus', [1, 'type'], NUMBER, TEXT('scope.type')],
  ['metering.getStatus', [1, 'id'], NUMBER, TEXT('scope.id')],
  ['metering.reverse', [0], NUMBER, TEXT('usageRecordId')],
  ['metering.reverse', [1], NUMBER, TEXT('reason')],
  ['metering.capture', [0], NUMBER, OBJECT('hold')],
  ['metering.capture', [0, 'id'], NUMBER, TEXT('hold.id')],
  ['metering.release', [0], NUMBER, OBJECT('hold')],
  ['metering.release', [0, 'id'], NUMBER, TEXT('hold.id')],
  ['metering.release', [2], NUMBER, TEXT('reason')],
  ...ENTRY_CALLS.flatMap((call): Row[] => [
    [call, [1], NUMBER, OBJECT('input')],
    [call, [1, 'idempotencyKey'], NUMBER, TEXT('idempotencyKey')],
    [call, [1, 'reason'], NUMBER, TEXT('reason')],
    [call, [1, 'usageRecordId'], NUMBER, TEXT('usageRecordId')],
  ]),
  ...['wallets.grant', 'wallets.refund', 'wallets.adjust'].map((call): Row => [call, [1, 'reason'], undefined, TEXT('reason')]),
  ['budgets.upsertBudget', [0], NUMBER, OBJECT('input')],
  ['budgets.upsertBudget', [0, 'scope'], NUMBER, OBJECT('scope')],
  ['budgets.upsertBudget', [0, 'scope', 'type'], NUMBER, TEXT('scope.type')],
  ['budgets.upsertBudget', [0, 'scope', 'id'], NUMBER, TEXT('scope.id')],
  ['budgets.upsertBudget', [0, 'id'], NUMBER, TEXT('id')],
  ['budgets.upsertBudget', [0, 'features'], STRING, LIST('features')],
  ['budgets.upsertBudget', [0, 'features'], [NUMBER], LIST('features')],
  ['budgets.rotateWindow', [0], NUMBER, TEXT('budgetId')],
  ['budgets.reconcileWindow', [0], NUMBER, TEXT('budgetId')],
  ['budgets.removeBudget', [0], NUMBER, TEXT('budgetId')],
  ['budgets.list', [0], NUMBER, TEXT('tenantId')],
  ['budgets.list', [1], NUMBER, OBJECT('scope')],
  ['budgets.status', [0], NUMBER, TEXT('tenantId')],
  ['budgets.status', [1, 'id'], NUMBER, TEXT('scope.id')],
  ['ledger.findById', [0], NUMBER, TEXT('id')],
  ['ledger.query', [0, 'tenantId'], NUMBER, TEXT('tenantId')],
  ['ledger.sumCost', [0, 'tenantId'], NUMBER, TEXT('tenantId')],
  ['ledger.verifyChain', [0], NUMBER, TEXT('tenantId')],
  ['reports.summarize', [0, 'tenantId'], NUMBER, TEXT('tenantId')],
  ['pricing.upsertPrice', [0], NUMBER, OBJECT('input')],
  ['pricing.upsertPrice', [0, 'provider'], NUMBER, TEXT('provider')],
  ['pricing.upsertPrice', [0, 'model'], NUMBER, TEXT('model')],
  ['pricing.upsertPrice', [0, 'operation'], NUMBER, TEXT('operation')],
  ['pricing.upsertPrice', [0, 'inputNanoUsdPerMillion'], STRING, AMOUNT('inputNanoUsdPerMillion')],
  ['pricing.upsertPrice', [0, 'outputNanoUsdPerMillion'], -1n, AMOUNT('outputNanoUsdPerMillion')],
  ['pricing.upsertPrice', [0, 'serviceTier'], NUMBER, TEXT('serviceTier')],
  ['pricing.upsertPrice', [0, 'tierThresholdTokens'], STRING, COUNT('tierThresholdTokens')],
  ['pricing.getPriceHistory', [3], NUMBER, TEXT('serviceTier')],
  ['pricing.getPriceHistory', [0], NUMBER, TEXT('provider')],
  ['pricing.getPriceHistory', [1], NUMBER, TEXT('model')],
  ['pricing.getPriceHistory', [2], NUMBER, TEXT('operation')],
]

/** Put `value` at `path` in the arguments. */
function setAt(args: unknown[], path: (string | number)[], value: unknown): void {
  let target: unknown = args
  for (const step of path.slice(0, -1)) target = (target as Record<string | number, unknown>)[step]
  ;(target as Record<string | number, unknown>)[path.at(-1)!] = value
}

/** The reason of the typed refusal `run` raises, or `undefined` when it is accepted. */
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

describe('the reason of a refused argument', () => {
  it.each([...CONTEXT_ROWS, ...ESTIMATE_ROWS, ...STORE_ROWS, ...IDENTIFIER_ROWS])('names the argument at %s %j', async (call, path, value, reason) => {
    const def = (await rig()).calls[call]
    if (def === undefined) throw new Error(`no call named ${call}`)
    const args = await def.base()
    setAt(args, path, value)
    expect(await reasonOf(() => def.run(args))).toBe(`AI_TOKENS_INVALID_CONFIG ${reason}`)
  })

  /** Each guarded argument of the right kind is accepted: a guard that refused more than it should fails here. */
  it.each(['metering.hold', 'metering.record', 'metering.estimateCost', 'pricing.resolveRate', 'ledger.findByIdempotencyKey', 'ledger.query', 'wallets.getBalance', 'wallets.getEntries', 'reports.summarize', 'metering.getStatus', 'metering.reverse', 'metering.capture', 'metering.release', ...ENTRY_CALLS, 'budgets.upsertBudget', 'budgets.rotateWindow', 'budgets.reconcileWindow', 'budgets.removeBudget', 'budgets.list', 'budgets.status', 'ledger.findById', 'ledger.sumCost', 'ledger.verifyChain', 'pricing.upsertPrice', 'pricing.getPriceHistory'])('accepts the arguments %s starts from', async (call) => {
    const def = (await rig()).calls[call]
    if (def === undefined) throw new Error(`no call named ${call}`)
    const args = await def.base()
    expect(await reasonOf(() => def.run(args))).toBeUndefined()
  })

  it('accepts every documented dimension to group a summary by, and the scope of an estimate', async () => {
    const { calls } = await rig()
    const dimensions = ['day', 'week', 'month', 'feature', 'provider', 'model', 'operation', 'serviceTier', 'scope', 'beneficiary', 'tag', 'systemCostCategory']
    const summarize = calls['reports.summarize']
    const estimate = calls['metering.estimateCost']
    if (summarize === undefined || estimate === undefined) throw new Error('no call')
    const input = await summarize.base()
    setAt(input, [0, 'groupBy'], dimensions)
    expect(await reasonOf(() => summarize.run(input))).toBeUndefined()
    const costed = await estimate.base()
    setAt(costed, [0, 'scope'], { type: 'user', id: 'u' })
    expect(await reasonOf(() => estimate.run(costed))).toBeUndefined()
  })
})
