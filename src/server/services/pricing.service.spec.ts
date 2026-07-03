import type { AiTokensErrorResponse, NewPriceVersion, PriceVersion } from '../../shared'
import type { AiTokensException } from '../errors'
import type { ResolvedAiTokensOptions, ResolvedPricingOptions } from '../config'
import type { IPricingStore } from '../interfaces'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { PricingService } from './pricing.service'

/** Build a resolved options object; only `.pricing` is read by the service. */
function options(pricing: Partial<ResolvedPricingOptions> = {}): ResolvedAiTokensOptions {
  return {
    pricing: { seedFromSnapshot: false, strict: true, cacheTtlMs: 300_000, modelAliases: {}, ...pricing },
  } as ResolvedAiTokensOptions
}

const AT = new Date('2026-06-01T00:00:00.000Z')

/** Seed a standard-tier row effective from the epoch. */
function seed(
  store: InMemoryPricingStore,
  over: Partial<NewPriceVersion> & Pick<NewPriceVersion, 'provider' | 'model' | 'operation'>,
): Promise<PriceVersion> {
  return store.upsertPrice({
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_000_000_000n,
    effectiveFrom: new Date(0),
    ...over,
  })
}

describe('PricingService.resolveRate', () => {
  /** Step 1: an exact model match resolves. */
  it('resolves an exact match', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const service = new PricingService(options(), store)
    const rate = await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT })
    expect(rate?.model).toBe('gpt-5')
  })

  /** Step 2: the caller's baseModel override resolves a deployment-named model. */
  it('resolves via the baseModel override', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'azure-openai', model: 'gpt-5', operation: 'chat' })
    const service = new PricingService(options(), store)
    const rate = await service.resolveRate({
      provider: 'azure-openai',
      model: 'my-deployment',
      operation: 'chat',
      at: AT,
      baseModel: 'gpt-5',
    })
    expect(rate?.model).toBe('gpt-5')
  })

  /** Step 3: a configured alias resolves. */
  it('resolves via the alias map', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const service = new PricingService(options({ modelAliases: { legacy: 'gpt-5' } }), store)
    const rate = await service.resolveRate({ provider: 'openai', model: 'legacy', operation: 'chat', at: AT })
    expect(rate?.model).toBe('gpt-5')
  })

  /** Step 4: a dated snapshot resolves via the normalized id. */
  it('resolves via the normalized model id', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5.2', operation: 'chat' })
    const service = new PricingService(options(), store)
    const rate = await service.resolveRate({
      provider: 'openai',
      model: 'gpt-5.2-2026-03-14',
      operation: 'chat',
      at: AT,
    })
    expect(rate?.model).toBe('gpt-5.2')
  })

  /** Step 5: the longest-startsWith priced model wins; other op/tier rows are ignored. */
  it('resolves via the longest prefix match', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    await seed(store, { provider: 'openai', model: 'gpt-5-turbo', operation: 'chat' })
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'embeddings' })
    const service = new PricingService(options(), store)
    const rate = await service.resolveRate({
      provider: 'openai',
      model: 'gpt-5-turbo-2026',
      operation: 'chat',
      at: AT,
    })
    expect(rate?.model).toBe('gpt-5-turbo')
  })

  /** The `responses` operation resolves `chat` price rows. */
  it("treats 'responses' as 'chat'", async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const service = new PricingService(options(), store)
    const rate = await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'responses', at: AT })
    expect(rate?.operation).toBe('chat')
  })

  /** A strict-mode miss throws PRICE_NOT_FOUND; a non-strict miss returns null. */
  it('throws in strict mode and returns null otherwise on a miss', async () => {
    const store = new InMemoryPricingStore()
    const strict = new PricingService(options({ strict: true }), store)
    const error = await strict
      .resolveRate({ provider: 'openai', model: 'unknown', operation: 'chat', at: AT })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as AiTokensException)
    expect((error?.getResponse() as AiTokensErrorResponse).error.code).toBe('AI_TOKENS_PRICE_NOT_FOUND')

    const lenient = new PricingService(options({ strict: false }), store)
    await expect(
      lenient.resolveRate({ provider: 'openai', model: 'unknown', operation: 'chat', at: AT }),
    ).resolves.toBeNull()
  })

  /** Every earlier chain step can miss and fall through to the prefix match. */
  it('falls through each chain step on a miss', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    await seed(store, { provider: 'openai', model: 'davinci', operation: 'chat' })
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'embeddings' })
    const service = new PricingService(options({ modelAliases: { 'gpt-5-turbo-2026-03-14': 'missing-alias' } }), store)
    const rate = await service.resolveRate({
      provider: 'openai',
      model: 'gpt-5-turbo-2026-03-14', // normalizes to gpt-5-turbo (not seeded → normalized miss)
      operation: 'chat',
      at: AT,
      baseModel: 'missing-base', // provided but unseeded → baseModel miss
    })
    expect(rate?.model).toBe('gpt-5') // prefix match, davinci ignored, embeddings row skipped
  })

  /** A non-standard tier with no tier row is a miss — never billed at standard rates. */
  it('never falls back from a non-standard tier to standard', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard' })
    const service = new PricingService(options({ strict: false }), store)
    await expect(
      service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT, serviceTier: 'flex' }),
    ).resolves.toBeNull()
    await expect(
      service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT, serviceTier: 'standard' }),
    ).resolves.not.toBeNull()
  })

  /** The cache serves within the TTL and re-resolves after it lapses. */
  it('caches within the TTL and refreshes after', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    let clock = 1000
    const service = new PricingService(options({ cacheTtlMs: 300_000 }), store, () => clock)
    const spy = jest.spyOn(store, 'resolveRate')
    await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT })
    const afterFirst = spy.mock.calls.length
    await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT })
    expect(spy.mock.calls.length).toBe(afterFirst) // cache hit — no store call
    clock += 400_000
    await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT })
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst) // refreshed
  })
})

