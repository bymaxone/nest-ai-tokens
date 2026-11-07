/**
 * @fileoverview Unit tests for the pure parts of the Prisma adapter: row mappers, value and filter builders,
 * and the shape of the generated SQL text.
 * @layer prisma
 *
 * What a statement does against PostgreSQL is covered by the end-to-end suite; what these tests pin is the
 * text the builders produce, the order of the bound values, and the mapping of nulls to absent fields, none
 * of which needs a database.
 */

import { Prisma } from '@prisma/client'
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import type { Budget, LedgerFilter, NewPriceVersion, NewUsageRecord, NewWalletEntry, WalletEntry } from '../shared'
import {
  ACTIVATED_SQL,
  BUDGET_COLUMNS,
  BUDGET_COLUMNS_SQL,
  CREDITED_SQL,
  DB_NOW_SQL,
  DUE_AT_APPEND_SQL,
  GRANT_REMAINING_SQL,
  PRICE_COLUMNS,
  PRICE_COLUMNS_SQL,
  SIGNED_BALANCE_SQL,
  USAGE_COLUMNS,
  USAGE_COLUMNS_SQL,
  WalletMissingError,
  budgetUpdateAssignments,
  budgetValues,
  buildWhere,
  firstOrThrow,
  isWalletMissing,
  mapBudgetRow,
  mapBudgetWindowRow,
  mapOpenGrantRow,
  mapPriceRow,
  mapUsageRow,
  mapWalletEntryRow,
  mapWalletRow,
  parseUnitRates,
  parseWindow,
  priceValues,
  scopeOf,
  serializeUnitRates,
  serializeWindow,
  spendableBalanceSql,
  statusAssignments,
  tokenLimitSql,
  usageValues,
  walletAutoCreatable,
  walletBalanceDelta,
  walletEntryMatches,
  walletEntryWhere,
  type BudgetRow,
  type PriceRow,
  type UsageRow,
  type WalletEntryRow,
  type WalletRow,
} from './adapter-sql'

const T0 = new Date('2026-06-01T00:00:00.000Z')
const T1 = new Date('2026-06-02T00:00:00.000Z')
const T2 = new Date('2026-06-03T00:00:00.000Z')

/** A fully populated usage row; `over` replaces the fields under test. */
function usageRow(over: Partial<UsageRow> = {}): UsageRow {
  return {
    id: 'rec-1',
    tenantId: 'tenant-1',
    scopeType: 'user',
    scopeId: 'u1',
    beneficiaryType: 'team',
    beneficiaryId: 'team-1',
    requestedBy: 'admin',
    provider: 'openai',
    model: 'gpt-5',
    requestedModel: 'gpt-5-latest',
    operation: 'chat',
    serviceTier: 'standard',
    feature: 'chat.reply',
    tags: ['a', 'b'],
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWrite5mTokens: 4,
    cacheWrite1hTokens: 5,
    reasoningTokens: 6,
    audioInTokens: 7,
    audioOutTokens: 8,
    imageInTokens: 9,
    imageOutTokens: 10,
    totalTokens: 55,
    extraUnits: { web_search_requests: 2 },
    priceVersionId: 'price-1',
    rawCostNanoUsd: 11n,
    surchargeNanoUsd: 12n,
    billedCostNanoUsd: 13n,
    markupMultiplier: new Prisma.Decimal('1.5'),
    currency: 'USD',
    priceMissing: false,
    status: 'posted',
    reversedByRecordId: 'rec-2',
    reversesRecordId: 'rec-0',
    idempotencyKey: 'key-1',
    payloadHash: 'payload',
    correlationId: 'corr-1',
    requestId: 'req-1',
    isSystemCost: true,
    systemCostCategory: 'embedding',
    enforced: true,
    prevHash: 'prev',
    hash: 'hash',
    occurredAt: T0,
    createdAt: T1,
    updatedAt: T2,
    ...over,
  }
}

/** A usage row with every nullable column null. */
function bareUsageRow(): UsageRow {
  return usageRow({
    beneficiaryType: null,
    beneficiaryId: null,
    requestedBy: null,
    requestedModel: null,
    extraUnits: null,
    priceVersionId: null,
    reversedByRecordId: null,
    reversesRecordId: null,
    correlationId: null,
    requestId: null,
    systemCostCategory: null,
    prevHash: null,
    hash: null,
  })
}

/** A caller-supplied usage record; `over` replaces fields. */
function newRecord(over: Partial<NewUsageRecord> = {}): NewUsageRecord {
  const { id: _id, prevHash: _prev, hash: _hash, createdAt: _created, updatedAt: _updated, ...rest } = mapUsageRow(usageRow())
  return { ...rest, ...over }
}

/** The text of a fragment with its bound values, for exact assertions. */
function rendered(sql: Prisma.Sql): { text: string; values: unknown[] } {
  return { text: sql.text, values: sql.values }
}

describe('scopeOf', () => {
  /** A scope needs both columns; either one null means the scope is absent. */
  it('returns the scope only when both columns are present', () => {
    expect(scopeOf('user', 'u1')).toEqual({ type: 'user', id: 'u1' })
    expect(scopeOf(null, 'u1')).toBeUndefined()
    expect(scopeOf('user', null)).toBeUndefined()
    expect(scopeOf(null, null)).toBeUndefined()
  })
})

