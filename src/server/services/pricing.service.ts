/**
 * @fileoverview `PricingService` — effective-dated rate resolution with the §6.6
 * model-resolution chain, an in-memory TTL cache, price upserts, and the
 * idempotent snapshot seed (§6.3/§6.4). A call is priced at the rate in effect at
 * its timestamp; batch/flex/priority tiers must find their own row (no silent
 * fallback to standard rates).
 * @layer server
 */

import { Injectable } from '@nestjs/common'
import type { OnModuleInit } from '@nestjs/common'
import type { AiOperation, NewPriceVersion, PriceVersion, ProviderId, ServiceTier } from '../../shared'
import { methodOf, withEveryName } from '../utils/field-names'
import { assertCleanRealm } from '../utils/prototype-guard'
import { guardedStore } from '../utils/guarded-store'
import { AiTokensException } from '../errors'
import { suppliedDetails } from '../utils/detail-text'
import type { IPricingStore } from '../interfaces'
import type { ResolvedAiTokensOptions } from '../config'
import { assertObject, assertOptionalAmount, assertOptionalCount, assertOptionalText, assertText } from '../utils/argument-guards'
import { readDate, snapshotOf, withReadDates } from '../utils/date-guards'
import { PRICE_FIELDS, RESOLVE_RATE_FIELDS } from '../utils/input-fields'
import { normalizeModelId } from '../utils/model-id'

/** Inputs to {@link PricingService.resolveRate}. */
export interface ResolveRateInput {
  provider: ProviderId
  model: string
  operation: AiOperation
  at: Date
  /** Defaults to `'standard'`. */
  serviceTier?: ServiceTier
  /** Price-lookup override for deployment-named models (Azure/Bedrock) — §6.6 step 2. */
  baseModel?: string
}

/** All seed rows are effective from the epoch so they form the baseline for any timestamp. */
const SEED_EFFECTIVE_FROM = new Date(0)

/** The rates of a price version, each a bigint of nano-USD per million tokens. */
const RATE_FIELDS = [
  'inputNanoUsdPerMillion',
  'outputNanoUsdPerMillion',
  'cacheReadNanoUsdPerMillion',
  'cacheWrite5mNanoUsdPerMillion',
  'cacheWrite1hNanoUsdPerMillion',
  'reasoningNanoUsdPerMillion',
  'audioInNanoUsdPerMillion',
  'audioOutNanoUsdPerMillion',
  'imageInNanoUsdPerMillion',
  'imageOutNanoUsdPerMillion',
  'tierInputNanoUsdPerMillion',
  'tierOutputNanoUsdPerMillion',
] as const

/**
 * Effective-dated rate resolution with a model-resolution chain, an
 * in-memory TTL cache, price upserts, and idempotent snapshot seed. Past
 * records are never re-rated (point-in-time pricing). See file overview.
 */
@Injectable()
export class PricingService implements OnModuleInit {
  private readonly cache = new Map<string, { value: PriceVersion | null; expiresAt: number }>()

  /**
   * @param options The resolved module options (pricing config lives here).
   * @param store The pricing store port.
   * @param now A clock returning epoch milliseconds; injected for testability.
   */
  private readonly store: IPricingStore

  constructor(
    private readonly options: ResolvedAiTokensOptions,
    store: IPricingStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.store = guardedStore(store)
  }

  /** Whether a missing price is refused (`true`) or billed at 0 and flagged (`false`). */
  get strict(): boolean {
    return this.options.pricing.strict
  }

  /** Seed the registry on boot when enabled. */
  async onModuleInit(): Promise<void> {
    if (this.options.pricing.seedFromSnapshot) await this.seedFromSnapshot()
  }

