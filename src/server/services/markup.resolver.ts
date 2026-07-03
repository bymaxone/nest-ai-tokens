/**
 * @fileoverview `MarkupResolver` — the internal per-call markup engine (spec §7.2).
 * Resolves the billed/raw multiplier from either a static number (validated and
 * rounded to 4 dp at init) or an `IMarkupPolicy` (resolved and validated per call),
 * and returns the resolved 4-dp value plus a bound `applyMarkup` so the caller
 * persists exactly what was applied. Markup applies in BOTH rating modes (§2.3) —
 * the returned `apply` is used on a rate-table cost and on a provider-reported cost
 * alike. A policy that throws or returns an invalid multiplier fails the call with
 * `AI_TOKENS_INVALID_CONFIG` — never a silent `1.0` fallback. Internal: not part of
 * the public barrel; the module registers it.
 * @layer server
 */

import { Injectable } from '@nestjs/common'
import { applyMarkup, resolveMultiplier4dp } from '../../shared'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import type { IMarkupPolicy } from '../interfaces'

/** The per-call context an `IMarkupPolicy` receives (spec §7.2). */
export type MarkupContext = Parameters<IMarkupPolicy['resolve']>[0]

/** The resolved markup: the 4-dp multiplier actually applied plus a bound applier. */
export interface ResolvedMarkup {
  /** The resolved 4-dp multiplier — persist this on the record. */
  multiplier: number
  /** Apply the resolved multiplier to a raw provider cost, exact bigint nano-USD. */
  apply: (rawCostNanoUsd: bigint) => bigint
}

/** Build a {@link ResolvedMarkup} for an already-validated 4-dp multiplier. */
function buildResolvedMarkup(multiplier: number): ResolvedMarkup {
  return { multiplier, apply: (rawCostNanoUsd: bigint): bigint => applyMarkup(rawCostNanoUsd, multiplier) }
}

@Injectable()
export class MarkupResolver {
  /**
   * @param options The resolved options carrying the markup (a 4-dp number or a policy).
   */
  constructor(private readonly options: Pick<ResolvedAiTokensOptions, 'markup'>) {}

  /**
   * Resolve the markup for one call. A static multiplier is returned as-is (it was
   * validated and rounded to 4 dp at init); a policy is invoked with the full
   * context, and its result is validated and rounded to 4 dp.
   *
   * @param context The scope/provider/model/operation/serviceTier/feature context.
   * @returns The resolved 4-dp multiplier and a bound applier.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when a policy throws or returns an invalid value.
   */
  async resolve(context: MarkupContext): Promise<ResolvedMarkup> {
    const { markup } = this.options
    if (typeof markup === 'number') return buildResolvedMarkup(markup)
    return buildResolvedMarkup(this.validate(await this.invokePolicy(markup, context)))
  }

  /** Invoke a host policy, wrapping any failure as an invalid-config error. */
  private async invokePolicy(policy: IMarkupPolicy, context: MarkupContext): Promise<number> {
    try {
      return await policy.resolve(context)
    } catch {
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
        reason: 'markup policy failed to resolve a multiplier',
      })
    }
  }

  /** Validate + round a policy's multiplier to 4 dp, or fail the call. */
  private validate(raw: number): number {
    try {
      return resolveMultiplier4dp(raw)
    } catch {
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
        reason: 'markup policy returned an invalid multiplier',
        value: raw,
      })
    }
  }
}
