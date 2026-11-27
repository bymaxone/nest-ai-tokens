/**
 * @fileoverview The fields of the inputs the library reads by name. A snapshot of a host's input reads the fields listed here, each once
 * and by its name, and no others: an enumeration of the host's object would depend on what the object is (a class with getters, a field
 * defined as not enumerable, an object of another realm), while a name is read the same way from all of them. Each list is typed with
 * the keys of its input, so that the compiler refuses a list that misses a field or names one the input does not have.
 * @layer server
 */

import type { MeteringScope, NormalizedUsage, PriceVersion, ProviderId, ProviderPreset, ReportFilter, WalletRef, LedgerFilter } from '../../shared'
import type { Hold, HoldCaller, HoldEstimate, MeteringContext, WalletEntryFilter } from '../interfaces'
import type { EstimateCostInput, RecordInput } from '../services/metering.service'
import type { SettleAdjustmentInput } from '../services/wallet.service'
import type { ResolveRateInput } from '../services/pricing.service'
import type { AdjustInput, BalanceOptions, DebitInput, GrantInput, RefundInput } from '../services/wallet.service'
import type { UpsertBudgetInput } from '../services/budget.service'
import type { SummarizeInput } from '../services/usage-report.service'

/** Every key of `T` mapped to `true`: a list of the fields of `T` that the compiler checks for a missing or an extra name. */
export type FieldList<T> = { readonly [K in keyof Required<T>]: true }

/** What a snapshot reads of an object: its fields, and the objects among them that are read by their own fields in turn. */
export interface Shape {
  readonly fields: object
  readonly nested?: Readonly<Record<string, Shape>>
  /** The fields read by name and returned as they are, because the library reads them later by the names of their own type. */
  readonly raw?: readonly string[]
  /** The deepest nesting allowed in the named fields that are copied, where it is not the default of an argument. */
  readonly limits?: Readonly<Record<string, number>>
}

/** The variant of a hold estimate that is rated by model. */
type RatedHoldEstimate = Extract<HoldEstimate, { provider: ProviderId }>

/** The fields of a scope. */
export const SCOPE_FIELDS: FieldList<MeteringScope> = { type: true, id: true }

/** The fields of the reference of a wallet. */
export const WALLET_REF_FIELDS: FieldList<WalletRef> = { tenantId: true, ownerType: true, ownerId: true }

/** The fields of a ledger filter. */
export const LEDGER_FILTER_FIELDS: FieldList<LedgerFilter> = {
  tenantId: true,
  scope: true,
  beneficiary: true,
  feature: true,
  features: true,
  provider: true,
  model: true,
  operation: true,
  serviceTier: true,
  tags: true,
  isSystemCost: true,
  systemCostCategory: true,
  status: true,
  enforcedOnly: true,
  from: true,
  to: true,
  limit: true,
  offset: true,
}

/** The fields of a report filter with the grouping of a summary. */
export const SUMMARIZE_FIELDS: FieldList<SummarizeInput> = {
  tenantId: true,
  scope: true,
  beneficiary: true,
  feature: true,
  features: true,
  provider: true,
  model: true,
  operation: true,
  serviceTier: true,
  tags: true,
  isSystemCost: true,
  systemCostCategory: true,
  enforcedOnly: true,
  status: true,
  from: true,
  to: true,
  groupBy: true,
}

/** The fields of a report filter. */
export const REPORT_FILTER_FIELDS: FieldList<ReportFilter> = {
  tenantId: true,
  scope: true,
  beneficiary: true,
  feature: true,
  features: true,
  provider: true,
  model: true,
  operation: true,
  serviceTier: true,
  tags: true,
  isSystemCost: true,
  systemCostCategory: true,
  enforcedOnly: true,
  status: true,
  from: true,
  to: true,
}

/** The fields of a filter of wallet entries. */
export const WALLET_ENTRY_FILTER_FIELDS: FieldList<WalletEntryFilter> = { from: true, to: true, type: true, limit: true, offset: true, order: true }

/** The fields of a grant. */
export const GRANT_FIELDS: FieldList<GrantInput> = { amountNanoUsd: true, priority: true, effectiveAt: true, expiresAt: true, idempotencyKey: true, reason: true }

/** The fields of a debit. */
export const DEBIT_FIELDS: FieldList<DebitInput> = { amountNanoUsd: true, usageRecordId: true, idempotencyKey: true, reason: true }

/** The fields of a refund. */
export const REFUND_FIELDS: FieldList<RefundInput> = { amountNanoUsd: true, usageRecordId: true, idempotencyKey: true, reason: true, restore: true, debitEntryId: true }

/** The fields of the options of a balance read. */
export const BALANCE_OPTION_FIELDS: FieldList<BalanceOptions> = { asOf: true }

/** The fields of an adjustment. */
export const ADJUST_FIELDS: FieldList<AdjustInput> = { amountNanoUsd: true, idempotencyKey: true, reason: true }

/** The fields of a budget definition. */
export const UPSERT_BUDGET_FIELDS: FieldList<UpsertBudgetInput> = {
  id: true,
  tenantId: true,
  scope: true,
  features: true,
  limitNanoUsd: true,
  limitTokens: true,
  limitCount: true,
  window: true,
  anchorAt: true,
  expiresAt: true,
  softThresholds: true,
  policy: true,
}

