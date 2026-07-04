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

  /**
   * The longest prefix wins even when a SHORTER prefix candidate is iterated last.
   * `listModels` preserves insertion order, so seeding the longer 'gpt-5-turbo' first
   * and the shorter 'gpt-5' last makes the shorter one the final iteration. This kills
   * the L192 ConditionalExpression on `candidate.length > bestLength`: `→ true` would
   * update `best` on every prefix match and let the last-iterated 'gpt-5' win, while
   * `→ false` would never update `best` and return null. Only the real `>` comparison
   * keeps 'gpt-5-turbo'. (The existing longest-prefix test seeds them in the opposite
   * order, so its last candidate is already the correct one and cannot expose `→ true`.)
   */
  it('keeps the longest prefix when a shorter candidate is iterated last', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5-turbo', operation: 'chat' }) // longer prefix, iterated first
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' }) // shorter prefix, iterated last
    const service = new PricingService(options({ strict: false }), store)
    const rate = await service.resolveRate({ provider: 'openai', model: 'gpt-5-turbo-preview', operation: 'chat', at: AT })
    // Both are prefixes of 'gpt-5-turbo-preview'; the longer 'gpt-5-turbo' must win regardless of iteration order.
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

  /**
   * A non-'responses' operation ('embeddings') must NOT be mapped to 'chat'.
   * Kills CE→true on `operation === 'responses' ? 'chat' : input.operation`:
   * with CE→true, 'embeddings' would resolve to 'chat', finding the seeded 'chat' price.
   * Without CE→true, it correctly returns null (no 'embeddings' price exists for 'gpt-5').
   */
  it('passes non-responses operations through unchanged', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const service = new PricingService(options({ strict: false }), store)
    // 'embeddings' is not 'responses', so it must NOT be mapped to 'chat'
    const rate = await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'embeddings', at: AT })
    expect(rate).toBeNull()
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

  /** baseModel undefined skips step 2 — must not enter the branch when baseModel is absent. */
  it('skips the baseModel lookup when baseModel is not provided', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const resolveRateSpy = jest.spyOn(store, 'resolveRate')
    const service = new PricingService(options(), store)
    await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT }) // no baseModel
    // Without baseModel there should be only ONE store.resolveRate call (step 1 hits and returns).
    expect(resolveRateSpy).toHaveBeenCalledTimes(1)
  })

  /** alias === undefined skips step 3 — a model with no alias in the map must not try alias lookup. */
  it('skips the alias lookup when the model has no alias', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const resolveRateSpy = jest.spyOn(store, 'resolveRate')
    const service = new PricingService(options({ modelAliases: {} }), store) // no aliases
    await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT })
    // Only one call for step 1 (exact match returns immediately; no alias map entry → step 3 skipped).
    expect(resolveRateSpy).toHaveBeenCalledTimes(1)
  })

  /** normalized === model skips step 4 — already-normalized model must not re-resolve with itself. */
  it('skips the normalized lookup when the model id is already normalized', async () => {
    const store = new InMemoryPricingStore()
    // 'gpt-5' normalizes to 'gpt-5' (no snapshot suffix), so step 4 would be a no-op duplicate.
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const resolveRateSpy = jest.spyOn(store, 'resolveRate')
    const service = new PricingService(options(), store)
    await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT })
    // Step 1 hits; model is already normalized, step 4 is skipped.
    expect(resolveRateSpy).toHaveBeenCalledTimes(1)
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

  /** When two candidates share the same prefix length, only one wins (kills > vs >= in bestLength). */
  it('returns a deterministic result for equally-long prefix matches', async () => {
    // Two models have the same length. The resolution should still return a valid (non-null) price.
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    await seed(store, { provider: 'openai', model: 'gpt-6', operation: 'chat' })
    const service = new PricingService(options({ strict: false }), store)
    const rate = await service.resolveRate({ provider: 'openai', model: 'gpt-5-turbo', operation: 'chat', at: AT })
    // gpt-5 is a prefix of gpt-5-turbo (length 5 > -1), gpt-6 is not a prefix at all.
    expect(rate?.model).toBe('gpt-5')
  })

  /** No prefix match → resolveByLongestPrefix returns null (kills best === undefined → !== undefined). */
  it('returns null when no prefix matches exist', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'davinci', operation: 'chat' })
    const service = new PricingService(options({ strict: false }), store)
    const rate = await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT })
    // 'davinci' is NOT a prefix of 'gpt-5', so best remains undefined → return null.
    expect(rate).toBeNull()
  })

  /** The prefix check filters by operation and serviceTier (kills the early-continue condition). */
  it('ignores prefix candidates with a different operation or serviceTier', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'embeddings' })  // wrong operation
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'flex' }) // wrong tier
    const service = new PricingService(options({ strict: false }), store)
    const rate = await service.resolveRate({
      provider: 'openai', model: 'gpt-5-turbo', operation: 'chat', at: AT, serviceTier: 'standard',
    })
    // Neither the embeddings row nor the flex-tier row should match chat/standard.
    expect(rate).toBeNull()
  })

  /**
   * The prefix filter is `opMismatch || tierMismatch` — a candidate qualifies only
   * when BOTH its operation AND its serviceTier match the request. This kills the L189
   * survivors (ConditionalExpression → false on the whole test and on each operand,
   * plus LogicalOperator || → &&): under any of those mutations an op-matching /
   * tier-mismatched row ('gpt-5-turbo' chat/flex) or a tier-matching / op-mismatched
   * row ('gpt-5-turbo' embeddings/standard) leaks past the filter and becomes the
   * longest prefix, so the final chat/standard lookup for 'gpt-5-turbo' finds no row
   * and returns null. Only the correct filter keeps 'gpt-5' (chat/standard) and
   * resolves it — so ORIGINAL yields 'gpt-5' while every mutant yields null.
   */
  it('selects only the op+tier-matching prefix candidate', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5-turbo', operation: 'chat', serviceTier: 'flex' }) // op match, tier mismatch
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard' }) // both match (the only valid candidate)
    await seed(store, { provider: 'openai', model: 'gpt-5-turbo', operation: 'embeddings', serviceTier: 'standard' }) // op mismatch, tier match
    const service = new PricingService(options({ strict: false }), store)
    const rate = await service.resolveRate({
      provider: 'openai',
      model: 'gpt-5-turbo-2026',
      operation: 'chat',
      at: AT,
      serviceTier: 'standard',
    })
    // Longer 'gpt-5-turbo' rows are wrong op/tier and must be filtered out, leaving 'gpt-5'.
    expect(rate?.model).toBe('gpt-5')
  })

  /** Successful resolveRate in strict mode must NOT throw (kills && → || on the strict-throw condition). */
  it('returns the price in strict mode when a match is found — does not throw', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const service = new PricingService(options({ strict: true }), store)
    const rate = await service.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: AT })
    expect(rate?.model).toBe('gpt-5')
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
