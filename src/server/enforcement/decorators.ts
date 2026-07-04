/**
 * @fileoverview The controller-level metering/enforcement decorators (spec §11.4).
 * `@Meter` marks a handler for the `MeteringInterceptor` and is metadata-only
 * here; `@RequireBudget` marks it for the `BudgetGuard`; `@AiFeature`
 * is a lightweight feature tag. Each stores its config under an exported symbol key
 * that the guard/interceptor read via the NestJS `Reflector`. Feature precedence is
 * `@RequireBudget.feature` > `@Meter.feature` > `@AiFeature` (§11.4). These are pure
 * metadata; they never touch a wallet, budget, or the request.
 * @layer server
 */

import { SetMetadata } from '@nestjs/common'
import type { CustomDecorator } from '@nestjs/common'
import type { ProviderPreset, ScopeType } from '../../shared'
import type { HoldEstimate } from '../interfaces'

// Stryker disable StringLiteral -- these reflector metadata keys are used symmetrically (SetMetadata + getAllAndOverride); any unique string is equivalent
/** Reflector key for {@link Meter} metadata. */
export const METER_METADATA = 'bymax:ai-tokens:meter'
/** Reflector key for {@link RequireBudget} metadata. */
export const REQUIRE_BUDGET_METADATA = 'bymax:ai-tokens:require-budget'
/** Reflector key for {@link AiFeature} metadata. */
export const AI_FEATURE_METADATA = 'bymax:ai-tokens:ai-feature'
// Stryker restore StringLiteral

/** `@Meter` configuration — consumed by the `MeteringInterceptor`. */
export interface MeterConfig {
  /** The logical operation, e.g. `'workout.generate'`. */
  feature: string
  /** Which scope type from the resolved context to charge (default `'user'`). */
  scope?: ScopeType
  /** The normalizer + rating mode for the handler's return value. */
  preset?: ProviderPreset
  /** Pull the raw usage out of the return value (default: `result.usage`). */
  extract?: (result: unknown) => unknown
  /** Set `x-ai-tokens-*` response headers. */
  exposeHeaders?: boolean
  /** Platform-absorbed cost — never consumes wallet/budget. */
  isSystemCost?: boolean
  /** Cost-attribution labels. */
  tags?: string[]
}

/** `@RequireBudget` configuration — consumed by the `BudgetGuard`. */
export interface RequireBudgetConfig {
  /** Which scope type to enforce (default: the resolved context's scope). */
  scope?: ScopeType
  /** Budget feature-filter matching; defaults to `@Meter`'s feature. */
  feature?: string
  /** A static estimate → the guard places a hold the interceptor settles. */
  estimate?: HoldEstimate
}

/**
 * Mark a handler for metering by the `MeteringInterceptor`. Metadata-only.
 *
 * @param config The metering configuration.
 * @returns The metadata decorator.
 */
export function Meter(config: MeterConfig): CustomDecorator {
  return SetMetadata(METER_METADATA, config)
}

/**
 * Require budget headroom on a handler — the {@link BudgetGuard} blocks the request
 * pre-handler when a matching hard budget is exhausted.
 *
 * @param config The budget-enforcement configuration.
 * @returns The metadata decorator.
 */
export function RequireBudget(config: RequireBudgetConfig = {}): CustomDecorator {
  return SetMetadata(REQUIRE_BUDGET_METADATA, config)
}

/**
 * Tag a handler with a feature name (`@Meter.feature` wins when both are present).
 *
 * @param name The feature name.
 * @returns The metadata decorator.
 */
export function AiFeature(name: string): CustomDecorator {
  return SetMetadata(AI_FEATURE_METADATA, name)
}