describe('PricingService.upsertPrice / getPriceHistory', () => {
  /** Upsert closes the open row and inserts a new one; history returns both. */
  it('closes the open row and records history', async () => {
    const store = new InMemoryPricingStore()
    const service = new PricingService(options(), store)
    await service.upsertPrice({
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      serviceTier: 'standard',
      inputNanoUsdPerMillion: 1_000_000_000n,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    })
    await service.upsertPrice({
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      serviceTier: 'standard',
      inputNanoUsdPerMillion: 2_000_000_000n,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
    })
    const history = await service.getPriceHistory('openai', 'gpt-5', 'chat')
    expect(history).toHaveLength(2)
    expect(history[0]?.effectiveTo).toBeNull() // newest is open
    expect(history[1]?.effectiveTo).not.toBeNull() // older was closed
  })

  /** Upsert invalidates the resolution cache. */
  it('invalidates the cache on upsert', async () => {
    const store = new InMemoryPricingStore()
    const service = new PricingService(options({ strict: false }), store)
    await expect(
      service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT }),
    ).resolves.toBeNull()
    await service.upsertPrice({
      provider: 'openai',
      model: 'gpt-5',
      operation: 'chat',
      inputNanoUsdPerMillion: 1n,
      effectiveFrom: new Date(0),
    })
    await expect(
      service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT }),
    ).resolves.not.toBeNull()
  })
})

describe('PricingService.seedFromSnapshot', () => {
  /** Seeding populates the registry once and records one lock acquisition. */
  it('seeds the snapshot under an advisory lock', async () => {
    const store = new InMemoryPricingStore()
    const service = new PricingService(options({ seedFromSnapshot: true }), store)
    await service.seedFromSnapshot()
    expect(store.seedLockAcquisitions).toBe(1)
    const history = await service.getPriceHistory('openai', 'gpt-5', 'chat', 'standard')
    expect(history).toHaveLength(1)
  })

  /** Two concurrent inits on one store seed exactly once. */
  it('seeds exactly once across two concurrent inits', async () => {
    const store = new InMemoryPricingStore()
    const a = new PricingService(options({ seedFromSnapshot: true }), store)
    const b = new PricingService(options({ seedFromSnapshot: true }), store)
    await Promise.all([a.seedFromSnapshot(), b.seedFromSnapshot()])
    expect(store.seedLockAcquisitions).toBe(1)
    const history = await store.getPriceHistory('anthropic', 'claude-opus-4', 'chat', 'standard')
    expect(history).toHaveLength(1)
  })

  /** A store without the advisory-lock extension still seeds. */
  it('seeds a store lacking the seed-lock extension', async () => {
    const upsert = jest.fn((_input: NewPriceVersion) => Promise.resolve({} as PriceVersion))
    const noLockStore: IPricingStore = {
      resolveRate: () => Promise.resolve(null),
      upsertPrice: upsert,
      getPriceHistory: () => Promise.resolve([]),
      listModels: () => Promise.resolve([]),
    }
    await new PricingService(options({ seedFromSnapshot: true }), noLockStore).seedFromSnapshot()
    expect(upsert).toHaveBeenCalled()
  })

  /** onModuleInit seeds when enabled and does nothing when disabled. */
  it('seeds from onModuleInit only when enabled', async () => {
    const enabledStore = new InMemoryPricingStore()
    await new PricingService(options({ seedFromSnapshot: true }), enabledStore).onModuleInit()
    expect(enabledStore.seedLockAcquisitions).toBe(1)

    const disabledStore = new InMemoryPricingStore()
    await new PricingService(options({ seedFromSnapshot: false }), disabledStore).onModuleInit()
    expect(disabledStore.seedLockAcquisitions).toBe(0)
  })
})
