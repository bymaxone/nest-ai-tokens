/**
 * @fileoverview Row and record fixtures for the Prisma adapter's unit specs: fully populated rows of each table, the
 * rows with their nullable columns null, and a helper that renders a SQL fragment for exact assertions.
 * @layer test
 */

import type { Sql } from '../../src/prisma/sql'
import { mapUsageRow, type BudgetRow, type PriceRow, type UsageRow, type WalletEntryRow } from '../../src/prisma/adapter-sql'
import type { NewUsageRecord } from '../../src/shared'

/** The first of three fixed instants, a day apart, that the fixtures spread over their date fields so that a swapped field shows. */
export const T0 = new Date('2026-06-01T00:00:00.000Z')
/** The second fixed instant, a day after {@link T0}. */
export const T1 = new Date('2026-06-02T00:00:00.000Z')
/** The third fixed instant, a day after {@link T1}. */
export const T2 = new Date('2026-06-03T00:00:00.000Z')

/** The identity, scope and model columns of a fully populated usage row. */
function usageIdentity(): Pick<UsageRow, 'id' | 'tenantId' | 'scopeType' | 'scopeId' | 'beneficiaryType' | 'beneficiaryId' | 'requestedBy' | 'provider' | 'model' | 'requestedModel' | 'operation' | 'serviceTier' | 'feature' | 'tags'> {
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
  }
}

/** The token counts and extra units of a fully populated usage row. */
function usageCounts(): Pick<UsageRow, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWrite5mTokens' | 'cacheWrite1hTokens' | 'reasoningTokens' | 'audioInTokens' | 'audioOutTokens' | 'imageInTokens' | 'imageOutTokens' | 'totalTokens' | 'extraUnits'> {
  return {
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
  }
}

/** The price, cost, status, link and timestamp columns of a fully populated usage row. */
function usageLedger(): Omit<UsageRow, keyof ReturnType<typeof usageIdentity> | keyof ReturnType<typeof usageCounts>> {
  return {
    priceVersionId: 'price-1',
    rawCostNanoUsd: 11n,
    surchargeNanoUsd: 12n,
    billedCostNanoUsd: 13n,
    markupMultiplier: { toNumber: () => 1.5 },
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
  }
}

/** A fully populated usage row; `over` replaces the fields under test. */
export function usageRow(over: Partial<UsageRow> = {}): UsageRow {
  return { ...usageIdentity(), ...usageCounts(), ...usageLedger(), ...over }
}

/** A usage row with every nullable column null. */
export function bareUsageRow(): UsageRow {
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
export function newRecord(over: Partial<NewUsageRecord> = {}): NewUsageRecord {
  const { id: _id, prevHash: _prev, hash: _hash, createdAt: _created, updatedAt: _updated, ...rest } = mapUsageRow(usageRow())
  return { ...rest, ...over }
}

/** The text of a fragment with its bound values, for exact assertions. */
export function rendered(sql: Sql): { text: string; values: readonly unknown[] } {
  return { text: sql.text, values: sql.values }
}

/** A fully populated price row. */
export function priceRow(over: Partial<PriceRow> = {}): PriceRow {
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

/** A wallet entry row. */
export function entryRow(over: Partial<WalletEntryRow> = {}): WalletEntryRow {
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

/** A budget row. */
export function budgetRow(over: Partial<BudgetRow> = {}): BudgetRow {
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
