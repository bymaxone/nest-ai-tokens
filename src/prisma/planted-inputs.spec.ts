/**
 * @fileoverview No method of the PostgreSQL store reads a name its input did not set off the `Object.prototype` of its realm. A getter is
 * planted on `Object.prototype` for every optional name of every input a method takes; each method is then driven with the smallest input
 * that reaches the database, against a client that records the statements it is given, and a getter that ran is a name that was read from
 * the realm root and could have been bound into a statement. A second table binds a planted value and asserts what the statement carries.
 * @layer prisma
 */

import { TENANT, USER_SCOPE, usageRecord } from '../../test/fakes/budget-fixtures'
import { grantEntry } from '../../test/contracts/wallet-store.contract'
import { entryRow, T0 } from '../../test/fakes/prisma-rows'
import { PrismaAiTokensStore } from './index'

const WALLET = { tenantId: TENANT, ownerType: 'user', ownerId: 'u1' } as const
const NOW = new Date('2026-06-01T00:00:00.000Z')
const REFERENCE = { key: 'record:k', budgetId: 'b1', attempt: 'a1' }
const DELTA = { nanoUsd: 5n, tokens: 1, count: 1 }

/** Every optional name of an input a method of the store takes: what a caller may leave out and the store reads with `??` or `!== undefined`. */
const OPTIONAL_NAMES = [
  'features', 'limitNanoUsd', 'limitTokens', 'limitCount', 'anchorAt', 'expiresAt', 'createdAt', 'id', 'unitRates', 'source',
  'cacheReadNanoUsdPerMillion', 'cacheWrite5mNanoUsdPerMillion', 'cacheWrite1hNanoUsdPerMillion', 'reasoningNanoUsdPerMillion',
  'audioInNanoUsdPerMillion', 'audioOutNanoUsdPerMillion', 'imageInNanoUsdPerMillion', 'imageOutNanoUsdPerMillion',
  'tierThresholdTokens', 'tierInputNanoUsdPerMillion', 'tierOutputNanoUsdPerMillion', 'serviceTier', 'effectiveFrom',
  'extraUnits', 'requestedModel', 'requestedBy', 'beneficiary', 'baseModel', 'correlationId', 'systemCostCategory', 'reversedByRecordId',
  'reversesRecordId', 'providerReportedCostNanoUsd', 'idempotencyKey', 'hash', 'prevHash', 'usageRecordId', 'actor', 'reason',
  'tags', 'feature', 'scope', 'from', 'to', 'limit', 'offset', 'after', 'enforcedOnly', 'isSystemCost', 'newerThan', 'status',
  'priority', 'metadata', 'grantId', 'allocations', 'blockedBy', 'content', 'preset', 'requestId', 'reservedBilledNanoUsd', 'reservedTokens',
] as const

/** The rows a wallet statement answers with, so that a wallet method goes on to bind the input it was given. */
function answerTo(text: string): unknown[] {
  if (text.includes('INSERT INTO "ai_wallet_entries"')) return [entryRow()]
  if (text.includes('FROM "ai_wallet_entries" e JOIN')) return [{ ...entryRow(), walletTenantId: TENANT, walletOwnerType: 'user', walletOwnerId: 'u1' }]
  if (text.includes('"ai_wallets"')) return [{ id: 'w1', tenantId: TENANT, ownerType: 'user', ownerId: 'u1', balanceNanoUsd: 1_000n, createdAt: T0, updatedAt: T0 }]
  return []
}

/** A driver that records every statement it is given and answers a wallet statement with a wallet and no other with a row. */
function recordingClient(): { client: ConstructorParameters<typeof PrismaAiTokensStore>[0]; statements: { text: string; params: unknown[] }[] } {
  const statements: { text: string; params: unknown[] }[] = []
  const run = (text: string, ...params: unknown[]): Promise<unknown[]> => {
    statements.push({ text, params })
    return Promise.resolve(answerTo(text))
  }
  const client: ConstructorParameters<typeof PrismaAiTokensStore>[0] = {
    $queryRawUnsafe: run as never,
    $executeRawUnsafe: ((text: string, ...params: unknown[]) => run(text, ...params).then(() => 0)),
    $transaction: ((fn: (tx: unknown) => Promise<unknown>) => fn(client)) as never,
  }
  return { client, statements }
}

