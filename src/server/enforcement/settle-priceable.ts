/**
 * @fileoverview The one refusal the guard makes before it places a hold: a `{ tokens }` or `{ amountNanoUsd }` estimate whose settle,
 * priced under a rate table in strict pricing, can only fail after the provider call.
 * @layer server
 */

import type { ProviderPreset } from '../../shared'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import type { HoldEstimate, MeteringContext } from '../interfaces'
import type { PricingService } from '../services'

/**
 * Refuse, before any handler or reservation, an estimate whose settle would be refused with `AI_TOKENS_PRICE_NOT_FOUND` after the provider
 * call, with the served usage released unbilled. The settle prices the row the hold writes, so this asks the pricing service the question
 * `capture()` will ask, of the same identity: the preset's provider (else `unspecified`), `context.baseModel` as the model (else the
 * placeholder `unspecified`, which no rate table lists), chat, the context's tier, and `baseModel` as the requested model. A listed
 * `baseModel` therefore passes and an unlisted one is refused, as is none. A rated estimate (it names its own provider and model, and the
 * hold already prices it), a provider-reported mode and non-strict pricing (an unpriced call is recorded at 0 USD by design) pass. The
 * guard asks this; a direct `hold()` does not.
 *
 * The mode is the one `capture()` rates with: the preset's, else the module's. A rating mode a scope resolver puts on its context is read
 * by `record()` only, so it plays no part in the settle of a hold.
 *
 * @param estimate The `@RequireBudget` estimate.
 * @param context The context the hold will be placed with (feature and preset merged in).
 * @param pricing The pricing service; a guard built by hand without it has no strict pricing to protect.
 * @param options The resolved module options, which carry the rating mode and whether pricing is strict.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when the settle of the estimate has no price.
 */
export async function assertSettlePriceable(
  estimate: HoldEstimate,
  context: MeteringContext & { preset?: ProviderPreset },
  pricing: PricingService | undefined,
  options: Partial<Pick<ResolvedAiTokensOptions, 'ratingMode' | 'pricing'>>,
): Promise<void> {
  if ('provider' in estimate || pricing === undefined || options.pricing?.strict !== true) return
  if ((context.preset?.ratingMode ?? options.ratingMode) !== 'rate-table') return
  try {
    await pricing.resolveRate({
      provider: context.preset?.provider ?? 'unspecified',
      model: context.baseModel ?? 'unspecified',
      operation: 'chat',
      serviceTier: context.serviceTier ?? 'standard',
      at: new Date(),
      ...(context.baseModel !== undefined ? { baseModel: context.baseModel } : {}),
    })
  } catch (error) {
    if (!(error instanceof AiTokensException) || (error.getResponse() as { error: { code: string } }).error.code !== 'AI_TOKENS_PRICE_NOT_FOUND') throw error
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
      reason:
        'the settle of a { tokens } or { amountNanoUsd } estimate prices the model context.baseModel, and the price list has none for it; set baseModel to a listed model, or give the estimate its provider and model',
    })
  }
}