describe('mapUsageRow', () => {
  /** Every column maps to its field; the markup is converted from Decimal to number. */
  it('maps a fully populated row', () => {
    const record = mapUsageRow(usageRow())
    expect(record).toEqual({
      id: 'rec-1',
      tenantId: 'tenant-1',
      scope: { type: 'user', id: 'u1' },
      beneficiary: { type: 'team', id: 'team-1' },
      requestedBy: 'admin',
      provider: 'openai',
      model: 'gpt-5',
      requestedModel: 'gpt-5-latest',
      operation: 'chat',
      serviceTier: 'standard',
      feature: 'chat.reply',
      tags: ['a', 'b'],
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWrite5mTokens: 4,
      cacheWrite1hTokens: 5,
      reasoningTokens: 6,
      audioInTokens: 7,
      audioOutTokens: 8,
      imageInTokens: 9,
      imageOutTokens: 10,
      totalTokens: 55,
      extraUnits: { web_search_requests: 2 },
      priceVersionId: 'price-1',
      rawCostNanoUsd: 11n,
      surchargeNanoUsd: 12n,
      billedCostNanoUsd: 13n,
      markupMultiplier: 1.5,
      currency: 'USD',
      priceMissing: false,
      status: 'posted',
      reversedByRecordId: 'rec-2',
      reversesRecordId: 'rec-0',
      idempotencyKey: 'key-1',
      correlationId: 'corr-1',
      requestId: 'req-1',
      isSystemCost: true,
      systemCostCategory: 'embedding',
      enforced: true,
      prevHash: 'prev',
      hash: 'hash',
      occurredAt: T0,
      createdAt: T1,
      updatedAt: T2,
    })
  })

  /** A null column is an absent field, not a field set to null. */
  it('leaves out the fields whose columns are null', () => {
    const record = mapUsageRow(bareUsageRow())
    for (const key of ['beneficiary', 'requestedBy', 'requestedModel', 'extraUnits', 'reversedByRecordId', 'reversesRecordId', 'correlationId', 'requestId', 'systemCostCategory', 'prevHash', 'hash']) {
      expect(key in record).toBe(false)
    }
    expect(record.priceVersionId).toBeNull()
  })

  /** Each nullable column is judged on its own, so one present value does not bring back another. */
  it.each([
    ['requestedBy', { requestedBy: 'admin' }],
    ['requestedModel', { requestedModel: 'm' }],
    ['extraUnits', { extraUnits: { x: 1 } }],
    ['reversedByRecordId', { reversedByRecordId: 'r' }],
    ['reversesRecordId', { reversesRecordId: 'r' }],
    ['correlationId', { correlationId: 'c' }],
    ['requestId', { requestId: 'q' }],
    ['systemCostCategory', { systemCostCategory: 'cat' }],
    ['prevHash', { prevHash: 'p' }],
    ['hash', { hash: 'h' }],
  ] as const)('keeps %s alone when only it is present', (key, patch) => {
    const record = mapUsageRow({ ...bareUsageRow(), ...patch })
    expect(Object.keys(record).filter((k) => ['requestedBy', 'requestedModel', 'extraUnits', 'reversedByRecordId', 'reversesRecordId', 'correlationId', 'requestId', 'systemCostCategory', 'prevHash', 'hash'].includes(k))).toEqual([key])
  })
})

describe('unit rates', () => {
  /** Rates are stored as decimal strings, because JSON cannot hold a bigint. */
  it('serializes bigint rates to decimal strings and parses them back', () => {
    const json = serializeUnitRates({ image: 5n, web_search_requests: 10_000_000_000_000n })
    expect(JSON.parse(json)).toEqual({ image: '5', web_search_requests: '10000000000000' })
    expect(parseUnitRates({ image: '5', web_search_requests: '10000000000000' })).toEqual({ image: 5n, web_search_requests: 10_000_000_000_000n })
    expect(serializeUnitRates({})).toBe('{}')
  })
})

/** A fully populated price row. */
function priceRow(over: Partial<PriceRow> = {}): PriceRow {
  return {
    id: 'price-1',
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1n,
    outputNanoUsdPerMillion: 2n,
    cacheReadNanoUsdPerMillion: 3n,
    cacheWrite5mNanoUsdPerMillion: 4n,
    cacheWrite1hNanoUsdPerMillion: 5n,
    reasoningNanoUsdPerMillion: 6n,
    audioInNanoUsdPerMillion: 7n,
    audioOutNanoUsdPerMillion: 8n,
    imageInNanoUsdPerMillion: 9n,
    imageOutNanoUsdPerMillion: 10n,
    tierThresholdTokens: 200_000,
    tierInputNanoUsdPerMillion: 11n,
    tierOutputNanoUsdPerMillion: 12n,
    unitRates: { image: '13' },
    currency: 'EUR',
    effectiveFrom: T0,
    effectiveTo: T1,
    source: 'manual',
    ...over,
  }
}

