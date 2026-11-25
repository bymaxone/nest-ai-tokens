/**
 * @fileoverview Every public method of the PostgreSQL store, driven with a driver that fails with a poisoned error, rejects with a
 * typed error whose message, response, details, stack and string form carry none of the driver's text, and keeps the original
 * failure on `cause`. The methods are listed by name, and the list is compared with the methods the class has, so a method added
 * later is decided here before it can ship.
 * @layer prisma
 */

import { TENANT, USER_SCOPE, usageRecord } from '../../test/fakes/budget-fixtures'
import { grantEntry } from '../../test/contracts/wallet-store.contract'
import { AiTokensException } from '../server/errors'
import { PrismaAiTokensStore } from './index'

/** A word no valid value contains, put into every field of every poison. */
const S = 'SENTINEL-1118-P4'

const WALLET = { tenantId: TENANT, ownerType: 'user', ownerId: 'u1' } as const
const NOW = new Date('2026-06-01T00:00:00.000Z')
const REFERENCE = { key: 'record:k', budgetId: 'b1', attempt: 'a1' }
const DELTA = { nanoUsd: 5n, tokens: 1, count: 1 }

/** Methods of the class that are not part of its interface; every other method must be in {@link CALLS}. */
const INTERNAL = new Set([
  'constructor', 'insert', 'insertChained', 'settleChained', 'updateStatus', 'lastHashWithin', 'getWalletWithin', 'ensureWallet',
  'insertWalletEntry', 'insertAllocations', 'applyBalanceDelta', 'lockWallet', 'insertSystemEntry', 'activateDueGrants',
  'sweepExpiredGrants', 'burnDown', 'walletReplay', 'replayOrConflictWallet', 'replayOrConflict', 'lockedBalance', 'sourceDebit', 'restorableOf',
])

/** A call of a method by its name, for the one the type system marks deprecated and the lint refuses to see called by name. */
function callByName(store: PrismaAiTokensStore, name: string, ...args: unknown[]): Promise<unknown> {
  const method: unknown = Reflect.get(store, name)
  if (typeof method !== 'function') return Promise.reject(new Error(`no method ${name}`))
  const result: unknown = Reflect.apply(method, store, args)
  return Promise.resolve(result)
}

/** One call per public method, with arguments valid enough to reach the database. */
const CALLS: Record<string, (store: PrismaAiTokensStore) => Promise<unknown>> = {
  append: (s) => s.append(usageRecord(), 'hash'),
  transition: (s) => s.transition('id1', 'pending', 'posted', { inputTokens: 1 }),
  findEffectsOwed: (s) => s.findEffectsOwed(NOW, 10),
  findEffectsOwedFor: (s) => s.findEffectsOwedFor('id1'),
  clearEffectsOwed: (s) => s.clearEffectsOwed('id1'),
  findByIdempotencyKey: (s) => s.findByIdempotencyKey(TENANT, 'k'),
  findById: (s) => s.findById('id1'),
  findExpiredHolds: (s) => s.findExpiredHolds(NOW, 10),
  query: (s) => s.query({ tenantId: TENANT }),
  sumCost: (s) => s.sumCost({ tenantId: TENANT }),
  lastHash: (s) => s.lastHash(TENANT),
  resolveRate: (s) => s.resolveRate('openai', 'gpt-5', 'chat', 'standard', NOW),
  upsertPrice: (s) => s.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n }),
  seedPrice: (s) => s.seedPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n }),
  getPriceHistory: (s) => s.getPriceHistory('openai', 'gpt-5', 'chat'),
  listModels: (s) => s.listModels('openai'),
  acquireSeedLock: (s) => callByName(s, 'acquireSeedLock', 'seed'),
  getWallet: (s) => s.getWallet(WALLET),
  appendEntry: (s) => s.appendEntry(WALLET, grantEntry({ idempotencyKey: 'g1' }), []),
  conditionalDebit: (s) => s.conditionalDebit(WALLET, { ...grantEntry({ idempotencyKey: 'd1' }), type: 'debit', amountNanoUsd: -5n }, 0n, NOW),
  openGrants: (s) => s.openGrants(WALLET, 'expiry', NOW),
  listEntries: (s) => s.listEntries(WALLET, {}),
  findDebitsBefore: (s) => s.findDebitsBefore({ keyPrefixes: ['hold:'], olderThan: NOW, limit: 10 }),
  reconcile: (s) => s.reconcile(WALLET, NOW),
  refundToSource: (s) => s.refundToSource(WALLET, { entry: { ...grantEntry({ idempotencyKey: 'r1' }), type: 'refund', usageRecordId: 'u1' }, now: NOW }),
  balanceAt: (s) => s.balanceAt(WALLET, NOW),
  balanceBreakdown: (s) => s.balanceBreakdown(WALLET, NOW),
  upsert: (s) => s.upsert({ tenantId: TENANT, scope: USER_SCOPE, window: 'day', limitNanoUsd: 5n, softThresholds: [], policy: 'block' }),
  remove: (s) => s.remove({ tenantId: TENANT, id: 'b1' }),
  findBudgetById: (s) => s.findBudgetById({ tenantId: TENANT, id: 'b1' }),
  findMatching: (s) => s.findMatching(TENANT, USER_SCOPE),
  conditionalConsume: (s) => s.conditionalConsume('b1', NOW, DELTA, { nanoUsd: 10n }),
  adjustWindow: (s) => s.adjustWindow('b1', NOW, DELTA),
  consumeWindowOnce: (s) => s.consumeWindowOnce(REFERENCE, NOW, DELTA, { nanoUsd: 10n }),
  adjustWindowOnce: (s) => s.adjustWindowOnce(REFERENCE, NOW, DELTA),
  commitReference: (s) => s.commitReference(REFERENCE),
  dropReference: (s) => s.dropReference(REFERENCE),
  findStaleReferences: (s) => s.findStaleReferences({ selection: 'attempt', olderThan: NOW, limit: 10 }),
  pruneApplication: (s) => s.pruneApplication({ key: 'record:k', budgetId: 'b1' }, NOW),
  pruneGivenBack: (s) => s.pruneGivenBack(NOW, 10),
  pruneGivenBackExcept: (s) => s.pruneGivenBackExcept(NOW, 10, ['t']),
  getWindow: (s) => s.getWindow('b1', NOW),
  setWindowStart: (s) => s.setWindowStart({ tenantId: TENANT, id: 'b1' }, NOW),
}

