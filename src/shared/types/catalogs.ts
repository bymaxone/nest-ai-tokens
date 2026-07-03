/**
 * @fileoverview Canonical catalog types that the rest of the library is generic
 * over: provider/operation/tier unions, the metering scope, the rating mode, and
 * the pure normalizer/preset contracts. Framework-free.
 * @layer shared
 */

import type { KnownProviderId } from '../constants/provider-ids.constants'
import type { NormalizedUsage } from './normalized-usage'

/**
 * A provider identifier. Widened with `(string & {})` so custom
 * OpenAI-compatible providers can register their own id while known ids keep
 * editor autocomplete.
 */
export type ProviderId = KnownProviderId | (string & {})

/**
 * How a call is rated. `'rate-table'` computes cost from the price registry;
 * `'provider-reported'` trusts `NormalizedUsage.providerReportedCostNanoUsd`.
 */
export type RatingMode = 'rate-table' | 'provider-reported'

/** The payer subject whose wallet/budget a call consumes. */
export interface MeteringScope {
  /** `'key'` scopes spend their owner's wallet — they cannot own money. */
  type: 'tenant' | 'team' | 'user' | 'key'
  id: string
}

/** The discriminant of {@link MeteringScope}. */
export type ScopeType = MeteringScope['type']

/**
 * A pure function mapping one provider's raw `usage` object into the canonical
 * {@link NormalizedUsage} shape. Consumes plain objects — never a provider SDK.
 */
export type UsageNormalizer = (raw: unknown) => NormalizedUsage

/**
 * Pairs a normalizer with the right provider id and rating mode. Passed in
 * `MeteringContext.preset` and consumed by `meter()`, the interceptor, and
 * `record()`.
 */
export interface ProviderPreset {
  provider: ProviderId
  normalizer: UsageNormalizer
  ratingMode: RatingMode
}
