/**
 * @fileoverview Catalog of response service tiers. Providers may silently
 * downgrade a request (OpenAI returns `service_tier: "default"` when priority
 * capacity is exhausted), so pricing keys off the tier reported in the RESPONSE,
 * which is what the normalizers read (see spec §5.1).
 * @layer shared
 */

/**
 * Service tier of the actual response. `'batch'` is the Batch API (~50% discount);
 * `'flex'` is OpenAI flex processing (batch rates, synchronous); `'priority'` is
 * paid premium; `'standard'` is the default.
 */
export const SERVICE_TIERS = ['standard', 'batch', 'flex', 'priority'] as const

/** A response service tier. */
export type ServiceTier = (typeof SERVICE_TIERS)[number]