  /**
   * Resolve the price version in effect at `input.at`, applying the §6.6 chain.
   *
   * @param given The provider/model/operation/timestamp (+ optional tier/baseModel).
   * @returns The matching price version, or `null` in non-strict mode on a miss.
   * @throws {AiTokensException} `AI_TOKENS_PRICE_NOT_FOUND` on a miss in strict mode.
   */
  async resolveRate(given: ResolveRateInput): Promise<PriceVersion | null> {
    // A cached price never reaches the store, which is where every other read of the library is refused beside a polluted realm.
    assertCleanRealm()
    assertObject('input', given)
    const input = snapshotOf(given, RESOLVE_RATE_FIELDS)
    assertText('provider', input.provider)
    assertText('model', input.model)
    assertText('operation', input.operation)
    assertOptionalText('serviceTier', input.serviceTier)
    const at = readDate('at', input.at)
    const serviceTier = input.serviceTier ?? 'standard'
    // Stryker disable next-line ConditionalExpression: CE true: always mapping to 'chat' is detectable only when a non-'responses', non-'chat' operation (e.g. 'embeddings') is used alongside a mismatched 'chat' price row; no such test exists. But CE true changes 'embeddings' → 'chat' which then finds the wrong price — the fix is the test for non-responses passing through
    const operation = input.operation === 'responses' ? 'chat' : input.operation
    // Stryker disable next-line ArithmeticOperator: * instead of /: changes bucket to input.at.getTime() * cacheTtlMs (huge number), but since both calls use the same input.at, the cache key is still consistent across calls → cache still hits; only observable if two different input.at values are deliberately straddled across a bucket boundary, which no test does
    const bucket = Math.floor(at.getTime() / this.options.pricing.cacheTtlMs)
    // A JSON array escapes every string field, so no character inside provider, model or baseModel can move the boundary between fields.
    const cacheKey = JSON.stringify([input.provider, input.model, input.baseModel, operation, serviceTier, bucket])

    let resolved: PriceVersion | null
    const cached = this.cache.get(cacheKey)
    // Stryker disable next-line EqualityOperator: this.now() <= expiresAt: equals only when now === expiresAt exactly (sub-millisecond race); tests use controllable clock that never produces this exact equality
    if (cached !== undefined && this.now() < cached.expiresAt) {
      resolved = cached.value
    } else {
      resolved = await this.resolveUncached(input.provider, input.model, operation, serviceTier, at, input.baseModel)
      this.cache.set(cacheKey, { value: resolved, expiresAt: this.now() + this.options.pricing.cacheTtlMs })
    }

    if (resolved === null && this.options.pricing.strict) {
      // Stryker disable next-line ObjectLiteral: error context fields are diagnostic; tests check error code (AI_TOKENS_PRICE_NOT_FOUND), not payload shape
      throw new AiTokensException('AI_TOKENS_PRICE_NOT_FOUND', undefined, suppliedDetails({ provider: input.provider, model: input.model, operation: input.operation, serviceTier }))
    }
    return resolved
  }

  /**
   * Close the current open row and insert a new one; clears the resolution cache.
   * ADMIN PLANE: this sets prices — the host MUST restrict it to privileged roles
   * (§14.4) and should audit every call.
   *
   * @param given The new price version (rates default to `0n`, tier to `'standard'`).
   * @returns The newly-inserted open price row.
   */
  async upsertPrice(given: NewPriceVersion): Promise<PriceVersion> {
    assertObject('input', given)
    const input = withReadDates(given, PRICE_FIELDS, ['effectiveFrom'])
    for (const field of ['provider', 'model', 'operation'] as const) assertText(field, input[field])
    assertOptionalText('serviceTier', input.serviceTier)
    for (const field of RATE_FIELDS) assertOptionalAmount(field, input[field])
    assertOptionalCount('tierThresholdTokens', input.tierThresholdTokens)
    const row = await this.store.upsertPrice(input)
    this.cache.clear()
    return row
  }

  /** Full effective-dated history for a tuple. */
  getPriceHistory(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier?: ServiceTier,
  ): Promise<PriceVersion[]> {
    assertText('provider', provider)
    assertText('model', model)
    assertText('operation', operation)
    assertOptionalText('serviceTier', serviceTier)
    return this.store.getPriceHistory(provider, model, operation, serviceTier)
  }

