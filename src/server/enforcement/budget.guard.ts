/**
 * @fileoverview `BudgetGuard` — the CanActivate enforcement gate (spec §11.3). It
 * resolves the caller's metering context via the host-configured `scopeResolver`
 * (TRUSTED INPUT — the host's VERIFIED auth context only, never client body/query,
 * §14.4), merges the decorator config (feature precedence `@RequireBudget` >
 * `@Meter` > `@AiFeature`), and checks budget status. If any matching HARD (`block`)
 * budget is exhausted it throws `AI_TOKENS_BUDGET_EXCEEDED` (402, spend) or
 * `AI_TOKENS_QUOTA_EXCEEDED` (429, tokens/count) BEFORE the handler runs; otherwise
 * it enriches the request with `request.aiTokens = { status, context }` and returns
 * true. This is CHECK-ONLY — it performs NO consumption; the §10.8 atomic consume
 * still protects the actual charge at record/capture time (the documented gate
 * race). A missing `scopeResolver` fails fast at guard construction. When
 * `@RequireBudget.estimate` is present the guard additionally places a hold and
 * attaches it to `request.aiTokens.hold` so the `MeteringInterceptor` settles it
 * with the handler's actual usage (spec §11.3).
 * @layer server
 */

import { effectivePolicy } from '../utils/enum-guards'
import { settled } from '../utils/host-settled'
import { Inject, Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { BudgetStatus } from '../../shared'
import { BYMAX_AI_TOKENS_OPTIONS } from '../bymax-ai-tokens.constants'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import type { Hold, MeteringContext } from '../interfaces'
import { BudgetService, MeteringService, PricingService } from '../services'
import { suppliedDetails } from '../utils/detail-text'
import { fieldOf, fieldsOf } from '../utils/field-names'
import { AI_FEATURE_METADATA, METER_METADATA, REQUIRE_BUDGET_METADATA, meterConfigOf, requireBudgetOf } from './decorators'
import type { MeterConfig, RequireBudgetConfig } from './decorators'
import { assertSettlePriceable } from './settle-priceable'

/** The request enrichment the guard attaches (the `AIGenerationGuard` parity contract). */
export interface RequestAiTokens {
  status: BudgetStatus[]
  context: MeteringContext
  /** Present when `@RequireBudget.estimate` placed a hold; the interceptor settles it. */
  hold?: Hold
}

/**
 * NestJS guard that checks budget status before each request and enriches
 * `request.aiTokens` with the scope's current usage. Optionally places a
 * spend hold when `@RequireBudget.estimate` is configured (see file overview).
 */
@Injectable()
export class BudgetGuard implements CanActivate {
  private readonly scopeResolver: (ctx: ExecutionContext) => MeteringContext | Promise<MeteringContext>

  /**
   * @param budgets The budget service (status check).
   * @param metering The metering facade (hold placement in `@RequireBudget.estimate` mode).
   * @param reflector The NestJS reflector (decorator metadata).
   * @param options The resolved options carrying the required `scopeResolver`.
   * @param pricing The pricing service the settle preflight asks; a guard built by hand without it skips the preflight.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when `scopeResolver` is absent (fail-fast at init).
   */
  constructor(
    @Inject(BudgetService) private readonly budgets: BudgetService,
    @Inject(MeteringService) private readonly metering: MeteringService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(BYMAX_AI_TOKENS_OPTIONS) private readonly options: Pick<ResolvedAiTokensOptions, 'scopeResolver'> & Partial<Pick<ResolvedAiTokensOptions, 'ratingMode' | 'pricing'>>,
    @Inject(PricingService) private readonly pricing?: PricingService,
  ) {
    if (options.scopeResolver === undefined) {
      // Stryker disable next-line ObjectLiteral: error context is internal diagnostics; tests check error code only
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
        // Stryker disable next-line StringLiteral: error reason text is internal diagnostics
        reason: 'BudgetGuard requires options.scopeResolver to resolve the caller scope',
      })
    }
    this.scopeResolver = options.scopeResolver
  }

  /**
   * Resolve the scope, merge decorator config, and block on any exhausted hard
   * budget; otherwise enrich the request and allow.
   *
   * @param executionContext The request execution context.
   * @returns `true` when the request may proceed.
   * @throws {AiTokensException} `AI_TOKENS_BUDGET_EXCEEDED` / `AI_TOKENS_QUOTA_EXCEEDED` when a hard budget is exhausted (or an estimate shortfall from the placed hold).
   */
  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const context = await settled(this.scopeResolver(executionContext))
    const targets = [executionContext.getHandler(), executionContext.getClass()]
    const meter = meterConfigOf(this.reflector.getAllAndOverride<MeterConfig | undefined>(METER_METADATA, targets))
    const requireBudget = requireBudgetOf(this.reflector.getAllAndOverride<RequireBudgetConfig | undefined>(REQUIRE_BUDGET_METADATA, targets))
    const aiFeature = this.reflector.getAllAndOverride<string | undefined>(AI_FEATURE_METADATA, targets)
    const feature = requireBudget?.feature ?? meter?.feature ?? aiFeature ?? context.feature
    const statuses = await this.budgets.status(context.tenantId, context.scope)
    for (const status of statuses) {
      const error = exhaustedError(status, feature)
      if (error !== null) throw error
    }
    const meterContext: MeteringContext = { ...context, feature, ...(meter?.preset !== undefined ? { preset: meter.preset } : {}) }
    if (requireBudget?.estimate !== undefined) await assertSettlePriceable(requireBudget.estimate, meterContext, this.pricing, this.options)
    const hold = requireBudget?.estimate !== undefined ? await this.metering.hold(meterContext, requireBudget.estimate) : undefined
    const request = executionContext.switchToHttp().getRequest<{ aiTokens?: RequestAiTokens }>()
    request.aiTokens = { status: statuses, context: meterContext, ...(hold !== undefined ? { hold } : {}) }
    return true
  }
}

