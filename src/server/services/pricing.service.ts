/**
 * @fileoverview `PricingService` — effective-dated rate resolution with the §6.6
 * six-step model-resolution chain, an in-memory TTL cache, price upserts, and the
 * idempotent snapshot seed (§6.3/§6.4). A call is priced at the rate in effect at
 * its timestamp; batch/flex/priority tiers must find their own row (no silent
 * fallback to standard rates).
 * @layer server
 */

import { Injectable } from '@nestjs/common'
import type { OnModuleInit } from '@nestjs/common'
import type { AiOperation, NewPriceVersion, PriceVersion, ProviderId, ServiceTier } from '../../shared'
import { AiTokensException } from '../errors'
import type { IPricingStore } from '../interfaces'
import type { ResolvedAiTokensOptions } from '../config'
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

/** The optional advisory-lock extension the official adapters implement (§6.4). */
interface SeedLockCapableStore {
  acquireSeedLock(key: string): Promise<boolean>
}

/** All seed rows are effective from the epoch so they form the baseline for any timestamp. */
const SEED_EFFECTIVE_FROM = new Date(0)
/** The advisory-lock key guarding the one-time snapshot seed. */
const SEED_LOCK_KEY = 'ai-tokens:model-prices'

@Injectable()
export class PricingService implements OnModuleInit {
  private readonly cache = new Map<string, { value: PriceVersion | null; expiresAt: number }>()

  /**
   * @param options The resolved module options (pricing config lives here).
   * @param store The pricing store port.
   * @param now A clock returning epoch milliseconds; injected for testability.
   */
  constructor(
    private readonly options: ResolvedAiTokensOptions,
    private readonly store: IPricingStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Seed the registry on boot when enabled. */
  async onModuleInit(): Promise<void> {
    if (this.options.pricing.seedFromSnapshot) await this.seedFromSnapshot()
  }

  /**
   * Resolve the price version in effect at `input.at`, applying the §6.6 chain.
   *
   * @param input The provider/model/operation/timestamp (+ optional tier/baseModel).
   * @returns The matching price version, or `null` in non-strict mode on a miss.
   * @throws {AiTokensException} `AI_TOKENS_PRICE_NOT_FOUND` on a miss in strict mode.
   */
  async resolveRate(input: ResolveRateInput): Promise<PriceVersion | null> {
    const serviceTier = input.serviceTier ?? 'standard'
    const operation = input.operation === 'responses' ? 'chat' : input.operation
    const bucket = Math.floor(input.at.getTime() / this.options.pricing.cacheTtlMs)
    const cacheKey = `${input.provider}|${input.model}|${input.baseModel ?? ''}|${operation}|${serviceTier}|${String(bucket)}`

    let resolved: PriceVersion | null
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined && this.now() < cached.expiresAt) {
      resolved = cached.value
    } else {
      resolved = await this.resolveUncached(input.provider, input.model, operation, serviceTier, input.at, input.baseModel)
      this.cache.set(cacheKey, { value: resolved, expiresAt: this.now() + this.options.pricing.cacheTtlMs })
    }

    if (resolved === null && this.options.pricing.strict) {
      throw new AiTokensException('AI_TOKENS_PRICE_NOT_FOUND', undefined, {
        provider: input.provider,
        model: input.model,
        operation: input.operation,
        serviceTier,
      })
    }
    return resolved
  }

  /**
   * Close the current open row and insert a new one; clears the resolution cache.
   * ADMIN PLANE: this sets prices — the host MUST restrict it to privileged roles
   * (§14.4) and should audit every call.
   *
   * @param input The new price version (rates default to `0n`, tier to `'standard'`).
   * @returns The newly-inserted open price row.
   */
  async upsertPrice(input: NewPriceVersion): Promise<PriceVersion> {
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
    return this.store.getPriceHistory(provider, model, operation, serviceTier)
  }

  /** Seed the registry from the pinned snapshot; idempotent and advisory-locked. */
  async seedFromSnapshot(): Promise<void> {
    const lockable = this.store as Partial<SeedLockCapableStore>
    if (typeof lockable.acquireSeedLock === 'function') {
      const acquired = await lockable.acquireSeedLock(SEED_LOCK_KEY)
      if (!acquired) return
    }
    const { MODEL_PRICES_SEED } = await import('@bymax-one/nest-ai-tokens/prices')
    for (const row of MODEL_PRICES_SEED) {
      await this.store.upsertPrice({ ...row, effectiveFrom: SEED_EFFECTIVE_FROM })
    }
    this.cache.clear()
  }

  /** The §6.6 six-step model-resolution chain (exact → baseModel → alias → normalized → prefix). */
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

    const alias = this.options.pricing.modelAliases[model]
    if (alias !== undefined) {
      const byAlias = await this.store.resolveRate(provider, alias, operation, serviceTier, at)
      if (byAlias !== null) return byAlias
    }

    const normalized = normalizeModelId(model)
    if (normalized !== model) {
      const byNormalized = await this.store.resolveRate(provider, normalized, operation, serviceTier, at)
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
    let bestLength = -1
    for (const priced of models) {
      if (priced.operation !== operation || priced.serviceTier !== serviceTier) continue
      const candidate = normalizeModelId(priced.model)
      if (normalizedModel.startsWith(candidate) && candidate.length > bestLength) {
        best = priced.model
        bestLength = candidate.length
      }
    }
    if (best === undefined) return null
    return this.store.resolveRate(provider, best, operation, serviceTier, at)
  }
}
