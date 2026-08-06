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

import { Inject, Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { BudgetStatus } from '../../shared'
import { BYMAX_AI_TOKENS_OPTIONS } from '../bymax-ai-tokens.constants'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import type { Hold, MeteringContext } from '../interfaces'
import type { BudgetService, MeteringService } from '../services'
import { AI_FEATURE_METADATA, METER_METADATA, REQUIRE_BUDGET_METADATA } from './decorators'
import type { MeterConfig, RequireBudgetConfig } from './decorators'

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
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when `scopeResolver` is absent (fail-fast at init).
   */
  constructor(
    private readonly budgets: BudgetService,
    private readonly metering: MeteringService,
    private readonly reflector: Reflector,
    @Inject(BYMAX_AI_TOKENS_OPTIONS) options: Pick<ResolvedAiTokensOptions, 'scopeResolver'>,
  ) {
    if (options.scopeResolver === undefined) {
      // Stryker disable next-line ObjectLiteral -- error context is internal diagnostics; tests check error code only
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
        // Stryker disable next-line StringLiteral -- error reason text is internal diagnostics
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
    const context = await this.scopeResolver(executionContext)
    const targets = [executionContext.getHandler(), executionContext.getClass()]
    const meter = this.reflector.getAllAndOverride<MeterConfig | undefined>(METER_METADATA, targets)
    const requireBudget = this.reflector.getAllAndOverride<RequireBudgetConfig | undefined>(REQUIRE_BUDGET_METADATA, targets)
    const aiFeature = this.reflector.getAllAndOverride<string | undefined>(AI_FEATURE_METADATA, targets)
    const feature = requireBudget?.feature ?? meter?.feature ?? aiFeature ?? context.feature
    const statuses = await this.budgets.status(context.tenantId, context.scope)
    for (const status of statuses) {
      const error = exhaustedError(status, feature)
      if (error !== null) throw error
    }
    const meterContext: MeteringContext = { ...context, feature, ...(meter?.preset !== undefined ? { preset: meter.preset } : {}) }
    const hold = requireBudget?.estimate !== undefined ? await this.metering.hold(meterContext, requireBudget.estimate) : undefined
    const request = executionContext.switchToHttp().getRequest<{ aiTokens?: RequestAiTokens }>()
    request.aiTokens = { status: statuses, context: meterContext, ...(hold !== undefined ? { hold } : {}) }
    return true
  }
}

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
  if (status.policy !== 'block' || !featureMatches(status.features, feature)) return null
  if (status.limit.nanoUsd !== undefined && status.spent.nanoUsd >= status.limit.nanoUsd) {
    // Stryker disable next-line ObjectLiteral,StringLiteral -- error context is internal diagnostics; tests check error code only
    return new AiTokensException('AI_TOKENS_BUDGET_EXCEEDED', undefined, { budgetId: status.budgetId, dimension: 'cost' })
  }
  // Stryker disable next-line ConditionalExpression -- CE true on `status.limit.tokens !== undefined` is equivalent: with it forced true, the remaining `status.spent.tokens >= status.limit.tokens` compares a number against `undefined` (NaN), which is always false, so a budget with no tokens limit never yields a spurious quota error
  if (status.limit.tokens !== undefined && status.spent.tokens >= status.limit.tokens) {
    // Stryker disable next-line ObjectLiteral,StringLiteral -- error context is internal diagnostics
    return new AiTokensException('AI_TOKENS_QUOTA_EXCEEDED', undefined, { budgetId: status.budgetId, dimension: 'tokens' })
  }
  // Stryker disable next-line ConditionalExpression -- CE true on `status.limit.count !== undefined` is equivalent: with it forced true, the remaining `status.spent.count >= status.limit.count` compares a number against `undefined` (NaN), which is always false, so a budget with no count limit never yields a spurious quota error
  if (status.limit.count !== undefined && status.spent.count >= status.limit.count) {
    // Stryker disable next-line ObjectLiteral,StringLiteral -- error context is internal diagnostics
    return new AiTokensException('AI_TOKENS_QUOTA_EXCEEDED', undefined, { budgetId: status.budgetId, dimension: 'count' })
  }
  return null
}