/** A driver failure of the given class, with a code and a message of the caller's choosing and a secret in every other field. */
function failure(name: string, code: string | undefined, message: string, extra: Record<string, unknown> = {}): () => unknown {
  return () => Object.assign(new Error(message), { name, ...(code === undefined ? {} : { code }), ...extra })
}

const K = 'PrismaClientKnownRequestError'
/** The ways a driver's text reaches an error: a clean code with a poisoned message, a poisoned code, a secret in meta, a thrown non-Error. */
const POISONS: Record<string, () => unknown> = {
  'a poisoned message': failure(K, 'P2010', `duplicate key SQLSTATE 23505 ${S}-VALUE`),
  'a code with a value after it': failure(K, `P2010 ${S}`, 'x'),
  'a code with a value before it': failure(K, `${S} P2010`, 'x'),
  'a digit code with a value': failure(K, `23505 ${S}`, 'x'),
  'a code with a newline and a value': failure(K, `P2010\n${S}`, 'x'),
  'a lower-case code': failure(K, 'p2010', 'x'),
  'a code longer than any': failure(K, 'E' + 'A'.repeat(32), 'x'),
  'a code that is the value': failure(K, S.toUpperCase().replace(/-/g, '_'), 'x'),
  'a secret in meta': failure(K, 'P2010', 'x', { meta: { target: [`${S}-constraint`], detail: `Key (token)=(${S}-detail) already exists`, message: S } }),
  'a secret in the client version': failure(K, 'P2010', 'x', { clientVersion: S, batchRequestIdx: S }),
  'a refused connection with a value': failure(K, `ECONNREFUSED ${S}`, 'x'),
  'a refused connection and a secret in the message': failure('Error', 'ECONNREFUSED', `connect ECONNREFUSED 10.0.0.1 password=${S}`),
  'a plain error with a value in its code': failure('Error', `P2010 ${S}`, `boom ${S}`),
  'a pg-style unique violation': failure('error', '23505', `duplicate key value violates unique constraint "${S}"`, { detail: `Key (api_key)=(${S}) already exists.`, constraint: S }),
  'a unique violation through the driver adapter': failure(K, 'P2002', `Unique ${S}`, { meta: { driverAdapterError: { cause: { originalCode: '23505', kind: 'UniqueConstraintViolation', originalMessage: S } } } }),
  'an object that is not an error': () => ({ code: 'P2010', message: S, secret: S }),
  'a string': () => `raw string ${S}`,
}

/** A raw client whose every query, statement and transaction fails with the poison, and counts the calls it got. */
function poisonedClient(poison: () => unknown): { client: ConstructorParameters<typeof PrismaAiTokensStore>[0]; calls: () => number } {
  let calls = 0
  const fail = (): Promise<never> => {
    calls += 1
    return (async (): Promise<never> => {
      throw poison()
    })()
  }
  const client: ConstructorParameters<typeof PrismaAiTokensStore>[0] = { $queryRawUnsafe: fail, $executeRawUnsafe: fail, $transaction: fail }
  return { client, calls: () => calls }
}

/** The surfaces of an error a caller or a log line can read. */
function surfacesOf(error: AiTokensException): string[] {
  const text = (read: () => unknown): string => {
    try {
      return JSON.stringify(read(), (_key, value: unknown) => (typeof value === 'bigint' ? `${String(value)}n` : value))
    } catch {
      return ''
    }
  }
  return [error.message, text(() => error.getResponse()), text(() => error), String(error.stack), String(error)]
}

describe('the boundary of the PostgreSQL store', () => {
  /** A method added to the class is a failure here until it has a call above or a place among the internal ones. */
  it('has a call for every public method of the store', () => {
    const methods = Object.getOwnPropertyNames(PrismaAiTokensStore.prototype).filter((name) => !INTERNAL.has(name))
    expect(methods.sort()).toEqual(Object.keys(CALLS).sort())
  })

  it.each(Object.keys(CALLS))('%s rejects every poisoned driver error with a typed error that carries none of it', async (method) => {
    for (const [name, poison] of Object.entries(POISONS)) {
      const { client, calls } = poisonedClient(poison)
      let thrown: unknown
      try {
        await CALLS[method]?.(new PrismaAiTokensStore(client))
      } catch (error) {
        thrown = error
      }
      expect({ method, poison: name, typed: thrown instanceof AiTokensException, reachedTheDatabase: calls() > 0 }).toEqual({ method, poison: name, typed: true, reachedTheDatabase: true })
      for (const surface of surfacesOf(thrown as AiTokensException)) expect({ poison: name, leaked: surface.includes(S) }).toEqual({ poison: name, leaked: false })
      expect((thrown as AiTokensException).cause).toBeDefined()
    }
  })
})
