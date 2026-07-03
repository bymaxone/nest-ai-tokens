/**
 * @fileoverview `MeteringService` — the public metering facade (spec §11). This
 * layer implements the observe-only post-hoc path — `record()` (normalize → rate →
 * markup → append → events) and the pure `estimateCost()`. Per the §11.2
 * side-effect matrix, `record()` (default) writes a `posted` row with
 * `enforced: false` and emits `ai_tokens.usage.recorded` only — it never touches a
 * wallet, budget, or counter. `enforce: true` needs wallets/budgets and is
 * rejected here. The hold/capture/release/meter/reverse lifecycle and `getStatus`
 * are later-phase surfaces: they are declared so the class matches the spec but
 * throw `AI_TOKENS_NOT_CONFIGURED` until their features land. No prompt/response
 * text ever reaches the ledger, events, or logs.
 * @layer server
 */

import { Injectable } from '@nestjs/common'
import type {
  AccessStatus,
  AiOperation,
  MeteringScope,
  NormalizedUsage,
  ProviderId,
  ProviderPreset,
  RatingMode,
  ServiceTier,
  UsageNormalizer,
  UsageRecord,
} from '../../shared'
import { computeCostNanoUsd } from '../../shared'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import type { CostEstimate, Hold, HoldEstimate, MeterResult, MeteringContext } from '../interfaces'
import type { LedgerAppendInput } from './ledger.service'
import { LedgerService } from './ledger.service'
import { MarkupResolver, type ResolvedMarkup } from './markup.resolver'
import { PricingService } from './pricing.service'

/** Input to {@link MeteringService.record}. */
export interface RecordInput {
  /** Raw provider usage OR an already-normalized {@link NormalizedUsage}. */
  usage: unknown
  /** Preset carrying the normalizer + rating mode (alternative to `normalizer`). */
  preset?: ProviderPreset
  /** A bare normalizer (alternative to `preset`). */
  normalizer?: UsageNormalizer
  /** The per-call metering context (trusted input from the host's auth layer). */
  context: MeteringContext
  /** When the call happened; defaults to now (backfills pass the original time). */
  occurredAt?: Date
}

/** Input to {@link MeteringService.estimateCost}. */
export interface EstimateCostInput {
  provider: ProviderId
  model: string
  operation: AiOperation
  serviceTier?: ServiceTier
  inputTokens: number
  maxOutputTokens: number
  at?: Date
  /** Lets a markup policy resolve; defaults to a neutral estimate scope. */
  scope?: MeteringScope
  feature?: string
}

/** The event hooks `record()` fires; the module wires them to the dispatcher (default no-op). */
export interface MeteringEventHooks {
  usageRecorded(record: UsageRecord): Promise<void>
  priceMissing(record: UsageRecord): Promise<void>
}

/** The resolved rating of one call, in exact bigint nano-USD. */
interface RatingResult {
  rawCostNanoUsd: bigint
  surchargeNanoUsd: bigint
  priceVersionId: string | null
  priceMissing: boolean
}

/** The no-op hooks used until the event dispatcher is wired. */
const NOOP_EVENT_HOOKS: MeteringEventHooks = {
  usageRecorded: (): Promise<void> => Promise.resolve(),
  priceMissing: (): Promise<void> => Promise.resolve(),
}

/** The neutral scope used for an estimate when the caller supplies none. */
const ESTIMATE_SCOPE: MeteringScope = { type: 'tenant', id: '' }

/** Detect an already-normalized usage: an object with a provider id and numeric token counts. */
function isNormalizedUsage(usage: unknown): usage is NormalizedUsage {
  if (typeof usage !== 'object' || usage === null) return false
  const candidate = usage as Record<string, unknown>
  return (
    typeof candidate.provider === 'string' &&
    typeof candidate.inputTokens === 'number' &&
    typeof candidate.outputTokens === 'number'
  )
}

