/**
 * @fileoverview The pricing persistence port (spec §15.1). Effective-dated rate
 * resolution, append-only price upserts, and the model list that powers §6.6
 * prefix matching.
 * @layer server
 */

import type { AiOperation, NewPriceVersion, PriceVersion, ProviderId, ServiceTier } from '../../shared'

/** A distinct priced model tuple, returned by {@link IPricingStore.listModels}. */
export interface PricedModel {
  model: string
  operation: AiOperation
  serviceTier: ServiceTier
}

/** The effective-dated price registry port. */
export interface IPricingStore {
  /** The price row in effect at `at` for the tuple, or `null` when none matches. */
  resolveRate(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier: ServiceTier,
    at: Date,
  ): Promise<PriceVersion | null>
  /** Close the current open row (`effectiveTo = now`) and insert the new open row. */
  upsertPrice(input: NewPriceVersion): Promise<PriceVersion>
  /**
   * Insert `input` only when no row, open or closed, exists for its
   * (provider, model, operation, serviceTier) tuple; resolves `true` when it inserted.
   * Atomic per tuple, so concurrent boots cannot both insert, and it never closes or
   * alters an existing row. The snapshot seed uses it so a restart cannot revert a rate
   * the host set with {@link IPricingStore.upsertPrice}. A store without it is seeded
   * from {@link IPricingStore.getPriceHistory} and `upsertPrice`, which is not atomic.
   */
  seedPrice?(input: NewPriceVersion): Promise<boolean>
  /** Full effective-dated history for a tuple (newest first). */
  getPriceHistory(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier?: ServiceTier,
  ): Promise<PriceVersion[]>
  /** All distinct (model, operation, serviceTier) for a provider — powers §6.6 prefix matching. */
  listModels(provider: ProviderId): Promise<PricedModel[]>
}
