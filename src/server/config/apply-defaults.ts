/**
 * @fileoverview Merge host options over the spec §4.2 defaults into a frozen
 * `ResolvedAiTokensOptions`. Every opt-in feature becomes a discriminated union
 * so services never branch on `undefined`. Assumes options already passed
 * `validateOptions`.
 * @layer server
 */

import { resolveMultiplier4dp } from '../../shared'
import type { IMarkupPolicy } from '../interfaces'
import type { BymaxAiTokensModuleOptions } from '../interfaces'
import { DEFAULT_AI_TOKENS_OPTIONS as D } from './default-options.constants'
import type {
  ResolvedAiTokensOptions,
  ResolvedBudgetsOptions,
  ResolvedContentOptions,
  ResolvedEventsOptions,
  ResolvedHoldsOptions,
  ResolvedLedgerOptions,
  ResolvedPricingOptions,
  ResolvedReportingOptions,
  ResolvedTelemetryOptions,
  ResolvedWalletsOptions,
} from './resolved-options'

/** Resolve the markup: a validated 4-dp number, a policy as-is, or the default 1.0. */
function resolveMarkup(markup: number | IMarkupPolicy | undefined): number | IMarkupPolicy {
  if (markup === undefined) return D.markup
  if (typeof markup === 'number') return resolveMultiplier4dp(markup)
  return markup
}

/** Resolve the pricing block. */
function resolvePricing(pricing: BymaxAiTokensModuleOptions['pricing']): ResolvedPricingOptions {
  return {
    seedFromSnapshot: pricing?.seedFromSnapshot ?? D.pricing.seedFromSnapshot,
    strict: pricing?.strict ?? D.pricing.strict,
    cacheTtlMs: pricing?.cacheTtlMs ?? D.pricing.cacheTtlMs,
    modelAliases: pricing?.modelAliases ?? {},
  }
}

/** Resolve the wallet feature into a discriminated union. */
function resolveWallets(wallets: BymaxAiTokensModuleOptions['wallets']): ResolvedWalletsOptions {
  if (wallets === undefined) return { enabled: false }
  return {
    enabled: true,
    creditRateNanoUsd: wallets.creditRateNanoUsd ?? D.wallets.creditRateNanoUsd,
    overdraftNanoUsd: wallets.overdraftNanoUsd ?? D.wallets.overdraftNanoUsd,
    burnOrder: wallets.burnOrder ?? D.wallets.burnOrder,
  }
}

/** Resolve the budget feature into a discriminated union. */
function resolveBudgets(budgets: BymaxAiTokensModuleOptions['budgets']): ResolvedBudgetsOptions {
  if (budgets === undefined) return { enabled: false }
  return {
    enabled: true,
    defaultPolicy: budgets.defaultPolicy ?? D.budgets.defaultPolicy,
    alertThresholds: budgets.alertThresholds ?? D.budgets.alertThresholds,
    failClosed: budgets.failClosed ?? D.budgets.failClosed,
    counter: budgets.counter,
    onThrottle: budgets.onThrottle,
  }
}

/** Resolve the telemetry feature — enabled only when a sink is present. */
function resolveTelemetry(
  telemetry: BymaxAiTokensModuleOptions['telemetry'],
): ResolvedTelemetryOptions {
  if (telemetry?.sink === undefined) return { enabled: false }
  return { enabled: true, sink: telemetry.sink, metrics: telemetry.metrics ?? D.telemetry.metrics }
}

/** Resolve the content sidecar feature into a discriminated union. */
function resolveContent(content: BymaxAiTokensModuleOptions['content']): ResolvedContentOptions {
  if (content === undefined) return { enabled: false }
  return {
    enabled: true,
    store: content.store,
    mask: content.mask,
    ttlSeconds: content.ttlSeconds ?? D.content.ttlSeconds,
  }
}

/** Resolve event emission. */
function resolveEvents(events: BymaxAiTokensModuleOptions['events']): ResolvedEventsOptions {
  return { emitter: events?.emitter ?? D.events.emitter, sink: events?.sink }
}

/** Resolve hold lifecycle. */
function resolveHolds(holds: BymaxAiTokensModuleOptions['holds']): ResolvedHoldsOptions {
  return {
    ttlSeconds: holds?.ttlSeconds ?? D.holds.ttlSeconds,
    reaperIntervalSeconds: holds?.reaperIntervalSeconds ?? D.holds.reaperIntervalSeconds,
  }
}

/** Resolve ledger extras. */
function resolveLedger(ledger: BymaxAiTokensModuleOptions['ledger']): ResolvedLedgerOptions {
  return { hashChain: ledger?.hashChain ?? D.ledger.hashChain }
}

/** Resolve reporting limits. */
function resolveReporting(
  reporting: BymaxAiTokensModuleOptions['reporting'],
): ResolvedReportingOptions {
  return { maxExportRows: reporting?.maxExportRows ?? D.reporting.maxExportRows }
}

/**
 * Merge host options over the defaults into a frozen resolved options object.
 *
 * @param options The validated host options.
 * @returns The fully-resolved, frozen options.
 */
export function applyDefaults(options: BymaxAiTokensModuleOptions): ResolvedAiTokensOptions {
  return Object.freeze<ResolvedAiTokensOptions>({
    store: options.store,
    scopeResolver: options.scopeResolver,
    ratingMode: options.ratingMode ?? D.ratingMode,
    currency: options.currency ?? D.currency,
    fx: options.fx,
    markup: resolveMarkup(options.markup),
    pricing: resolvePricing(options.pricing),
    wallets: resolveWallets(options.wallets),
    budgets: resolveBudgets(options.budgets),
    holds: resolveHolds(options.holds),
    ledger: resolveLedger(options.ledger),
    tokenizer: options.tokenizer,
    events: resolveEvents(options.events),
    telemetry: resolveTelemetry(options.telemetry),
    reporting: resolveReporting(options.reporting),
    content: resolveContent(options.content),
  })
}
