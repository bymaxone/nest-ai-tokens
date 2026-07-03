/**
 * @fileoverview Append-only ledger field whitelists — the single source of truth
 * shared by the ledger service and the store adapters so the two layers can never
 * drift. `AMOUNT_FIELDS` are the money/token amounts that stay immutable after a
 * record posts; `SETTLEMENT_FIELDS` are everything a settlement (`pending →
 * posted`) may replace with actuals; `REVERSAL_LINKAGE_FIELD` is the sole
 * annotation a `posted → reversed` flip may set (see spec §8.3/§8.5).
 * @layer shared
 */

import type { UsageRecord } from '../types/usage-record'

/**
 * The money/token amount columns that are append-only once a record posts — a
 * void (`pending → released`) or a reversal annotation may never patch them.
 */
export const AMOUNT_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
  'reasoningTokens',
  'audioInTokens',
  'audioOutTokens',
  'imageInTokens',
  'imageOutTokens',
  'totalTokens',
  'rawCostNanoUsd',
  'surchargeNanoUsd',
  'billedCostNanoUsd',
] as const satisfies readonly (keyof UsageRecord)[]

/**
 * Every field a settlement (`pending → posted`) may replace with actuals: the
 * append-only amounts plus the pricing metadata resolved at settlement time.
 */
export const SETTLEMENT_FIELDS = [
  ...AMOUNT_FIELDS,
  'priceVersionId',
  'priceMissing',
  'markupMultiplier',
] as const satisfies readonly (keyof UsageRecord)[]

/** The sole field a `posted → reversed` annotation may set — the reversal linkage. */
export const REVERSAL_LINKAGE_FIELD = 'reversedByRecordId' as const satisfies keyof UsageRecord
