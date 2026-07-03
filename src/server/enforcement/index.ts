/**
 * @fileoverview Barrel for the enforcement layer — the `BudgetGuard` and the
 * controller decorators (`@Meter`/`@RequireBudget`/`@AiFeature`) with their
 * Reflector metadata keys (spec §11.3/§11.4).
 * @layer server
 */

export { BudgetGuard } from './budget.guard'
export type { RequestAiTokens } from './budget.guard'
export { MeteringInterceptor } from './metering.interceptor'
export type { MeteringInterceptorOptions } from './metering.interceptor'
export {
  Meter,
  RequireBudget,
  AiFeature,
  METER_METADATA,
  REQUIRE_BUDGET_METADATA,
  AI_FEATURE_METADATA,
} from './decorators'
export type { MeterConfig, RequireBudgetConfig } from './decorators'