/** Build the ledger append input from the rated call (§8.2 columns). */
function buildAppendInput(args: {
  normalized: NormalizedUsage
  context: MeteringContext
  serviceTier: ServiceTier
  occurredAt: Date
  rating: RatingResult
  markup: ResolvedMarkup
  ratedUnits: Record<string, number>
}): LedgerAppendInput {
  const { normalized, context, serviceTier, occurredAt, rating, markup, ratedUnits } = args
  return {
    tenantId: context.tenantId,
    scope: context.scope,
    ...(context.beneficiary !== undefined ? { beneficiary: context.beneficiary } : {}),
    ...(context.requestedBy !== undefined ? { requestedBy: context.requestedBy } : {}),
    provider: normalized.provider,
    model: normalized.model,
    ...(context.baseModel !== undefined ? { requestedModel: context.baseModel } : {}),
    operation: normalized.operation,
    serviceTier,
    feature: context.feature,
    tags: context.tags ?? [],
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    cacheReadTokens: normalized.cacheReadTokens,
    cacheWrite5mTokens: normalized.cacheWrite5mTokens,
    cacheWrite1hTokens: normalized.cacheWrite1hTokens,
    reasoningTokens: normalized.reasoningTokens,
    audioInTokens: normalized.audioInTokens,
    audioOutTokens: normalized.audioOutTokens,
    imageInTokens: normalized.imageInTokens,
    imageOutTokens: normalized.imageOutTokens,
    ...(Object.keys(ratedUnits).length > 0 ? { extraUnits: ratedUnits } : {}),
    priceVersionId: rating.priceVersionId,
    rawCostNanoUsd: rating.rawCostNanoUsd,
    surchargeNanoUsd: rating.surchargeNanoUsd,
    billedCostNanoUsd: markup.apply(rating.rawCostNanoUsd),
    markupMultiplier: markup.multiplier,
    currency: 'USD',
    priceMissing: rating.priceMissing,
    status: 'posted',
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    isSystemCost: context.isSystemCost ?? false,
    ...(context.systemCostCategory !== undefined ? { systemCostCategory: context.systemCostCategory } : {}),
    enforced: false,
    occurredAt,
  }
}

@Injectable()
export class MeteringService {
  /**
   * @param ledger The append-only ledger service.
   * @param pricing The pricing service (rate resolution).
   * @param markup The per-call markup resolver.
   * @param options The resolved options (default rating mode).
   * @param events The event hooks; the module wires them to the dispatcher.
   */
  constructor(
    private readonly ledger: LedgerService,
    private readonly pricing: PricingService,
    private readonly markup: MarkupResolver,
    private readonly options: Pick<ResolvedAiTokensOptions, 'ratingMode'>,
    private readonly events: MeteringEventHooks = NOOP_EVENT_HOOKS,
  ) {}

