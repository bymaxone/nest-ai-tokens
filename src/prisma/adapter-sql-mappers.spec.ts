/**
 * @fileoverview Unit tests for the row mappers of the Prisma adapter and for the small pure rules around them: scopes,
 * unit rates, wallet entry matching and balance deltas, and budget windows.
 * @layer prisma
 *
 * What a statement does against PostgreSQL is covered by the end-to-end suite; what these tests pin is the mapping of
 * columns to fields and of nulls to absent fields, none of which needs a database.
 */

import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import type { NewWalletEntry, WalletEntry } from '../shared'
import { WalletMissingError, firstOrThrow, isWalletMissing, mapBudgetRow, mapBudgetWindowRow, mapOpenGrantRow, mapPriceRow, mapUsageRow, mapWalletEntryRow, mapWalletRow, parseUnitRates, parseWindow, scopeOf, serializeUnitRates, serializeWindow, walletAutoCreatable, walletBalanceDelta, walletEntryMatches, type WalletRow } from './adapter-sql'
import { T0, T1, T2, usageRow, bareUsageRow, priceRow, entryRow, budgetRow } from '../../test/fakes/prisma-rows'

describe('scopeOf', () => {
  /** A scope needs both columns; either one null means the scope is absent. */
  it('returns the scope only when both columns are present', () => {
    expect(scopeOf('user', 'u1')).toEqual({ type: 'user', id: 'u1' })
    expect(scopeOf(null, 'u1')).toBeUndefined()
    expect(scopeOf('user', null)).toBeUndefined()
    expect(scopeOf(null, null)).toBeUndefined()
  })
})

/** The identity, scope and model fields `usageRow()` maps to. */
const MAPPED_IDENTITY = {
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
}

/** The counts, costs, status, links and timestamps `usageRow()` maps to; the markup is a number. */
const MAPPED_LEDGER = {
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
}

describe('mapUsageRow', () => {
  /** The identity, scope and model columns map to their fields. */
  it('maps the identity and model columns of a fully populated row', () => {
    expect(mapUsageRow(usageRow())).toMatchObject(MAPPED_IDENTITY)
  })

  /** The counts, costs, status, links and timestamps map to their fields; the markup is converted from Decimal to number. */
  it('maps the counts, costs and status of a fully populated row', () => {
    expect(mapUsageRow(usageRow())).toMatchObject(MAPPED_LEDGER)
  })

  /** Together they are the whole record: the mapper adds no field and drops none. */
  it('maps exactly the columns of a fully populated row', () => {
    expect(mapUsageRow(usageRow())).toEqual({ ...MAPPED_IDENTITY, ...MAPPED_LEDGER })
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
    expect(Object.keys(none).filter((k) => /^(?:tier|unitRates)/.test(k))).toEqual([])
    expect(none.effectiveTo).toBeNull()
    expect(Object.keys(mapPriceRow(priceRow({ ...bare, tierThresholdTokens: 5 }))).filter((k) => /^(?:tier|unitRates)/.test(k))).toEqual(['tierThresholdTokens'])
    expect(Object.keys(mapPriceRow(priceRow({ ...bare, tierInputNanoUsdPerMillion: 5n }))).filter((k) => /^(?:tier|unitRates)/.test(k))).toEqual(['tierInputNanoUsdPerMillion'])
    expect(Object.keys(mapPriceRow(priceRow({ ...bare, tierOutputNanoUsdPerMillion: 5n }))).filter((k) => /^(?:tier|unitRates)/.test(k))).toEqual(['tierOutputNanoUsdPerMillion'])
    expect(Object.keys(mapPriceRow(priceRow({ ...bare, unitRates: { a: '1' } }))).filter((k) => /^(?:tier|unitRates)/.test(k))).toEqual(['unitRates'])
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
    // The grant rule does not apply to it: a debit judged as a grant would not be due yet, nor would an expired one.
    expect(walletBalanceDelta(entry({ type: 'debit', amountNanoUsd: -5n, effectiveAt: T2 }))).toBe(-5n)
    expect(walletBalanceDelta(entry({ type: 'refund', amountNanoUsd: 7n, expiresAt: T0 }))).toBe(7n)
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
