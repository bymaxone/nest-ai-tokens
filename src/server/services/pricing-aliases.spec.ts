/**
 * A model alias is one the host listed. A key that another library, or an attacker, planted on `Object.prototype` is not an alias: it
 * must not send a model to another model's price, and a model named like a property of every object (`constructor`) is a model with no alias.
 * @layer server
 */
import type { NewPriceVersion, PriceVersion } from '../../shared'
import type { ResolvedAiTokensOptions } from '../config'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { PricingService } from './pricing.service'

const AT = new Date('2026-06-01T00:00:00.000Z')

const options = (modelAliases: Record<string, string>): ResolvedAiTokensOptions => ({ pricing: { seedFromSnapshot: false, strict: false, cacheTtlMs: 300_000, modelAliases } }) as ResolvedAiTokensOptions

/** Seed a standard-tier row effective from the epoch. */
function seed(store: InMemoryPricingStore, over: Partial<NewPriceVersion> & Pick<NewPriceVersion, 'provider' | 'model' | 'operation'>): Promise<PriceVersion> {
  return store.upsertPrice({ serviceTier: 'standard', inputNanoUsdPerMillion: 1_000_000_000n, effectiveFrom: new Date(0), ...over })
}

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it. */
async function planted<T>(key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('the model aliases of the host', () => {
  /** An alias of the host sends the model to the price of another. */
  it('resolves a model through an alias the host listed', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const rate = await new PricingService(options({ legacy: 'gpt-5' }), store).resolveRate({ provider: 'openai', model: 'legacy', operation: 'chat', at: AT })
    expect(rate?.model).toBe('gpt-5')
  })

  /** A planted key is not an alias: the model has no price, as it would have without the key. */
  it('does not resolve a model through a key planted on Object.prototype', async () => {
    const store = new InMemoryPricingStore()
    await seed(store, { provider: 'openai', model: 'gpt-5', operation: 'chat' })
    const service = new PricingService(options({}), store)
    const rate = await planted('legacy-model', 'gpt-5', () => service.resolveRate({ provider: 'openai', model: 'legacy-model', operation: 'chat', at: AT }))
    expect(rate).toBeNull()
  })

  /** A model named like a property of every object is a model with no alias: it asks the store about itself, never about a function. */
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('asks the store about a model named %s and about nothing else', async (model) => {
    const store = new InMemoryPricingStore()
    const asked = jest.spyOn(store, 'resolveRate')
    const rate = await new PricingService(options({}), store).resolveRate({ provider: 'openai', model, operation: 'chat', at: AT })
    expect(rate).toBeNull()
    expect(asked.mock.calls.every((call) => typeof call[1] === 'string')).toBe(true)
  })
})