  /**
   * Post-hoc metering: normalize the usage, rate it (rate-table or
   * provider-reported), apply markup, and append a `posted` ledger record. Emits
   * `ai_tokens.usage.recorded` (and `ai_tokens.price.missing` on a non-strict rate
   * miss). Observe-only: `enforce: true` requires wallets/budgets and is rejected.
   *
   * @param input The usage, its preset/normalizer, and the metering context.
   * @returns The posted usage record.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when `enforce: true`;
   *   `AI_TOKENS_UNKNOWN_PROVIDER` / `AI_TOKENS_USAGE_MALFORMED` / `AI_TOKENS_PRICE_NOT_FOUND`.
   */
  async record(input: RecordInput): Promise<UsageRecord> {
    const { context } = input
    if (context.enforce === true) {
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
        reason: 'enforce requires wallets/budgets (Phase 3)',
      })
    }
    const normalized = this.resolveNormalizedUsage(input)
    const serviceTier = context.serviceTier ?? normalized.serviceTier ?? 'standard'
    const occurredAt = input.occurredAt ?? new Date()
    const mode = context.ratingMode ?? input.preset?.ratingMode ?? this.options.ratingMode
    const ratedUnits: Record<string, number> = { ...normalized.serverToolUse, ...context.extraUnits }
    const usageForRating: NormalizedUsage = { ...normalized, serverToolUse: ratedUnits }

    const rating = await this.rate(usageForRating, serviceTier, occurredAt, mode, context.baseModel)
    const markup = await this.markup.resolve({
      scope: context.scope,
      provider: normalized.provider,
      model: normalized.model,
      operation: normalized.operation,
      serviceTier,
      feature: context.feature,
    })

    const record = await this.ledger.append(
      buildAppendInput({ normalized, context, serviceTier, occurredAt, rating, markup, ratedUnits }),
      context.idempotencyKey,
    )
    if (rating.priceMissing) await this.events.priceMissing(record)
    await this.events.usageRecorded(record)
    return record
  }

  /**
   * Pure pre-flight cost estimate — no ledger or event side effects. Rates a
   * hypothetical call (`maxOutputTokens` as output) and applies markup.
   *
   * @param input The hypothetical call.
   * @returns The raw and billed nano-USD estimate.
   */
  async estimateCost(input: EstimateCostInput): Promise<CostEstimate> {
    const serviceTier = input.serviceTier ?? 'standard'
    const at = input.at ?? new Date()
    const usage: NormalizedUsage = {
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      serviceTier,
      inputTokens: input.inputTokens,
      outputTokens: input.maxOutputTokens,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      audioInTokens: 0,
      audioOutTokens: 0,
      imageInTokens: 0,
      imageOutTokens: 0,
    }
    const rate = await this.pricing.resolveRate({
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      serviceTier,
      at,
    })
    const rawCostNanoUsd = rate === null ? 0n : computeCostNanoUsd(usage, rate).totalNanoUsd
    const markup = await this.markup.resolve({
      scope: input.scope ?? ESTIMATE_SCOPE,
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      serviceTier,
      ...(input.feature !== undefined ? { feature: input.feature } : {}),
    })
    return { rawCostNanoUsd, billedCostNanoUsd: markup.apply(rawCostNanoUsd) }
  }

  /** The hold-authorize flow (§11.1). Arrives with the hold lifecycle. */
  meter<T>(
    _fn: () => Promise<T>,
    _context: MeteringContext,
    _extract: (result: T) => unknown,
    _estimate?: HoldEstimate,
  ): Promise<MeterResult<T>> {
    return Promise.reject(this.notConfigured('meter() arrives with the hold lifecycle (Phase 4)'))
  }

  /** Place an auth-hold (§11.1). Arrives with the hold lifecycle. */
  hold(_context: MeteringContext, _estimate: HoldEstimate): Promise<Hold> {
    return Promise.reject(this.notConfigured('hold() arrives with the hold lifecycle (Phase 4)'))
  }

  /** Settle a hold with actuals (§11.1). Arrives with the hold lifecycle. */
  capture(_hold: Hold, _usage: unknown): Promise<UsageRecord> {
    return Promise.reject(this.notConfigured('capture() arrives with the hold lifecycle (Phase 4)'))
  }

  /** Void a hold (§11.1). Arrives with the hold lifecycle. */
  release(_hold: Hold, _reason: string): Promise<void> {
    return Promise.reject(this.notConfigured('release() arrives with the hold lifecycle (Phase 4)'))
  }

  /** Orchestrated compensation (§8.5 step 3). Arrives with wallets/budgets. */
  reverse(_usageRecordId: string, _reason: string): Promise<UsageRecord> {
    return Promise.reject(this.notConfigured('reverse() arrives with wallets/budgets (Phase 4)'))
  }

  /** Combined wallet + budget status (§10.6). Arrives with wallets/budgets. */
  getStatus(_tenantId: string, _scope: MeteringScope): Promise<AccessStatus> {
    return Promise.reject(this.notConfigured('getStatus() arrives with wallets/budgets (Phase 3)'))
  }

  /** Resolve the normalizer chain and produce the normalized usage. */
  private resolveNormalizedUsage(input: RecordInput): NormalizedUsage {
    const normalizer = input.normalizer ?? input.preset?.normalizer
    if (normalizer !== undefined) return this.normalize(normalizer, input.usage)
    if (isNormalizedUsage(input.usage)) return input.usage
    throw new AiTokensException('AI_TOKENS_UNKNOWN_PROVIDER', undefined, {
      reason: 'raw usage requires a preset or normalizer, or an already-normalized usage',
    })
  }

  /** Run a normalizer, wrapping a plain failure as a malformed-usage error. */
  private normalize(normalizer: UsageNormalizer, usage: unknown): NormalizedUsage {
    try {
      return normalizer(usage)
    } catch (error) {
      if (error instanceof AiTokensException) throw error
      throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, {
        reason: 'the normalizer could not read the usage token fields',
      })
    }
  }

  /** Rate a call in the resolved mode; a non-strict rate miss yields zero cost + `priceMissing`. */
  private async rate(
    usage: NormalizedUsage,
    serviceTier: ServiceTier,
    occurredAt: Date,
    mode: RatingMode,
    baseModel?: string,
  ): Promise<RatingResult> {
    if (mode === 'provider-reported') {
      const cost = usage.providerReportedCostNanoUsd
      if (cost === undefined) {
        throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, {
          reason: 'provider-reported rating requires providerReportedCostNanoUsd',
        })
      }
      return { rawCostNanoUsd: cost, surchargeNanoUsd: 0n, priceVersionId: null, priceMissing: false }
    }
    const rate = await this.pricing.resolveRate({
      provider: usage.provider,
      model: usage.model,
      operation: usage.operation,
      serviceTier,
      at: occurredAt,
      ...(baseModel !== undefined ? { baseModel } : {}),
    })
    if (rate === null) {
      return { rawCostNanoUsd: 0n, surchargeNanoUsd: 0n, priceVersionId: null, priceMissing: true }
    }
    const breakdown = computeCostNanoUsd(usage, rate)
    return {
      rawCostNanoUsd: breakdown.totalNanoUsd,
      surchargeNanoUsd: breakdown.surchargeNanoUsd,
      priceVersionId: rate.id,
      priceMissing: false,
    }
  }

  /** Build a `AI_TOKENS_NOT_CONFIGURED` error for a not-yet-available surface. */
  private notConfigured(reason: string): AiTokensException {
    return new AiTokensException('AI_TOKENS_NOT_CONFIGURED', undefined, { reason })
  }
}
