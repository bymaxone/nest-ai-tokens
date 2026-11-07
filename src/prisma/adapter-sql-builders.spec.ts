/**
 * @fileoverview Unit tests for the SQL builders of the Prisma adapter: column lists, value fragments, filters and the
 * text of the balance expressions.
 * @layer prisma
 *
 * What a statement does against PostgreSQL is covered by the end-to-end suite; what these tests pin is the text the
 * builders produce and the order of the bound values, neither of which needs a database.
 */

import type { Sql } from './sql'
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import type { Budget, LedgerFilter, NewPriceVersion } from '../shared'
import { ACTIVATED_SQL, BUDGET_COLUMNS, BUDGET_COLUMNS_SQL, CREDITED_SQL, DB_NOW_SQL, DUE_AT_APPEND_SQL, GRANT_REMAINING_SQL, PRICE_COLUMNS, PRICE_COLUMNS_SQL, SIGNED_BALANCE_SQL, USAGE_COLUMNS, USAGE_COLUMNS_SQL, budgetUpdateAssignments, budgetValues, buildWhere, priceValues, spendableBalanceSql, statusAssignments, tokenLimitSql, usageValues, walletEntryWhere } from './adapter-sql'
import { T0, T1, newRecord, rendered } from '../../test/fakes/prisma-rows'

/** The placeholder of the `number`-th parameter when its value is a date: read as a UTC wall-clock timestamp. */
const UTC_PARAMETER = (number: number): string => `($${number.toString()}::timestamptz AT TIME ZONE 'UTC')`

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

/** The value bound to each column of `usageValues` for the record of `newRecord()`. */
const EXPECTED_USAGE_VALUES: Partial<Record<(typeof USAGE_COLUMNS)[number], unknown>> = {
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

describe('usageValues', () => {
  /** The fragment bound to a named column. */
  const at = (fragments: Sql[], column: (typeof USAGE_COLUMNS)[number]): Sql => fragments[USAGE_COLUMNS.indexOf(column)]!

  /** One fragment per column: the bound values follow the column order and the two timestamps use the database clock. */
  it('aligns the values with the columns and stamps both timestamps on the UTC clock', () => {
    const fragments = usageValues('rec-1', newRecord(), 'payload', 'prev', 'hash')
    expect(fragments).toHaveLength(USAGE_COLUMNS.length)
    expect(USAGE_COLUMNS.slice(-2)).toEqual(['createdAt', 'updatedAt'])
    expect(fragments.slice(-2).map((f) => f.text)).toEqual([DB_NOW_SQL.text, DB_NOW_SQL.text])
    for (const [column, value] of Object.entries(EXPECTED_USAGE_VALUES)) {
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
        `"occurredAt" >= ${UTC_PARAMETER(16)}`,
        `"occurredAt" <= ${UTC_PARAMETER(17)}`,
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

describe('walletEntryWhere', () => {
  /** The wallet is always the first condition, and each filter field adds its own. */
  it('filters by wallet, type and the creation window', () => {
    expect(rendered(walletEntryWhere('w1', {}))).toEqual({ text: '"walletId" = $1', values: ['w1'] })
    expect(rendered(walletEntryWhere('w1', { type: 'grant', from: T0, to: T1 }))).toEqual({
      text: `"walletId" = $1 AND "type" = $2 AND "createdAt" >= ${UTC_PARAMETER(3)} AND "createdAt" <= ${UTC_PARAMETER(4)}`,
      values: ['w1', 'grant', T0, T1],
    })
    expect(walletEntryWhere('w1', { from: T0 }).text).toBe(`"walletId" = $1 AND "createdAt" >= ${UTC_PARAMETER(2)}`)
    expect(walletEntryWhere('w1', { to: T1 }).text).toBe(`"walletId" = $1 AND "createdAt" <= ${UTC_PARAMETER(2)}`)
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
        `"anchorAt" = ${UTC_PARAMETER(8)}`,
        `"expiresAt" = ${UTC_PARAMETER(9)}`,
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
