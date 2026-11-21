/**
 * @fileoverview The fields of the inputs the library reads by name. A snapshot of a host's input reads the fields listed here, each once
 * and by its name, and no others: an enumeration of the host's object would depend on what the object is (a class with getters, a field
 * defined as not enumerable, an object of another realm), while a name is read the same way from all of them. Each list is typed with
 * the keys of its input, so that the compiler refuses a list that misses a field or names one the input does not have.
 * @layer server
 */

// Stryker disable BooleanLiteral: equivalent: a list is read for its names, and the `true` of each is never looked at; this file must stay data-only, so that no boolean with a meaning is ever hidden under this directive
import type { MeteringScope, PriceVersion, ReportFilter, WalletRef, LedgerFilter } from '../../shared'
import type { WalletEntryFilter } from '../interfaces'
import type { ResolveRateInput } from '../services/pricing.service'
import type { AdjustInput, DebitInput, GrantInput, RefundInput } from '../services/wallet.service'
import type { UpsertBudgetInput } from '../services/budget.service'
import type { SummarizeInput } from '../services/usage-report.service'

/** Every key of `T` mapped to `true`: a list of the fields of `T` that the compiler checks for a missing or an extra name. */
export type FieldList<T> = { readonly [K in keyof Required<T>]: true }

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
export const WALLET_ENTRY_FILTER_FIELDS: FieldList<WalletEntryFilter> = { from: true, to: true, type: true, limit: true, offset: true }

/** The fields of a grant. */
export const GRANT_FIELDS: FieldList<GrantInput> = { amountNanoUsd: true, priority: true, effectiveAt: true, expiresAt: true, idempotencyKey: true, reason: true }

/** The fields of a debit. */
export const DEBIT_FIELDS: FieldList<DebitInput> = { amountNanoUsd: true, usageRecordId: true, idempotencyKey: true, reason: true }

/** The fields of a refund. */
export const REFUND_FIELDS: FieldList<RefundInput> = { amountNanoUsd: true, usageRecordId: true, idempotencyKey: true, reason: true }

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