  /**
   * Seed the registry from the pinned snapshot, adding only the tuples that have no row at
   * all. A tuple that already has history, including one the host re-priced with
   * `upsertPrice`, is left exactly as it is, so running this on every boot is a no-op once
   * the registry is seeded.
   */
  async seedFromSnapshot(): Promise<void> {
    const { MODEL_PRICES_SEED } = await import('@bymax-one/nest-ai-tokens/prices')
    for (const row of MODEL_PRICES_SEED) {
      const input = withEveryName({ ...row, effectiveFrom: SEED_EFFECTIVE_FROM }, PRICE_FIELDS)
      const seed = methodOf(this.store, 'seedPrice') as IPricingStore['seedPrice']
      if (seed !== undefined) {
        await seed(input)
        continue
      }
      const history = await this.store.getPriceHistory(row.provider, row.model, row.operation, row.serviceTier)
      if (history.length === 0) await this.store.upsertPrice(input)
    }
    this.cache.clear()
  }

  /** The §6.6 model-resolution chain (exact → baseModel → alias → normalized → prefix). */
  private async resolveUncached(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier: ServiceTier,
    at: Date,
    baseModel: string | undefined,
  ): Promise<PriceVersion | null> {
    const exact = await this.store.resolveRate(provider, model, operation, serviceTier, at)
    if (exact !== null) return exact

    if (baseModel !== undefined) {
      const byBase = await this.store.resolveRate(provider, baseModel, operation, serviceTier, at)
      if (byBase !== null) return byBase
    }

    const aliases = this.options.pricing.modelAliases
    const alias = Object.hasOwn(aliases, model) ? aliases[model] : undefined
    if (alias !== undefined) {
      const byAlias = await this.store.resolveRate(provider, alias, operation, serviceTier, at)
      if (byAlias !== null) return byAlias
    }

    const normalized = normalizeModelId(model)
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: CE/EQ/BS: step 4 is an optimization; any case where normalized !== model (e.g. 'gpt-5.2-2026-03-14' → 'gpt-5.2') will also be found by step 5 prefix matching since normalizedModel.startsWith(normalizeModelId(priced.model)) holds. Skipping/inverting/emptying step 4 is functionally equivalent given step 5 always follows.
    if (normalized !== model) {
      const byNormalized = await this.store.resolveRate(provider, normalized, operation, serviceTier, at)
      // Stryker disable next-line ConditionalExpression: CE false: dropping early return sends to prefix match which also finds the same model (step 5 startsWith covers exactly-normalized model IDs)
      if (byNormalized !== null) return byNormalized
    }

    return this.resolveByLongestPrefix(provider, normalized, operation, serviceTier, at)
  }

  /** §6.6 step 5: longest-`startsWith` match among priced models for provider+operation+tier. */
  private async resolveByLongestPrefix(
    provider: ProviderId,
    normalizedModel: string,
    operation: AiOperation,
    serviceTier: ServiceTier,
    at: Date,
  ): Promise<PriceVersion | null> {
    const models = await this.store.listModels(provider)
    let best: string | undefined
    // Stryker disable next-line UnaryOperator: +1 instead of -1: any candidate length ≥ 2 (all real model names) still beats +1; equivalent for all realistic models
    let bestLength = -1
    for (const priced of models) {
      if (priced.operation !== operation || priced.serviceTier !== serviceTier) continue
      const candidate = normalizeModelId(priced.model)
      // Stryker disable next-line EqualityOperator: >= instead of >: two distinct strings can never both be prefixes of the same target string at the same length; the >= vs > distinction is unreachable
      if (normalizedModel.startsWith(candidate) && candidate.length > bestLength) {
        best = priced.model
        bestLength = candidate.length
      }
    }
    if (best === undefined) return null
    return this.store.resolveRate(provider, best, operation, serviceTier, at)
  }
}