describe('mapPriceRow', () => {
  /** The mapper carries every rate; the currency is always USD, whatever the row says. */
  it('maps a fully populated row', () => {
    expect(mapPriceRow(priceRow())).toEqual({
      id: 'price-1',
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      serviceTier: 'standard',
      inputNanoUsdPerMillion: 1n,
      outputNanoUsdPerMillion: 2n,
      cacheReadNanoUsdPerMillion: 3n,
      cacheWrite5mNanoUsdPerMillion: 4n,
      cacheWrite1hNanoUsdPerMillion: 5n,
      reasoningNanoUsdPerMillion: 6n,
      audioInNanoUsdPerMillion: 7n,
      audioOutNanoUsdPerMillion: 8n,
      imageInNanoUsdPerMillion: 9n,
      imageOutNanoUsdPerMillion: 10n,
      tierThresholdTokens: 200_000,
      tierInputNanoUsdPerMillion: 11n,
      tierOutputNanoUsdPerMillion: 12n,
      unitRates: { image: 13n },
      currency: 'USD',
      effectiveFrom: T0,
      effectiveTo: T1,
      source: 'manual',
    })
  })

  /** A null tier or unit-rate column is an absent field; each one is judged on its own. */
  it('leaves out the tier and unit-rate fields whose columns are null, each on its own', () => {
    const bare = { tierThresholdTokens: null, tierInputNanoUsdPerMillion: null, tierOutputNanoUsdPerMillion: null, unitRates: null, effectiveTo: null }
    const none = mapPriceRow(priceRow(bare))
    expect(Object.keys(none).filter((k) => /^tier|unitRates/.test(k))).toEqual([])
    expect(none.effectiveTo).toBeNull()
    expect(Object.keys(mapPriceRow(priceRow({ ...bare, tierThresholdTokens: 5 }))).filter((k) => /^tier|unitRates/.test(k))).toEqual(['tierThresholdTokens'])
    expect(Object.keys(mapPriceRow(priceRow({ ...bare, tierInputNanoUsdPerMillion: 5n }))).filter((k) => /^tier|unitRates/.test(k))).toEqual(['tierInputNanoUsdPerMillion'])
    expect(Object.keys(mapPriceRow(priceRow({ ...bare, tierOutputNanoUsdPerMillion: 5n }))).filter((k) => /^tier|unitRates/.test(k))).toEqual(['tierOutputNanoUsdPerMillion'])
    expect(Object.keys(mapPriceRow(priceRow({ ...bare, unitRates: { a: '1' } }))).filter((k) => /^tier|unitRates/.test(k))).toEqual(['unitRates'])
  })
})