/** Every dimension a budget limits, mapped to `true` so that the compiler keeps the list complete. */
const LIMIT_FIELDS: { readonly [K in keyof Required<BudgetStatus['limit']>]: true } = { nanoUsd: true, tokens: true, count: true }

/** Whether a budget's feature filter matches the request feature (empty/absent = all). */
function featureMatches(features: string[] | undefined, feature: string): boolean {
  return features === undefined || features.length === 0 || features.includes(feature)
}

/**
 * The dimension-specific typed error for a HARD budget with no headroom on a
 * limited dimension for this feature (cost → 402, tokens/count → 429), or `null`
 * when the budget is soft, does not apply to the feature, or still has headroom.
 */
function exhaustedError(status: BudgetStatus, feature: string): AiTokensException | null {
  if (effectivePolicy(status.policy) !== 'block' || !featureMatches(fieldOf(status, 'features') as string[] | undefined, feature)) return null
  // A dimension the budget does not limit is absent from its limit, so the limit is read as fields: a key planted on Object.prototype is no limit.
  const limit = fieldsOf(status.limit, LIMIT_FIELDS)
  if (limit.nanoUsd !== undefined && status.spent.nanoUsd >= limit.nanoUsd) {
    // Stryker disable next-line ObjectLiteral,StringLiteral: error context is internal diagnostics; tests check error code only
    return new AiTokensException('AI_TOKENS_BUDGET_EXCEEDED', undefined, suppliedDetails({ budgetId: status.budgetId, dimension: 'cost' }))
  }
  // Stryker disable next-line ConditionalExpression: CE true on `limit.tokens !== undefined` is equivalent: with it forced true, the remaining `status.spent.tokens >= limit.tokens` compares a number against `undefined` (NaN), which is always false, so a budget with no tokens limit never yields a spurious quota error
  if (limit.tokens !== undefined && status.spent.tokens >= limit.tokens) {
    // Stryker disable next-line ObjectLiteral,StringLiteral: error context is internal diagnostics
    return new AiTokensException('AI_TOKENS_QUOTA_EXCEEDED', undefined, suppliedDetails({ budgetId: status.budgetId, dimension: 'tokens' }))
  }
  // Stryker disable next-line ConditionalExpression: CE true on `limit.count !== undefined` is equivalent: with it forced true, the remaining `status.spent.count >= limit.count` compares a number against `undefined` (NaN), which is always false, so a budget with no count limit never yields a spurious quota error
  if (limit.count !== undefined && status.spent.count >= limit.count) {
    // Stryker disable next-line ObjectLiteral,StringLiteral: error context is internal diagnostics
    return new AiTokensException('AI_TOKENS_QUOTA_EXCEEDED', undefined, suppliedDetails({ budgetId: status.budgetId, dimension: 'count' }))
  }
  return null
}
