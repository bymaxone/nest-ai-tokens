/**
 * @fileoverview `MeteringService` — the public metering facade (spec §11). It
 * carries the whole lifecycle: the post-hoc `record()` (observe-only, or
 * enforcing post-hoc with `enforce: true`), the pure `estimateCost()`, and the
 * auth-hold flow `hold()` → `capture()` / `release()` plus the `meter()` wrapper,
 * the orchestrated `reverse()`, and the combined `getStatus()`. Per the §11.2
 * side-effect matrix: a hold reserves (budget consume → wallet debit, each step
 * compensated), a capture settles the ±delta and is IDEMPOTENT, a release/reaper
 * restores in full and NEVER bills, and `isSystemCost` rows touch only the ledger
 * and events. Money is bigint nano-USD; no prompt/response text ever reaches the
 * ledger, events, or logs.
 * @layer server
 */

import { randomUUID } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import type {
  AccessStatus,
  AiOperation,
  BudgetStatus,
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
import { scopeOwnsWallet, scopeToWalletRef } from '../utils/scope-wallet'
import type { LedgerAppendInput } from './ledger.service'
import { LedgerService } from './ledger.service'
import { MarkupResolver, type ResolvedMarkup } from './markup.resolver'
import { MeteringEffects } from './metering-effects'
import { PricingService } from './pricing.service'
import { StreamUsageCollector } from '../streaming/stream-usage-collector'
import { TelemetryEmitter } from '../telemetry/otel-emitter'
import { NO_OP_TELEMETRY } from '../telemetry/no-op-telemetry'
import type { TokenCounts } from './hold-support'
import {
  isNormalizedUsage,
  normalizeCaptureUsage,
  resolveHoldEstimate,
  sumTokenCounts,
  tokenCountsOf,
} from './hold-support'
import type { WalletService } from './wallet.service'
import type { BudgetService } from './budget.service'

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

/** The event hooks the lifecycle fires; the module wires them to the dispatcher (default no-op). */
export interface MeteringEventHooks {
  usageRecorded(record: UsageRecord): Promise<void>
  priceMissing(record: UsageRecord): Promise<void>
  holdReleased(record: UsageRecord, reason: string, expired: boolean): Promise<void>
  usageReversed(original: UsageRecord, reversalRecordId: string, reason: string): Promise<void>
  audit(action: string, details: Record<string, unknown>): Promise<void>
}

/** The resolved-options subset the metering facade consumes. */
export type MeteringServiceOptions = Pick<ResolvedAiTokensOptions, 'ratingMode'> & {
  /** Absent in record-only setups that never place a hold. */
  holds?: ResolvedAiTokensOptions['holds']
  /** Absent when the wallet feature is disabled. */
  wallets?: ResolvedAiTokensOptions['wallets']
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
  holdReleased: (): Promise<void> => Promise.resolve(),
  usageReversed: (): Promise<void> => Promise.resolve(),
  audit: (): Promise<void> => Promise.resolve(),
}

/** The neutral scope used for an estimate when the caller supplies none. */
const ESTIMATE_SCOPE: MeteringScope = { type: 'tenant', id: '' }

/** A resolved holds block used when the caller omits one (record-only setups never hold). */
const DEFAULT_HOLDS = { ttlSeconds: 3_600, reaperIntervalSeconds: 300 }

/** Build the ledger append input for a settled `record()` (§8.2 columns). */
function buildAppendInput(args: {
  normalized: NormalizedUsage
  context: MeteringContext
  serviceTier: ServiceTier
  occurredAt: Date
  rating: RatingResult
  markup: ResolvedMarkup
  ratedUnits: Record<string, number>
  enforced: boolean
}): LedgerAppendInput {
  const { normalized, context, serviceTier, occurredAt, rating, markup, ratedUnits, enforced } = args
  return {
    ...baseColumns(normalized, context, serviceTier),
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
    isSystemCost: context.isSystemCost ?? false,
    ...(context.systemCostCategory !== undefined ? { systemCostCategory: context.systemCostCategory } : {}),
    enforced,
    occurredAt,
  }
}

/** The attribution/identity columns shared by settled and pending appends. */
function baseColumns(
  usage: Pick<NormalizedUsage, 'provider' | 'model' | 'operation'>,
  context: MeteringContext,
  serviceTier: ServiceTier,
): Pick<LedgerAppendInput, 'tenantId' | 'scope' | 'beneficiary' | 'requestedBy' | 'provider' | 'model' | 'requestedModel' | 'operation' | 'serviceTier' | 'feature' | 'tags' | 'correlationId'> {
  return {
    tenantId: context.tenantId,
    scope: context.scope,
    ...(context.beneficiary !== undefined ? { beneficiary: context.beneficiary } : {}),
    ...(context.requestedBy !== undefined ? { requestedBy: context.requestedBy } : {}),
    provider: usage.provider,
    model: usage.model,
    ...(context.baseModel !== undefined ? { requestedModel: context.baseModel } : {}),
    operation: usage.operation,
    serviceTier,
    feature: context.feature,
    tags: context.tags ?? [],
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  }
}

@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name)
  private readonly effects: MeteringEffects
  /** The wallet overdraft headroom (0 when wallets are disabled). */
  private readonly overdraftNanoUsd: bigint

  /**
   * @param ledger The append-only ledger service.
   * @param pricing The pricing service (rate resolution).
   * @param markup The per-call markup resolver.
   * @param options The resolved options (rating mode, hold TTL, wallet overdraft).
   * @param events The event hooks; the module wires them to the dispatcher.
   * @param wallets The wallet service, when the wallet feature is enabled.
   * @param budgets The budget service, when the budget feature is enabled.
   * @param now The injected clock (hold expiry).
   * @param telemetry The GenAI telemetry emitter (no-op by default).
   */
  constructor(
    private readonly ledger: LedgerService,
    private readonly pricing: PricingService,
    private readonly markup: MarkupResolver,
    private readonly options: MeteringServiceOptions,
    private readonly events: MeteringEventHooks = NOOP_EVENT_HOOKS,
    private readonly wallets?: WalletService,
    private readonly budgets?: BudgetService,
    private readonly now: () => Date = (): Date => new Date(),
    private readonly telemetry: TelemetryEmitter = NO_OP_TELEMETRY,
  ) {
    this.effects = new MeteringEffects(wallets, budgets)
    this.overdraftNanoUsd = options.wallets?.enabled === true ? options.wallets.overdraftNanoUsd : 0n
  }

  /**
   * Post-hoc metering: normalize, rate, apply markup, append a `posted` record, and
   * emit `ai_tokens.usage.recorded`. Observe-only by default; `enforce: true` also
   * consumes budgets and debits the wallet AFTER the ledger write (§11.2 trade-off:
   * a call that already ran can still exceed a limit) — it requires the wallet or
   * budget feature.
   *
   * @param input The usage, its preset/normalizer, and the metering context.
   * @returns The posted usage record.
   * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` when `enforce: true` without wallets/budgets; normalize/rate errors; post-hoc budget/quota/credits errors.
   */
  async record(input: RecordInput): Promise<UsageRecord> {
    const { context } = input
    const enforcing = context.enforce === true
    if (enforcing && this.wallets === undefined && this.budgets === undefined) {
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
        reason: 'enforce requires the wallets or budgets feature to be enabled',
      })
    }
    const normalized = this.resolveNormalizedUsage(input)
    const serviceTier = context.serviceTier ?? normalized.serviceTier ?? 'standard'
    const occurredAt = input.occurredAt ?? this.now()
    const mode = context.ratingMode ?? input.preset?.ratingMode ?? this.options.ratingMode
    const ratedUnits: Record<string, number> = { ...normalized.serverToolUse, ...context.extraUnits }
    const usageForRating: NormalizedUsage = { ...normalized, serverToolUse: ratedUnits }

    const rating = await this.rate(usageForRating, serviceTier, occurredAt, mode, context.baseModel)
    const markup = await this.resolveMarkup(context, normalized, serviceTier)
    const record = await this.ledger.append(
      buildAppendInput({ normalized, context, serviceTier, occurredAt, rating, markup, ratedUnits, enforced: enforcing }),
      context.idempotencyKey,
    )
    if (rating.priceMissing) await this.events.priceMissing(record)
    await this.events.usageRecorded(record)
    this.telemetry.recordUsage(record)
    if (enforcing) await this.effects.enforceRecord(record)
    return record
  }

  /**
   * Pure pre-flight cost estimate — no ledger or event side effects.
   *
   * @param input The hypothetical call.
   * @returns The raw and billed nano-USD estimate.
   */
  async estimateCost(input: EstimateCostInput): Promise<CostEstimate> {
    const serviceTier = input.serviceTier ?? 'standard'
    const at = input.at ?? this.now()
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
    const rate = await this.pricing.resolveRate({ provider: input.provider, model: input.model, operation: input.operation, serviceTier, at })
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

  /**
   * Place an auth-hold: rate the estimate, apply markup, reserve budget + wallet
   * headroom (compensated on any step's failure), and write a `pending` ledger
   * record with a TTL (§2.2 step 1). A repeat with the same `idempotencyKey`
   * returns the existing hold without re-reserving.
   *
   * @param context The metering context (payer scope, feature).
   * @param estimate One of the three {@link HoldEstimate} variants.
   * @returns The plain, serializable {@link Hold}.
   * @throws {AiTokensException} `AI_TOKENS_BUDGET_EXCEEDED` / `_QUOTA_EXCEEDED` / `_INSUFFICIENT_CREDITS` on a shortfall (prior steps compensated).
   */
  async hold(context: MeteringContext, estimate: HoldEstimate): Promise<Hold> {
    if (context.idempotencyKey !== undefined) {
      const existing = await this.ledger.findByIdempotencyKey(context.tenantId, context.idempotencyKey)
      if (existing !== null) return this.holdOf(existing)
    }
    const occurredAt = this.now()
    const resolved = await resolveHoldEstimate(this.pricing, context, estimate, occurredAt)
    const markup = await this.markup.resolve({ scope: context.scope, provider: resolved.provider, model: resolved.model, operation: resolved.operation, serviceTier: resolved.serviceTier, feature: context.feature })
    const billedEstimate = markup.apply(resolved.rawEstimateNanoUsd)
    const isSystemCost = context.isSystemCost ?? false
    const ledgerKey = context.idempotencyKey ?? `hold:${randomUUID()}`
    const delta = { billedNanoUsd: billedEstimate, tokens: resolved.estimatedTokens, count: 1 }
    if (!isSystemCost) await this.effects.reserveHold(context, delta, ledgerKey)
    const record = await this.appendPending(context, resolved, billedEstimate, markup.multiplier, occurredAt, ledgerKey, isSystemCost, delta)
    return this.holdOf(record)
  }

  /**
   * Settle a hold with provider-reported actuals (§2.2 step 3). IDEMPOTENT: a repeat
   * on an already-settled hold returns the posted record unchanged. Applies the
   * ±delta between the actual and the reserved estimate to wallet/budget/counter.
   *
   * @param hold The hold to settle (revalidated against the store + caller tenant).
   * @param usage The raw provider usage or an already-normalized usage.
   * @param preset The preset normalizing the usage (or provider-reported mode).
   * @returns The posted usage record.
   * @throws {AiTokensException} `AI_TOKENS_HOLD_NOT_FOUND` (cross-tenant/missing), `_HOLD_EXPIRED` (reaped), `_HOLD_ALREADY_SETTLED` (released).
   */
  async capture(hold: Hold, usage: unknown, preset?: ProviderPreset): Promise<UsageRecord> {
    const record = await this.loadHoldRecord(hold)
    if (record.status !== 'pending') return this.settledOrConflict(record)
    const normalized = await this.finalizeCaptureUsage(usage, hold, preset)
    const usageForRating: NormalizedUsage = {
      ...normalized,
      provider: record.provider,
      model: record.model,
      operation: record.operation,
      serviceTier: record.serviceTier,
      serverToolUse: record.extraUnits ?? {},
    }
    const mode = preset?.ratingMode ?? this.options.ratingMode
    const rating = await this.rate(usageForRating, record.serviceTier, record.occurredAt, mode, record.requestedModel)
    const markup = await this.markup.resolve({ scope: record.scope, provider: record.provider, model: record.model, operation: record.operation, serviceTier: record.serviceTier, feature: record.feature })
    const counts = tokenCountsOf(usageForRating)
    const patch = this.settlementPatch(counts, rating, markup)
    const reservedBilled = record.billedCostNanoUsd
    const reservedTokens = record.totalTokens
    const settled = await this.ledger.transition(record.id, 'pending', 'posted', patch)
    if (settled === null) return this.settledOrConflict(await this.reload(record.id))
    await this.events.usageRecorded(settled)
    this.telemetry.recordUsage(settled)
    await this.effects.settleCapture(settled, reservedBilled, reservedTokens, settled.billedCostNanoUsd, settled.totalTokens)
    return settled
  }

  /**
   * Void a hold: `pending → released`, restoring wallet/budget in full (§2.2 step
   * 4). NEVER bills. A no-op (with a warning) on an already-captured hold; a no-op
   * on an already-released hold. Multi-caller safe via the atomic transition claim.
   *
   * @param hold The hold to void (revalidated against the store + caller tenant).
   * @param reason The caller's stated reason (surfaced on `ai_tokens.hold.released`).
   * @throws {AiTokensException} `AI_TOKENS_HOLD_NOT_FOUND` on a cross-tenant/missing hold.
   */
  async release(hold: Hold, reason: string): Promise<void> {
    const record = await this.loadHoldRecord(hold)
    if (record.status === 'posted') {
      this.logger.warn(`release() called on an already-captured hold ${record.id}; ignoring (release never bills)`)
      return
    }
    if (record.status !== 'pending') return
    const claimed = await this.ledger.transition(record.id, 'pending', 'released')
    if (claimed === null) return
    await this.restoreReleasedHold(claimed, reason, false)
  }

  /**
   * The most common entry point: hold → run `fn` → capture (release on error). With
   * no estimate it skips the hold and runs `record({ enforce: true })` post-hoc.
   *
   * @param fn The metered async function (the LLM call).
   * @param context The metering context (payer scope, feature, preset).
   * @param extract Pull the raw usage out of `fn`'s result.
   * @param estimate The optional hold estimate; omit for the post-hoc enforce path.
   * @returns The function result and its settled usage record.
   */
  async meter<T>(fn: () => Promise<T>, context: MeteringContext, extract: (result: T) => unknown, estimate?: HoldEstimate): Promise<MeterResult<T>> {
    const startedAt = this.now().getTime()
    if (estimate === undefined) {
      const result = await fn()
      const usage = await this.record({ usage: extract(result), ...(context.preset !== undefined ? { preset: context.preset } : {}), context: { ...context, enforce: true } })
      this.telemetry.recordDuration(usage, this.now().getTime() - startedAt)
      return { result, usage }
    }
    const hold = await this.hold(context, estimate)
    let result: T
    try {
      result = await fn()
    } catch (error) {
      await this.release(hold, 'metered function threw')
      throw error
    }
    const usage = await this.capture(hold, extract(result), context.preset)
    this.telemetry.recordDuration(usage, this.now().getTime() - startedAt)
    return { result, usage }
  }

  /**
   * Orchestrated compensation (§8.5 step 3): reverse the ledger record, then — for
   * an enforced, non-system record — refund the wallet and release the budget
   * (cost, tokens, and count). ADMIN PLANE (§14.4): the host MUST restrict this to
   * privileged roles; it emits `ai_tokens.usage.reversed` and `ai_tokens.audit`.
   * Cross-store effects are best-effort sequential with logged partial failures;
   * deterministic keys make retries safe.
   *
   * @param usageRecordId The posted record to reverse.
   * @param reason The caller's stated reason.
   * @returns The compensating record.
   * @throws {AiTokensException} `AI_TOKENS_IDEMPOTENCY_CONFLICT` when the record is missing or not `posted`.
   */
  async reverse(usageRecordId: string, reason: string): Promise<UsageRecord> {
    const compensating = await this.ledger.reverse(usageRecordId, reason)
    const original = await this.ledger.findById(usageRecordId)
    if (original !== null && original.enforced && !original.isSystemCost) {
      await this.effects.reverseEffects(original, reason)
    }
    await this.events.usageReversed(original ?? compensating, compensating.id, reason)
    await this.events.audit('ai_tokens.usage.reversed', { tenantId: compensating.tenantId, usageRecordId, reversalRecordId: compensating.id, reason })
    return compensating
  }

  /**
   * Combined wallet + budget status (§10.6) — the usage-meter data source. No side
   * effects. The wallet section is absent when wallets are disabled or the scope is
   * a `'key'` (keys spend their owner's wallet). `hasAccess` is false with
   * `blockedBy` set when the wallet or a hard budget is exhausted.
   *
   * @param tenantId The owning tenant.
   * @param scope The scope to report for.
   * @returns The combined access status.
   */
  async getStatus(tenantId: string, scope: MeteringScope): Promise<AccessStatus> {
    const budgets = this.budgets !== undefined ? await this.budgets.status(tenantId, scope) : []
    const wallet = await this.walletSection(tenantId, scope)
    const budgetBlocked = budgets.some((status) => isHardExhausted(status))
    const walletBlocked = wallet !== undefined && wallet.balanceNanoUsd + wallet.overdraftRemainingNanoUsd <= 0n
    const blockedBy = walletBlocked ? 'wallet' : budgetBlocked ? 'budget' : undefined
    return { hasAccess: blockedBy === undefined, ...(blockedBy !== undefined ? { blockedBy } : {}), ...(wallet !== undefined ? { wallet } : {}), budgets }
  }

  /**
   * Restore a reclaimed hold and announce it — the shared code path for `release()`
   * and the hold reaper (§8.3). The caller has already won the `pending → released`
   * transition claim.
   *
   * @param record The just-released record (carries the reserved amounts).
   * @param reason The stated reason.
   * @param expired True when reclaimed by the reaper (vs an explicit release).
   */
  async restoreReleasedHold(record: UsageRecord, reason: string, expired: boolean): Promise<void> {
    await this.effects.restoreHold(record)
    await this.events.holdReleased(record, reason, expired)
  }

  /** Reserve the pending ledger row, compensating the reservation if the insert fails. */
  private async appendPending(
    context: MeteringContext,
    resolved: Awaited<ReturnType<typeof resolveHoldEstimate>>,
    billedEstimate: bigint,
    markupMultiplier: number,
    occurredAt: Date,
    ledgerKey: string,
    isSystemCost: boolean,
    delta: { billedNanoUsd: bigint; tokens: number; count: number },
  ): Promise<UsageRecord> {
    try {
      return await this.ledger.append(
        {
          ...baseColumns(resolved, context, resolved.serviceTier),
          ...resolved.tokenCounts,
          priceVersionId: null,
          rawCostNanoUsd: resolved.rawEstimateNanoUsd,
          surchargeNanoUsd: 0n,
          billedCostNanoUsd: billedEstimate,
          markupMultiplier,
          currency: 'USD',
          priceMissing: false,
          status: 'pending',
          isSystemCost,
          ...(context.systemCostCategory !== undefined ? { systemCostCategory: context.systemCostCategory } : {}),
          enforced: !isSystemCost,
          occurredAt,
        },
        ledgerKey,
      )
    } catch (error) {
      if (!isSystemCost) await this.effects.compensateHold(context, delta, ledgerKey)
      throw error
    }
  }

  /** Build the {@link Hold} view of a pending (or replayed) ledger record. */
  private holdOf(record: UsageRecord): Hold {
    const ttlSeconds = (this.options.holds ?? DEFAULT_HOLDS).ttlSeconds
    return {
      id: record.id,
      tenantId: record.tenantId,
      scope: record.scope,
      estimatedTokens: record.totalTokens,
      estimatedCostNanoUsd: record.billedCostNanoUsd,
      expiresAt: new Date(record.createdAt.getTime() + ttlSeconds * 1_000),
    }
  }

  /** Load a hold's record and reject a cross-tenant/scope or missing hold as HOLD_NOT_FOUND (§14.4). */
  private async loadHoldRecord(hold: Hold): Promise<UsageRecord> {
    const record = await this.ledger.findById(hold.id)
    if (record === null) throw new AiTokensException('AI_TOKENS_HOLD_NOT_FOUND', undefined, { holdId: hold.id })
    if (record.tenantId !== hold.tenantId || !sameScope(record.scope, hold.scope)) {
      throw new AiTokensException('AI_TOKENS_HOLD_NOT_FOUND', undefined, { holdId: hold.id })
    }
    return record
  }

  /** Dispatch a non-pending hold record: posted → idempotent return; released → expired/settled. */
  private settledOrConflict(record: UsageRecord): UsageRecord {
    if (record.status === 'posted') return record
    if (record.status === 'released') {
      const ttlSeconds = (this.options.holds ?? DEFAULT_HOLDS).ttlSeconds
      const expiredAt = record.createdAt.getTime() + ttlSeconds * 1_000
      if (this.now().getTime() >= expiredAt) {
        throw new AiTokensException('AI_TOKENS_HOLD_EXPIRED', undefined, { holdId: record.id })
      }
    }
    throw new AiTokensException('AI_TOKENS_HOLD_ALREADY_SETTLED', undefined, { holdId: record.id })
  }

  /** Reload a record by id, or fail HOLD_NOT_FOUND when it vanished mid-capture. */
  private async reload(id: string): Promise<UsageRecord> {
    const record = await this.ledger.findById(id)
    if (record === null) throw new AiTokensException('AI_TOKENS_HOLD_NOT_FOUND', undefined, { holdId: id })
    return record
  }

  /**
   * Normalize the usage handed to `capture()`. A {@link StreamUsageCollector} is
   * finalized here; when it fell back to a tokenizer count with no prompt tokens
   * (input `0`), the hold's estimated tokens supply the aborted-stream input
   * fallback (spec §5.6 order: collector prompt count → hold estimate → 0).
   */
  private async finalizeCaptureUsage(usage: unknown, hold: Hold, preset?: ProviderPreset): Promise<NormalizedUsage> {
    if (usage instanceof StreamUsageCollector) {
      const finalized = await usage.finalize()
      if (usage.usedFallback && finalized.inputTokens === 0 && hold.estimatedTokens > 0) {
        return { ...finalized, inputTokens: hold.estimatedTokens }
      }
      return finalized
    }
    return normalizeCaptureUsage(usage, preset?.normalizer)
  }

  /** Build the settlement patch for a `pending → posted` transition. */
  private settlementPatch(counts: TokenCounts, rating: RatingResult, markup: ResolvedMarkup): Partial<UsageRecord> {
    return {
      ...counts,
      totalTokens: sumTokenCounts(counts),
      rawCostNanoUsd: rating.rawCostNanoUsd,
      surchargeNanoUsd: rating.surchargeNanoUsd,
      billedCostNanoUsd: markup.apply(rating.rawCostNanoUsd),
      markupMultiplier: markup.multiplier,
      priceVersionId: rating.priceVersionId,
      priceMissing: rating.priceMissing,
    }
  }

  /** Build the wallet section of an {@link AccessStatus}, or `undefined` when wallets are off / scope is a key. */
  private async walletSection(tenantId: string, scope: MeteringScope): Promise<AccessStatus['wallet'] | undefined> {
    if (this.wallets === undefined || !scopeOwnsWallet(scope)) return undefined
    const balance = await this.wallets.getBalance(scopeToWalletRef(tenantId, scope))
    const overdraftRemainingNanoUsd = this.overdraftNanoUsd + (balance.nanoUsd < 0n ? balance.nanoUsd : 0n)
    return { balanceNanoUsd: balance.nanoUsd, credits: balance.credits, overdraftRemainingNanoUsd: overdraftRemainingNanoUsd < 0n ? 0n : overdraftRemainingNanoUsd }
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

  /** Resolve markup for a settled/pending call from the normalized identity. */
  private resolveMarkup(context: MeteringContext, normalized: NormalizedUsage, serviceTier: ServiceTier): Promise<ResolvedMarkup> {
    return this.markup.resolve({ scope: context.scope, provider: normalized.provider, model: normalized.model, operation: normalized.operation, serviceTier, feature: context.feature })
  }

  /** Run a normalizer, wrapping a plain failure as a malformed-usage error. */
  private normalize(normalizer: UsageNormalizer, usage: unknown): NormalizedUsage {
    try {
      return normalizer(usage)
    } catch (error) {
      if (error instanceof AiTokensException) throw error
      throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'the normalizer could not read the usage token fields' })
    }
  }

  /** Rate a call in the resolved mode; a non-strict rate miss yields zero cost + `priceMissing`. */
  private async rate(usage: NormalizedUsage, serviceTier: ServiceTier, occurredAt: Date, mode: RatingMode, baseModel?: string): Promise<RatingResult> {
    if (mode === 'provider-reported') {
      const cost = usage.providerReportedCostNanoUsd
      if (cost === undefined) {
        throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'provider-reported rating requires providerReportedCostNanoUsd' })
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
    if (rate === null) return { rawCostNanoUsd: 0n, surchargeNanoUsd: 0n, priceVersionId: null, priceMissing: true }
    const breakdown = computeCostNanoUsd(usage, rate)
    return { rawCostNanoUsd: breakdown.totalNanoUsd, surchargeNanoUsd: breakdown.surchargeNanoUsd, priceVersionId: rate.id, priceMissing: false }
  }
}

/** Structural equality of two metering scopes. */
function sameScope(a: MeteringScope, b: MeteringScope): boolean {
  return a.type === b.type && a.id === b.id
}

/** Whether a hard (`'block'`) budget has no headroom on a limited dimension. */
function isHardExhausted(status: BudgetStatus): boolean {
  if (status.policy !== 'block') return false
  if (status.limit.nanoUsd !== undefined && status.spent.nanoUsd >= status.limit.nanoUsd) return true
  if (status.limit.tokens !== undefined && status.spent.tokens >= status.limit.tokens) return true
  return status.limit.count !== undefined && status.spent.count >= status.limit.count
}