/** The fields of a new price version. */
export const PRICE_FIELDS: FieldList<Omit<PriceVersion, 'id' | 'effectiveTo'>> = {
  provider: true,
  model: true,
  operation: true,
  serviceTier: true,
  inputNanoUsdPerMillion: true,
  outputNanoUsdPerMillion: true,
  cacheReadNanoUsdPerMillion: true,
  cacheWrite5mNanoUsdPerMillion: true,
  cacheWrite1hNanoUsdPerMillion: true,
  reasoningNanoUsdPerMillion: true,
  audioInNanoUsdPerMillion: true,
  audioOutNanoUsdPerMillion: true,
  imageInNanoUsdPerMillion: true,
  imageOutNanoUsdPerMillion: true,
  tierThresholdTokens: true,
  tierInputNanoUsdPerMillion: true,
  tierOutputNanoUsdPerMillion: true,
  unitRates: true,
  currency: true,
  effectiveFrom: true,
  source: true,
}

/** The fields of the input of a rate lookup. */
export const RESOLVE_RATE_FIELDS: FieldList<ResolveRateInput> = { provider: true, model: true, operation: true, at: true, serviceTier: true, baseModel: true }

/** The fields of a provider preset. */
export const PRESET_FIELDS: FieldList<ProviderPreset> = { provider: true, normalizer: true, ratingMode: true }

/** The fields of the content a capture or a record may carry. */
export const CONTENT_FIELDS: FieldList<{ prompt?: string; completion?: string }> = { prompt: true, completion: true }

/** The fields of a metering context. */
export const METERING_CONTEXT_FIELDS: FieldList<MeteringContext> = {
  tenantId: true,
  scope: true,
  beneficiary: true,
  requestedBy: true,
  feature: true,
  tags: true,
  preset: true,
  ratingMode: true,
  baseModel: true,
  serviceTier: true,
  extraUnits: true,
  idempotencyKey: true,
  correlationId: true,
  enforce: true,
  isSystemCost: true,
  systemCostCategory: true,
}

/** The fields of the input of a record. */
export const RECORD_INPUT_FIELDS: FieldList<RecordInput> = { usage: true, preset: true, normalizer: true, context: true, occurredAt: true, content: true }

/** The fields of the input of a cost estimate. */
export const ESTIMATE_COST_FIELDS: FieldList<EstimateCostInput> = {
  provider: true,
  model: true,
  operation: true,
  serviceTier: true,
  inputTokens: true,
  maxOutputTokens: true,
  at: true,
  scope: true,
  feature: true,
}

/** The fields of the estimate of a hold that is rated by model. */
export const RATED_ESTIMATE_FIELDS: FieldList<RatedHoldEstimate> = {
  provider: true,
  model: true,
  operation: true,
  serviceTier: true,
  inputTokens: true,
  maxOutputTokens: true,
}

/** The fields of the estimate of a hold that is sized in nano-USD. */
export const AMOUNT_ESTIMATE_FIELDS: FieldList<{ amountNanoUsd: bigint }> = { amountNanoUsd: true }

/** The fields of the signed adjustment a capture settles. */
export const SETTLE_ADJUSTMENT_FIELDS: FieldList<SettleAdjustmentInput> = { amountNanoUsd: true, usageRecordId: true, idempotencyKey: true, reason: true }

/** The fields of a hold. */
export const HOLD_FIELDS: FieldList<Hold> = { id: true, tenantId: true, scope: true, estimatedTokens: true, estimatedCostNanoUsd: true, expiresAt: true }

/** The fields of the caller of a capture or a release. */
export const HOLD_CALLER_FIELDS: FieldList<HoldCaller> = { tenantId: true, scope: true }

const SCOPE_SHAPE: Shape = { fields: SCOPE_FIELDS }
/** A provider preset read by name. */
export const PRESET_SHAPE: Shape = { fields: PRESET_FIELDS }
/** The content of a capture or a record read by name. */
export const CONTENT_SHAPE: Shape = { fields: CONTENT_FIELDS }

/** A metering context read by name, its scopes and preset by name. */
export const CONTEXT_SHAPE: Shape = { fields: METERING_CONTEXT_FIELDS, nested: { scope: SCOPE_SHAPE, beneficiary: SCOPE_SHAPE, preset: PRESET_SHAPE } }

/** The input of a record read by name, its context, preset and content by name. */
export const RECORD_SHAPE: Shape = { fields: RECORD_INPUT_FIELDS, nested: { context: CONTEXT_SHAPE, preset: PRESET_SHAPE, content: CONTENT_SHAPE }, raw: ['usage'] }

/** The input of a cost estimate read by name. */
export const ESTIMATE_COST_SHAPE: Shape = { fields: ESTIMATE_COST_FIELDS, nested: { scope: SCOPE_SHAPE } }

/** A hold read by name. */
export const HOLD_SHAPE: Shape = { fields: HOLD_FIELDS, nested: { scope: SCOPE_SHAPE } }

/** The caller of a capture or a release read by name. */
export const HOLD_CALLER_SHAPE: Shape = { fields: HOLD_CALLER_FIELDS, nested: { scope: SCOPE_SHAPE } }

/** The fields of a usage that is already normalized. */
export const NORMALIZED_USAGE_FIELDS: FieldList<NormalizedUsage> = {
  provider: true,
  model: true,
  operation: true,
  serviceTier: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWrite5mTokens: true,
  cacheWrite1hTokens: true,
  reasoningTokens: true,
  audioInTokens: true,
  audioOutTokens: true,
  imageInTokens: true,
  imageOutTokens: true,
  serverToolUse: true,
  providerReportedCostNanoUsd: true,
  raw: true,
}