/** One call per method that takes an input object, with the smallest input that reaches the database. */
const CALLS: Record<string, (s: PrismaAiTokensStore) => Promise<unknown>> = {
  append: (s) => s.append(usageRecord(), 'hash'),
  appendChained: (s) => s.append(usageRecord({ status: 'posted' }), 'hash', true),
  transition: (s) => s.transition('id1', 'pending', 'posted', { inputTokens: 1 }),
  transitionChained: (s) => s.transition('id1', 'pending', 'posted', { inputTokens: 1 }, true),
  query: (s) => s.query({ tenantId: TENANT }),
  sumCost: (s) => s.sumCost({ tenantId: TENANT }),
  upsertPrice: (s) => s.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n }),
  seedPrice: (s) => s.seedPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n }),
  appendEntry: (s) => s.appendEntry(WALLET, grantEntry({ idempotencyKey: 'g1' }), []),
  conditionalDebit: (s) => s.conditionalDebit(WALLET, { ...grantEntry({ idempotencyKey: 'd1' }), type: 'debit', amountNanoUsd: -5n }, 0n, NOW),
  listEntries: (s) => s.listEntries(WALLET, {}),
  findDebitsBefore: (s) => s.findDebitsBefore({ keyPrefixes: ['hold:'], olderThan: NOW, limit: 10 }),
  upsertBudget: (s) => s.upsert({ tenantId: TENANT, scope: USER_SCOPE, window: 'day', limitNanoUsd: 5n, softThresholds: [], policy: 'block' }),
  conditionalConsume: (s) => s.conditionalConsume('b1', NOW, DELTA, { nanoUsd: 10n }),
  consumeWindowOnce: (s) => s.consumeWindowOnce(REFERENCE, NOW, DELTA, { nanoUsd: 10n }),
  findStaleReferences: (s) => s.findStaleReferences({ selection: 'attempt', olderThan: NOW, limit: 10 }),
}

/** Plant a recording getter on `Object.prototype` for each name, run `run`, and remove them; the names read while it ran are returned. */
async function readsDuring(names: readonly string[], run: () => Promise<unknown>): Promise<string[]> {
  const reads = new Set<string>()
  for (const name of names) {
    Object.defineProperty(Object.prototype, name, {
      get(): undefined {
        reads.add(name)
        return undefined
      },
      configurable: true,
    })
  }
  try {
    await run().catch(() => undefined)
  } finally {
    for (const name of names) Reflect.deleteProperty(Object.prototype, name)
  }
  return [...reads]
}

describe('what a method of the PostgreSQL store reads of its input', () => {
  it.each(Object.keys(CALLS))('%s reads no name off Object.prototype', async (name) => {
    const { client } = recordingClient()
    const store = new PrismaAiTokensStore(client)
    const call = CALLS[name]!
    expect(await readsDuring(OPTIONAL_NAMES, () => call(store))).toEqual([])
  })
})

/** The text of every parameter bound by the statements a call ran, so that a planted value can be looked for in it. */
function boundText(statements: { params: unknown[] }[]): string {
  return JSON.stringify(
    statements.map((statement) => statement.params),
    (_key, value: unknown) => (typeof value === 'bigint' ? `${String(value)}n` : value),
  )
}

/** A value only a planted key holds, the call that would have bound it, and how it would show in a parameter. */
const PLANTED: [name: string, key: string, value: unknown, shows: string][] = [
  ['upsertBudget', 'limitTokens', 7_777, '7777'],
  ['upsertBudget', 'limitCount', 8_888, '8888'],
  ['upsertBudget', 'limitNanoUsd', 9_999n, '9999n'],
  ['upsertBudget', 'features', ['planted.feature'], 'planted.feature'],
  ['upsertPrice', 'cacheReadNanoUsdPerMillion', 9_999n, '9999n'],
  ['upsertPrice', 'unitRates', { planted_unit: 1n }, 'planted_unit'],
  ['seedPrice', 'cacheReadNanoUsdPerMillion', 9_999n, '9999n'],
  ['seedPrice', 'imageOutNanoUsdPerMillion', 8_888n, '8888n'],
  ['append', 'extraUnits', { planted_unit: 1 }, 'planted_unit'],
  ['append', 'requestedModel', 'planted-model', 'planted-model'],
  ['append', 'beneficiary', { type: 'user', id: 'planted-beneficiary' }, 'planted-beneficiary'],
  ['transition', 'billedCostNanoUsd', 9_999n, '9999n'],
  ['appendEntry', 'expiresAt', new Date('2031-01-01T00:00:00.000Z'), '2031-01-01'],
  ['query', 'isSystemCost', true, 'true'],
  ['sumCost', 'features', ['planted.feature'], 'planted.feature'],
  ['findDebitsBefore', 'newerThan', new Date('2031-01-01T00:00:00.000Z'), '2031-01-01'],
]

describe('what a method of the PostgreSQL store binds into a statement', () => {
  it.each(PLANTED)('%s binds nothing of a %s planted on Object.prototype', async (name, key, value, shows) => {
    const { client, statements } = recordingClient()
    const store = new PrismaAiTokensStore(client)
    const call = CALLS[name]!
    Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
    try {
      await call(store).catch(() => undefined)
    } finally {
      Reflect.deleteProperty(Object.prototype, key)
    }
    expect(statements.length).toBeGreaterThan(0)
    expect(boundText(statements)).not.toContain(shows)
  })

  /** What the caller did put in the input is still bound: the copy drops what is inherited, nothing else. */
  it('still binds a value the caller put in its input', async () => {
    const { client, statements } = recordingClient()
    await new PrismaAiTokensStore(client).upsert({ tenantId: TENANT, scope: USER_SCOPE, window: 'day', limitTokens: 7_777, softThresholds: [0.5], policy: 'block' }).catch(() => undefined)
    expect(boundText(statements)).toContain('7777')
    expect(boundText(statements)).toContain('0.5')
  })
})