describe('firstOrThrow', () => {
  /** A `RETURNING` query that yields nothing is a store error, not an undefined row. */
  it('returns the first row and throws a store error when there is none', () => {
    expect(firstOrThrow(['a', 'b'])).toBe('a')
    expect(() => firstOrThrow([])).toThrow(AiTokensException)
    try {
      firstOrThrow([])
    } catch (error) {
      expect((error as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR' } })
    }
  })
})

describe('column lists', () => {
  /** The identifier list quotes every column, in order, separated by a comma and a space. */
  it('quotes each column in order', () => {
    expect(USAGE_COLUMNS_SQL.text).toBe(USAGE_COLUMNS.map((c) => `"${c}"`).join(', '))
    expect(PRICE_COLUMNS_SQL.text).toBe(PRICE_COLUMNS.map((c) => `"${c}"`).join(', '))
    expect(BUDGET_COLUMNS_SQL.text).toBe(BUDGET_COLUMNS.map((c) => `"${c}"`).join(', '))
    expect(USAGE_COLUMNS_SQL.text.startsWith('"id", "tenantId", "scopeType"')).toBe(true)
    expect(PRICE_COLUMNS_SQL.text.startsWith('"id", "provider", "model"')).toBe(true)
    expect(BUDGET_COLUMNS_SQL.text.endsWith('"createdAt", "updatedAt"')).toBe(true)
  })
})

describe('usageValues', () => {
  /** The fragment bound to a named column. */
  const at = (fragments: Prisma.Sql[], column: (typeof USAGE_COLUMNS)[number]): Prisma.Sql => fragments[USAGE_COLUMNS.indexOf(column)]!

  /** One fragment per column: the bound values follow the column order and the two timestamps use the database clock. */
  it('aligns the values with the columns and stamps both timestamps on the UTC clock', () => {
    const fragments = usageValues('rec-1', newRecord(), 'payload', 'prev', 'hash')
    expect(fragments).toHaveLength(USAGE_COLUMNS.length)
    expect(USAGE_COLUMNS.slice(-2)).toEqual(['createdAt', 'updatedAt'])
    expect(fragments.slice(-2).map((f) => f.text)).toEqual([DB_NOW_SQL.text, DB_NOW_SQL.text])
    const expected: Partial<Record<(typeof USAGE_COLUMNS)[number], unknown>> = {
      id: 'rec-1',
      tenantId: 'tenant-1',
      scopeType: 'user',
      scopeId: 'u1',
      beneficiaryType: 'team',
      beneficiaryId: 'team-1',
      requestedBy: 'admin',
      provider: 'openai',
      model: 'gpt-5',
      requestedModel: 'gpt-5-latest',
      operation: 'chat',
      serviceTier: 'standard',
      feature: 'chat.reply',
      tags: ['a', 'b'],
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWrite5mTokens: 4,
      cacheWrite1hTokens: 5,
      reasoningTokens: 6,
      audioInTokens: 7,
      audioOutTokens: 8,
      imageInTokens: 9,
      imageOutTokens: 10,
      totalTokens: 55,
      extraUnits: JSON.stringify({ web_search_requests: 2 }),
      priceVersionId: 'price-1',
      rawCostNanoUsd: 11n,
      surchargeNanoUsd: 12n,
      billedCostNanoUsd: 13n,
      markupMultiplier: 1.5,
      currency: 'USD',
      priceMissing: false,
      status: 'posted',
      reversedByRecordId: 'rec-2',
      reversesRecordId: 'rec-0',
      idempotencyKey: 'key-1',
      payloadHash: 'payload',
      correlationId: 'corr-1',
      requestId: 'req-1',
      isSystemCost: true,
      systemCostCategory: 'embedding',
      enforced: true,
      prevHash: 'prev',
      hash: 'hash',
      occurredAt: T0,
    }
    for (const [column, value] of Object.entries(expected)) {
      expect({ column, values: at(fragments, column as (typeof USAGE_COLUMNS)[number]).values }).toEqual({ column, values: [value] })
    }
    expect(at(fragments, 'tags').text).toBe('$1::text[]')
    expect(at(fragments, 'extraUnits').text).toBe('$1::jsonb')
  })

  /** An absent optional field binds as null, and absent extra units as a SQL NULL. */
  it('binds an absent optional field as null and absent extra units as NULL', () => {
    const { beneficiary: _b, requestedBy: _r, requestedModel: _m, extraUnits: _e, reversedByRecordId: _x, reversesRecordId: _y, correlationId: _c, requestId: _q, systemCostCategory: _s, ...rest } = newRecord()
    const fragments = usageValues('rec-1', rest, 'payload', null, null)
    for (const column of ['beneficiaryType', 'beneficiaryId', 'requestedBy', 'requestedModel', 'reversedByRecordId', 'reversesRecordId', 'correlationId', 'requestId', 'systemCostCategory', 'prevHash', 'hash'] as const) {
      expect({ column, values: at(fragments, column).values }).toEqual({ column, values: [null] })
    }
    expect(at(fragments, 'extraUnits').text).toBe('NULL')
    expect(at(fragments, 'extraUnits').values).toEqual([])
  })
})

describe('priceValues', () => {
  const input: NewPriceVersion = {
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    inputNanoUsdPerMillion: 1n,
    outputNanoUsdPerMillion: 2n,
    cacheReadNanoUsdPerMillion: 3n,
    cacheWrite5mNanoUsdPerMillion: 4n,
    cacheWrite1hNanoUsdPerMillion: 5n,
    reasoningNanoUsdPerMillion: 6n,
    audioInNanoUsdPerMillion: 7n,
    audioOutNanoUsdPerMillion: 8n,
    imageInNanoUsdPerMillion: 9n,
    imageOutNanoUsdPerMillion: 10n,
    tierThresholdTokens: 200_000,
    tierInputNanoUsdPerMillion: 11n,
    tierOutputNanoUsdPerMillion: 12n,
    unitRates: { image: 13n },
    source: 'manual',
  }

  /** The values follow the column order; the id is a fresh UUID and the currency is always USD. */
  it('aligns the values with the columns', () => {
    const fragments = priceValues(input, 'batch', T0)
    expect(fragments).toHaveLength(PRICE_COLUMNS.length)
    const bound = fragments.map((f) => f.values[0])
    expect(String(bound[0])).toMatch(/^[0-9a-f-]{36}$/)
    expect(bound.slice(1, 15)).toEqual(['openai', 'gpt-5', 'chat', 'batch', 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n])
    expect(bound.slice(15, 18)).toEqual([200_000, 11n, 12n])
    expect(fragments[18]!.text).toBe('$1::jsonb')
    expect(bound[18]).toBe(JSON.stringify({ image: '13' }))
    expect(bound[19]).toBe('USD')
    expect(bound[20]).toEqual(T0)
    expect(bound[21]).toBeNull()
    expect(bound[22]).toBe('manual')
  })

  /** Omitted rates default to zero, omitted tier columns to null, absent unit rates to SQL NULL, and the source to `snapshot`. */
  it('defaults what the caller omitted', () => {
    const fragments = priceValues({ provider: 'openai', model: 'gpt-5', operation: 'chat' }, 'standard', T0)
    const bound = fragments.map((f) => f.values[0])
    expect(bound.slice(5, 15)).toEqual([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n])
    expect(bound.slice(15, 18)).toEqual([null, null, null])
    expect(fragments[18]!.text).toBe('NULL')
    expect(bound[22]).toBe('snapshot')
  })
})

describe('statusAssignments', () => {
  /** A bare transition sets the status and stamps updatedAt on the database clock. */
  it('sets the status and stamps updatedAt', () => {
    expect(rendered(statusAssignments('pending', 'released', undefined, null, null))).toEqual({
      text: `"status" = $1, "updatedAt" = ${DB_NOW_SQL.text}`,
      values: ['released'],
    })
  })

  /** A whitelisted patch column is assigned, with the column name as a quoted constant and the value bound. */
  it('assigns each whitelisted patch column', () => {
    const sql = statusAssignments('pending', 'posted', { billedCostNanoUsd: 5n, totalTokens: 9 }, null, null)
    expect(rendered(sql)).toEqual({
      text: `"status" = $1, "updatedAt" = ${DB_NOW_SQL.text}, "billedCostNanoUsd" = $2, "totalTokens" = $3`,
      values: ['posted', 5n, 9],
    })
  })

  /** The chain hashes are written together, and only when a hash is given. */
  it('writes prevHash and hash when a hash is given, and neither otherwise', () => {
    expect(rendered(statusAssignments('pending', 'posted', undefined, 'p', 'h'))).toEqual({
      text: `"status" = $1, "updatedAt" = ${DB_NOW_SQL.text}, "prevHash" = $2, "hash" = $3`,
      values: ['posted', 'p', 'h'],
    })
    expect(rendered(statusAssignments('pending', 'posted', undefined, null, 'h')).values).toEqual(['posted', null, 'h'])
    expect(statusAssignments('pending', 'posted', undefined, 'p', null).text).not.toContain('prevHash')
  })

  /** A column outside the whitelist is refused with the typed conflict, naming the transition and the column. */
  it('refuses a patch column the transition may not set', () => {
    let thrown: unknown
    try {
      statusAssignments('pending', 'released', { billedCostNanoUsd: 5n }, null, null)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AiTokensException)
    expect((thrown as AiTokensException).getResponse()).toMatchObject({
      error: { code: 'AI_TOKENS_IDEMPOTENCY_CONFLICT', details: { reason: 'pending → released may not patch "billedCostNanoUsd"' } },
    })
  })
})

describe('buildWhere', () => {
  /** The tenant is always the first condition. */
  it('starts from the tenant', () => {
    expect(rendered(buildWhere({ tenantId: 't1' }))).toEqual({ text: '"tenantId" = $1', values: ['t1'] })
  })

  /** Every filter field adds its own condition, in a fixed order, joined with AND, with bound values. */
  it('adds a condition per filter field, in order', () => {
    const filter: LedgerFilter = {
      tenantId: 't1',
      scope: { type: 'user', id: 'u1' },
      beneficiary: { type: 'team', id: 'team-1' },
      feature: 'chat.reply',
      features: ['a', 'b'],
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      serviceTier: 'batch',
      tags: ['x'],
      isSystemCost: false,
      systemCostCategory: 'embedding',
      status: ['posted'],
      enforcedOnly: true,
      from: T0,
      to: T1,
    }
    expect(rendered(buildWhere(filter))).toEqual({
      text: [
        '"tenantId" = $1',
        '"scopeType" = $2 AND "scopeId" = $3',
        '"beneficiaryType" = $4 AND "beneficiaryId" = $5',
        '"feature" = $6',
        '"feature" = ANY($7::text[])',
        '"provider" = $8',
        '"model" = $9',
        '"operation" = $10',
        '"serviceTier" = $11',
        '"tags" @> $12::text[]',
        '"isSystemCost" = $13',
        '"systemCostCategory" = $14',
        '"status" = ANY($15::text[])',
        '"enforced" = true',
        '"occurredAt" >= $16',
        '"occurredAt" <= $17',
      ].join(' AND '),
      values: ['t1', 'user', 'u1', 'team', 'team-1', 'chat.reply', ['a', 'b'], 'openai', 'gpt-5', 'chat', 'batch', ['x'], false, 'embedding', ['posted'], T0, T1],
    })
  })

  /** Only a literal `true` limits to enforced records; `false` adds nothing. */
  it('adds the enforced condition only for true', () => {
    expect(buildWhere({ tenantId: 't1', enforcedOnly: false }).text).toBe('"tenantId" = $1')
  })

  /** A false boolean filter is still a filter: `isSystemCost: false` must reach the query. */
  it('keeps a false isSystemCost filter', () => {
    expect(rendered(buildWhere({ tenantId: 't1', isSystemCost: false }))).toEqual({ text: '"tenantId" = $1 AND "isSystemCost" = $2', values: ['t1', false] })
  })
})

describe('wallet missing signal', () => {
  /** The signal is recognised by its brand, and nothing else is. */
  it('recognises only the branded error', () => {
    const error = new WalletMissingError()
    expect(error.name).toBe('WalletMissingError')
    expect(error.message).toBe('wallet does not exist')
    expect(error.isWalletMissing).toBe(true)
    expect(isWalletMissing(error)).toBe(true)
    expect(isWalletMissing({ isWalletMissing: true })).toBe(true)
    expect(isWalletMissing({ isWalletMissing: false })).toBe(false)
    expect(isWalletMissing({})).toBe(false)
    expect(isWalletMissing(null)).toBe(false)
    expect(isWalletMissing('wallet')).toBe(false)
    expect(isWalletMissing(undefined)).toBe(false)
  })
})

/** A wallet entry row. */
function entryRow(over: Partial<WalletEntryRow> = {}): WalletEntryRow {
  return {
    id: 'e1',
    walletId: 'w1',
    type: 'grant',
    amountNanoUsd: 100n,
    priority: 2,
    effectiveAt: T0,
    expiresAt: T2,
    usageRecordId: 'rec-1',
    idempotencyKey: 'k1',
    reason: 'welcome',
    createdAt: T1,
    ...over,
  }
}

describe('wallet mappers', () => {
  /** A wallet row maps field for field. */
  it('maps a wallet row', () => {
    const row: WalletRow = { id: 'w1', tenantId: 't1', ownerType: 'user', ownerId: 'u1', balanceNanoUsd: 7n, createdAt: T0, updatedAt: T1 }
    expect(mapWalletRow(row)).toEqual(row)
  })

  /** An entry maps every column; nulls become absent fields, each judged on its own. */
  it('maps an entry row and leaves out null columns', () => {
    expect(mapWalletEntryRow(entryRow())).toEqual({
      id: 'e1',
      walletId: 'w1',
      type: 'grant',
      amountNanoUsd: 100n,
      priority: 2,
      effectiveAt: T0,
      expiresAt: T2,
      usageRecordId: 'rec-1',
      idempotencyKey: 'k1',
      reason: 'welcome',
      createdAt: T1,
    })
    const bare = { expiresAt: null, usageRecordId: null, reason: null }
    expect(Object.keys(mapWalletEntryRow(entryRow(bare))).sort()).toEqual(['amountNanoUsd', 'createdAt', 'effectiveAt', 'id', 'idempotencyKey', 'priority', 'type', 'walletId'])
    expect('expiresAt' in mapWalletEntryRow(entryRow({ ...bare, expiresAt: T2 }))).toBe(true)
    expect('usageRecordId' in mapWalletEntryRow(entryRow({ ...bare, usageRecordId: 'r' }))).toBe(true)
    expect('reason' in mapWalletEntryRow(entryRow({ ...bare, reason: 'x' }))).toBe(true)
    expect('expiresAt' in mapWalletEntryRow(entryRow({ ...bare, usageRecordId: 'r', reason: 'x' }))).toBe(false)
  })

  /** An open grant carries the remaining value as `remainingNanoUsd`. */
  it('maps an open grant with its remainder', () => {
    expect(mapOpenGrantRow({ ...entryRow(), remaining: 40n })).toMatchObject({ id: 'e1', remainingNanoUsd: 40n })
  })
})

describe('walletAutoCreatable', () => {
  /** A grant, or a positive adjustment, may create the wallet; nothing else does. */
  it('creates a wallet for a grant or a positive adjustment only', () => {
    const entry = (type: NewWalletEntry['type'], amountNanoUsd: bigint): NewWalletEntry => ({ walletId: 'w1', type, amountNanoUsd, priority: 0, effectiveAt: T0, idempotencyKey: 'k' })
    expect(walletAutoCreatable(entry('grant', 0n))).toBe(true)
    expect(walletAutoCreatable(entry('adjustment', 1n))).toBe(true)
    expect(walletAutoCreatable(entry('adjustment', 0n))).toBe(false)
    expect(walletAutoCreatable(entry('adjustment', -1n))).toBe(false)
    expect(walletAutoCreatable(entry('debit', 5n))).toBe(false)
    expect(walletAutoCreatable(entry('refund', 5n))).toBe(false)
  })
})

describe('walletBalanceDelta', () => {
  const entry = (over: Partial<WalletEntry> = {}): WalletEntry => ({
    id: 'e1',
    walletId: 'w1',
    type: 'grant',
    amountNanoUsd: 100n,
    priority: 0,
    effectiveAt: T0,
    idempotencyKey: 'k',
    createdAt: T1,
    ...over,
  })

  /** Every entry but a grant contributes its signed amount. */
  it('returns the signed amount of an entry that is not a grant', () => {
    expect(walletBalanceDelta(entry({ type: 'debit', amountNanoUsd: -5n }))).toBe(-5n)
  })

  /** A grant counts when it was due as it was appended and had not expired. */
  it('credits a grant that was due and unexpired as it was appended', () => {
    expect(walletBalanceDelta(entry())).toBe(100n)
    expect(walletBalanceDelta(entry({ effectiveAt: T1 }))).toBe(100n)
    expect(walletBalanceDelta(entry({ expiresAt: T2 }))).toBe(100n)
  })

  /** A grant that was not yet effective, or had already expired, counts for nothing at append time. */
  it('credits nothing for a grant that was not due or had expired', () => {
    expect(walletBalanceDelta(entry({ effectiveAt: T2 }))).toBe(0n)
    expect(walletBalanceDelta(entry({ expiresAt: T1 }))).toBe(0n)
    expect(walletBalanceDelta(entry({ expiresAt: T0 }))).toBe(0n)
  })
})

describe('walletEntryMatches', () => {
  const row = entryRow()
  const same: NewWalletEntry = { walletId: 'w1', type: 'grant', amountNanoUsd: 100n, priority: 2, effectiveAt: new Date('2030-01-01T00:00:00.000Z'), expiresAt: T2, usageRecordId: 'rec-1', reason: 'welcome', idempotencyKey: 'k1' }

  /** A replay matches on the business payload; `effectiveAt` is not part of it. */
  it('matches an entry with the same payload whatever its effectiveAt', () => {
    expect(walletEntryMatches(row, same)).toBe(true)
  })

  /** Each compared field decides on its own. */
  it.each([
    ['type', { type: 'adjustment' as const }],
    ['amount', { amountNanoUsd: 101n }],
    ['priority', { priority: 3 }],
    ['expiry', { expiresAt: T1 }],
    ['usage link', { usageRecordId: 'rec-2' }],
    ['reason', { reason: 'other' }],
  ])('does not match when the %s differs', (_label, patch) => {
    expect(walletEntryMatches(row, { ...same, ...patch })).toBe(false)
  })

  /** An absent field on either side is equal to a null column on the other, and unequal to a present one. */
  it('treats absent and null as equal and absent against present as different', () => {
    const bareRow = entryRow({ expiresAt: null, usageRecordId: null, reason: null })
    const { expiresAt: _e, usageRecordId: _u, reason: _r, ...bare } = same
    expect(walletEntryMatches(bareRow, bare)).toBe(true)
    expect(walletEntryMatches(bareRow, { ...bare, expiresAt: T2 })).toBe(false)
    expect(walletEntryMatches(bareRow, { ...bare, usageRecordId: 'rec-1' })).toBe(false)
    expect(walletEntryMatches(bareRow, { ...bare, reason: 'welcome' })).toBe(false)
    expect(walletEntryMatches(row, bare)).toBe(false)
  })
})

describe('walletEntryWhere', () => {
  /** The wallet is always the first condition, and each filter field adds its own. */
  it('filters by wallet, type and the creation window', () => {
    expect(rendered(walletEntryWhere('w1', {}))).toEqual({ text: '"walletId" = $1', values: ['w1'] })
    expect(rendered(walletEntryWhere('w1', { type: 'grant', from: T0, to: T1 }))).toEqual({
      text: '"walletId" = $1 AND "type" = $2 AND "createdAt" >= $3 AND "createdAt" <= $4',
      values: ['w1', 'grant', T0, T1],
    })
    expect(walletEntryWhere('w1', { from: T0 }).text).toBe('"walletId" = $1 AND "createdAt" >= $2')
    expect(walletEntryWhere('w1', { to: T1 }).text).toBe('"walletId" = $1 AND "createdAt" <= $2')
  })
})

describe('balance SQL', () => {
  /** The database clock is the UTC wall clock. */
  it('judges on the UTC clock', () => {
    expect(DB_NOW_SQL.text).toBe("(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")
  })

  /** A grant is due as appended when it was effective, and not yet expired, at its own createdAt. */
  it('defines due-at-append on the stored createdAt', () => {
    expect(DUE_AT_APPEND_SQL.text).toBe('(g."effectiveAt" <= g."createdAt" AND (g."expiresAt" IS NULL OR g."expiresAt" > g."createdAt"))')
  })

  /** An activation entry credits a grant by its reserved key and reason, with the same amount. */
  it('defines the activation credit by key, reason and amount', () => {
    expect(ACTIVATED_SQL.text).toContain('m."idempotencyKey" = $1 || g."id"')
    expect(ACTIVATED_SQL.text).toContain(`m."type" = 'adjustment' AND m."reason" = $2 AND m."amountNanoUsd" = g."amountNanoUsd"`)
    expect(ACTIVATED_SQL.values).toEqual(['activate:', 'grant activated'])
  })

  /** A grant is credited when it was due at append or has been activated since. */
  it('credits a grant that was due at append or activated', () => {
    expect(CREDITED_SQL.text).toBe(`(${DUE_AT_APPEND_SQL.text} OR ${ACTIVATED_SQL.text})`)
  })

  /** The remainder of a grant is its amount less its debit allocations. */
  it('computes the remainder from the allocations', () => {
    expect(GRANT_REMAINING_SQL.text).toBe(
      '(g."amountNanoUsd" - COALESCE((SELECT SUM(a."amountNanoUsd") FROM "ai_wallet_debit_allocations" a WHERE a."grantEntryId" = g."id"), 0))',
    )
  })

  /** The signed balance counts every entry but a grant that was not due as appended. */
  it('sums the entries except a grant that was not due as appended', () => {
    expect(SIGNED_BALANCE_SQL.text).toContain(`g."walletId" = w."id" AND (g."type" <> 'grant' OR ${DUE_AT_APPEND_SQL.text})`)
  })

  /** The spendable balance subtracts the unspent remainder of credited grants that have expired. */
  it('subtracts the remainder of credited, expired grants', () => {
    const sql = spendableBalanceSql().text
    expect(sql).toContain(SIGNED_BALANCE_SQL.text)
    expect(sql).toContain(`SELECT COALESCE(SUM(${GRANT_REMAINING_SQL.text}), 0)`)
    expect(sql).toContain(`g."walletId" = w."id" AND g."type" = 'grant' AND ${CREDITED_SQL.text}`)
    expect(sql).toContain(`AND g."expiresAt" IS NOT NULL AND g."expiresAt" <= ${DB_NOW_SQL.text}`)
  })
})

describe('budget windows', () => {
  /** A named window is stored as its name and a custom one as `custom:<seconds>`. */
  it('serializes and parses every window kind', () => {
    expect(serializeWindow('day')).toBe('day')
    expect(serializeWindow('total')).toBe('total')
    expect(serializeWindow({ customSeconds: 3600 })).toBe('custom:3600')
    expect(parseWindow('week')).toBe('week')
    expect(parseWindow('month')).toBe('month')
    expect(parseWindow('custom:3600')).toEqual({ customSeconds: 3600 })
    expect(parseWindow(serializeWindow({ customSeconds: 90 }))).toEqual({ customSeconds: 90 })
  })
})

/** A budget row. */
function budgetRow(over: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: 'b1',
    tenantId: 't1',
    scopeType: 'user',
    scopeId: 'u1',
    features: ['chat.reply'],
    limitNanoUsd: 100n,
    limitTokens: 5000n,
    limitCount: 7,
    window: 'custom:60',
    anchorAt: T0,
    expiresAt: T1,
    softThresholds: [0.8, 1],
    policy: 'block',
    createdAt: T0,
    updatedAt: T2,
    ...over,
  }
}

describe('mapBudgetRow', () => {
  /** Every column maps; the token limit becomes a number and the window is parsed. */
  it('maps a fully populated row', () => {
    expect(mapBudgetRow(budgetRow())).toEqual({
      id: 'b1',
      tenantId: 't1',
      scope: { type: 'user', id: 'u1' },
      features: ['chat.reply'],
      limitNanoUsd: 100n,
      limitTokens: 5000,
      limitCount: 7,
      window: { customSeconds: 60 },
      anchorAt: T0,
      expiresAt: T1,
      softThresholds: [0.8, 1],
      policy: 'block',
      createdAt: T0,
    })
  })

  /** A null limit, an empty feature list and a null anchor or expiry are absent fields, each judged on its own. */
  it('leaves out null limits, the empty feature list, and a null anchor or expiry', () => {
    const bare = { features: [], limitNanoUsd: null, limitTokens: null, limitCount: null, anchorAt: null, expiresAt: null }
    expect(Object.keys(mapBudgetRow(budgetRow(bare))).sort()).toEqual(['createdAt', 'id', 'policy', 'scope', 'softThresholds', 'tenantId', 'window'])
    expect('features' in mapBudgetRow(budgetRow({ ...bare, features: ['x'] }))).toBe(true)
    expect(mapBudgetRow(budgetRow({ ...bare, limitNanoUsd: 0n })).limitNanoUsd).toBe(0n)
    expect(mapBudgetRow(budgetRow({ ...bare, limitTokens: 0n })).limitTokens).toBe(0)
    expect(mapBudgetRow(budgetRow({ ...bare, limitCount: 0 })).limitCount).toBe(0)
    expect('anchorAt' in mapBudgetRow(budgetRow({ ...bare, anchorAt: T0 }))).toBe(true)
    expect('expiresAt' in mapBudgetRow(budgetRow({ ...bare, expiresAt: T1 }))).toBe(true)
  })
})

describe('mapBudgetWindowRow', () => {
  /** Tokens come back as numbers; cost stays a bigint. */
  it('maps the spend of a window', () => {
    expect(mapBudgetWindowRow({ id: 'w', budgetId: 'b1', windowStart: T0, spentNanoUsd: 5n, spentTokens: 9n, spentCount: 2, updatedAt: T1 })).toEqual({
      spentNanoUsd: 5n,
      spentTokens: 9,
      spentCount: 2,
    })
  })
})

describe('budget values', () => {
  const input: Omit<Budget, 'id' | 'createdAt'> = {
    tenantId: 't1',
    scope: { type: 'user', id: 'u1' },
    features: ['a'],
    limitNanoUsd: 100n,
    limitTokens: 5000,
    limitCount: 7,
    window: { customSeconds: 60 },
    anchorAt: T0,
    expiresAt: T1,
    softThresholds: [0.8, 1],
    policy: 'block',
  }

  /** A token limit is a nullable bigint at the boundary. */
  it('converts the token limit', () => {
    expect(tokenLimitSql(undefined)).toBeNull()
    expect(tokenLimitSql(0)).toBe(0n)
    expect(tokenLimitSql(5000)).toBe(5000n)
  })

  /** The values follow the column order; both timestamps use the database clock. */
  it('aligns the values with the columns and stamps both timestamps on the UTC clock', () => {
    const fragments = budgetValues('b1', input)
    expect(fragments).toHaveLength(BUDGET_COLUMNS.length)
    expect(fragments.slice(-2).map((f) => f.text)).toEqual([DB_NOW_SQL.text, DB_NOW_SQL.text])
    expect(fragments.slice(0, -2).map((f) => f.values[0])).toEqual(['b1', 't1', 'user', 'u1', ['a'], 100n, 5000n, 7, 'custom:60', T0, T1, JSON.stringify([0.8, 1]), 'block'])
    expect(fragments[4]!.text).toBe('$1::text[]')
    expect(fragments[11]!.text).toBe('$1::jsonb')
  })

  /** Absent optional fields bind as null, and absent features as an empty list. */
  it('binds absent optional fields as null and absent features as an empty list', () => {
    const { features: _f, limitNanoUsd: _n, limitTokens: _t, limitCount: _c, anchorAt: _a, expiresAt: _e, ...rest } = input
    const fragments = budgetValues('b1', rest)
    expect(fragments.slice(4, 11).map((f) => f.values[0])).toEqual([[], null, null, null, 'custom:60', null, null])
  })

  /** The conflict clause assigns every mutable column, stamps updatedAt, and never rewrites createdAt. */
  it('assigns every mutable column on conflict', () => {
    expect(rendered(budgetUpdateAssignments(input))).toEqual({
      text: [
        '"scopeType" = $1',
        '"scopeId" = $2',
        '"features" = $3::text[]',
        '"limitNanoUsd" = $4',
        '"limitTokens" = $5',
        '"limitCount" = $6',
        '"window" = $7',
        '"anchorAt" = $8',
        '"expiresAt" = $9',
        '"softThresholds" = $10::jsonb',
        '"policy" = $11',
        `"updatedAt" = ${DB_NOW_SQL.text}`,
      ].join(', '),
      values: ['user', 'u1', ['a'], 100n, 5000n, 7, 'custom:60', T0, T1, JSON.stringify([0.8, 1]), 'block'],
    })
    expect(budgetUpdateAssignments(input).text).not.toContain('createdAt')
  })

  /** Absent optional fields are assigned null, so an upsert clears what the caller left out. */
  it('clears the optional columns the caller left out', () => {
    const { features: _f, limitNanoUsd: _n, limitTokens: _t, limitCount: _c, anchorAt: _a, expiresAt: _e, ...rest } = input
    expect(budgetUpdateAssignments(rest).values).toEqual(['user', 'u1', [], null, null, null, 'custom:60', null, null, JSON.stringify([0.8, 1]), 'block'])
  })
})
