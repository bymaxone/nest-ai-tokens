/**
 * @fileoverview The markup-policy port (spec §7.2). Resolves the markup
 * multiplier per call from the scope/model/feature context. Resolved once per
 * record; the resolved 4-dp value is persisted. A throwing policy fails the call
 * (never a silent 1.0 fallback).
 * @layer server
 */

import type { AiOperation, MeteringScope, ProviderId, ServiceTier } from '../../shared'

/** A host policy that varies the markup multiplier per call. */
export interface IMarkupPolicy {
  /** Return the multiplier for this call (validated finite and `> 0`; sync or async). */
  resolve(ctx: {
    scope: MeteringScope
    provider: ProviderId
    model: string
    operation: AiOperation
    serviceTier: ServiceTier
    feature?: string
  }): number | Promise<number>
}
