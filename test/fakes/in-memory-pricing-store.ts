/**
 * @fileoverview An in-memory {@link IPricingStore} for tests — a faithful stand-in
 * for the Prisma adapter: effective-dated rows, one open row per
 * (provider, model, operation, serviceTier), and a modeled advisory seed lock
 * (with a `seedLockAcquisitions` counter) so concurrent seeding runs exactly once.
 * Lives under `test/` so it is not collected for coverage.
 * @layer test
 */

import type {
  AiOperation,
  NewPriceVersion,
  PriceVersion,
  ProviderId,
  ServiceTier,
} from '@bymax-one/nest-ai-tokens/shared'
import type { IPricingStore, PricedModel } from '@bymax-one/nest-ai-tokens'

/** An in-memory pricing store plus the seed-lock extension the service feature-detects. */
export class InMemoryPricingStore implements IPricingStore {
  private readonly rows: PriceVersion[] = []
  private idSeq = 0
  /** Number of successful seed-lock acquisitions (asserted by the concurrency test). */
  public seedLockAcquisitions = 0
  private readonly heldLocks = new Set<string>()

  /** Model the advisory lock the official adapter uses; the first caller wins. */
  acquireSeedLock(key: string): Promise<boolean> {
    if (this.heldLocks.has(key)) return Promise.resolve(false)
    this.heldLocks.add(key)
    this.seedLockAcquisitions += 1
    return Promise.resolve(true)
  }

  resolveRate(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier: ServiceTier,
    at: Date,
  ): Promise<PriceVersion | null> {
    const match = this.rows.find(
      (row) =>
        row.provider === provider &&
        row.model === model &&
        row.operation === operation &&
        row.serviceTier === serviceTier &&
        row.effectiveFrom <= at &&
        (row.effectiveTo === null || row.effectiveTo >= at),
    )
    return Promise.resolve(match ?? null)
  }

  upsertPrice(input: NewPriceVersion): Promise<PriceVersion> {
    const serviceTier = input.serviceTier ?? 'standard'
    const effectiveFrom = input.effectiveFrom ?? new Date()
    const open = this.rows.find(
      (row) =>
        row.provider === input.provider &&
        row.model === input.model &&
        row.operation === input.operation &&
        row.serviceTier === serviceTier &&
        row.effectiveTo === null,
    )
    if (open) open.effectiveTo = effectiveFrom
    const row: PriceVersion = {
      id: `price-${String(++this.idSeq)}`,
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      serviceTier,
      inputNanoUsdPerMillion: input.inputNanoUsdPerMillion ?? 0n,
      outputNanoUsdPerMillion: input.outputNanoUsdPerMillion ?? 0n,
      cacheReadNanoUsdPerMillion: input.cacheReadNanoUsdPerMillion ?? 0n,
      cacheWrite5mNanoUsdPerMillion: input.cacheWrite5mNanoUsdPerMillion ?? 0n,
      cacheWrite1hNanoUsdPerMillion: input.cacheWrite1hNanoUsdPerMillion ?? 0n,
      reasoningNanoUsdPerMillion: input.reasoningNanoUsdPerMillion ?? 0n,
      audioInNanoUsdPerMillion: input.audioInNanoUsdPerMillion ?? 0n,
      audioOutNanoUsdPerMillion: input.audioOutNanoUsdPerMillion ?? 0n,
      imageInNanoUsdPerMillion: input.imageInNanoUsdPerMillion ?? 0n,
      imageOutNanoUsdPerMillion: input.imageOutNanoUsdPerMillion ?? 0n,
      ...(input.tierThresholdTokens !== undefined ? { tierThresholdTokens: input.tierThresholdTokens } : {}),
      ...(input.tierInputNanoUsdPerMillion !== undefined
        ? { tierInputNanoUsdPerMillion: input.tierInputNanoUsdPerMillion }
        : {}),
      ...(input.tierOutputNanoUsdPerMillion !== undefined
        ? { tierOutputNanoUsdPerMillion: input.tierOutputNanoUsdPerMillion }
        : {}),
      ...(input.unitRates !== undefined ? { unitRates: input.unitRates } : {}),
      currency: 'USD',
      effectiveFrom,
      effectiveTo: null,
      source: input.source ?? 'manual',
    }
    this.rows.push(row)
    return Promise.resolve(row)
  }

  getPriceHistory(
    provider: ProviderId,
    model: string,
    operation: AiOperation,
    serviceTier?: ServiceTier,
  ): Promise<PriceVersion[]> {
    const history = this.rows
      .filter(
        (row) =>
          row.provider === provider &&
          row.model === model &&
          row.operation === operation &&
          (serviceTier === undefined || row.serviceTier === serviceTier),
      )
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())
    return Promise.resolve(history)
  }

  listModels(provider: ProviderId): Promise<PricedModel[]> {
    const seen = new Set<string>()
    const models: PricedModel[] = []
    for (const row of this.rows) {
      if (row.provider !== provider) continue
      const key = `${row.model}|${row.operation}|${row.serviceTier}`
      if (seen.has(key)) continue
      seen.add(key)
      models.push({ model: row.model, operation: row.operation, serviceTier: row.serviceTier })
    }
    return Promise.resolve(models)
  }
}
