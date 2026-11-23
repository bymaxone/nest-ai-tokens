/**
 * @fileoverview The usage a provider normalizer builds is the response's, never a key planted on `Object.prototype`: with each optional name of
 * a normalized usage planted, a call through the OpenAI chat normalizer is billed 6,250,000 nano-USD at the table rates, recorded or held and
 * captured, though the model has a rate on every axis the planted value would have reached.
 * @layer server
 */

import { buildUsage } from '../../shared/normalizers/usage-fields'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { ResolvedAiTokensOptions } from '../config'
import { providerPresets } from '../config/provider-presets'
import type { HoldEstimate, MeteringContext } from '../interfaces'
import { setRealmGuard } from '../utils/prototype-guard'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService } from './metering.service'
import { PricingService } from './pricing.service'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them; the guard is proven in prototype-guard.spec.ts.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }
const RAW = { model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 500 } }
const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }

/** Every optional name of a usage, with a value that moves the bill on the world below if it is read. */
const PLANTS: [string, unknown][] = [
  ['serverToolUse', { web_search: 1_000 }],
  ['cacheWrite5mTokens', 1_000_000],
  ['cacheWrite1hTokens', 1_000_000],
  ['reasoningTokens', 1_000_000],
  ['audioInTokens', 7],
  ['audioOutTokens', 7],
  ['imageInTokens', 7],
  ['imageOutTokens', 7],
  ['cacheReadTokens', 1_000_000],
  ['serviceTier', 'batch'],
  ['providerReportedCostNanoUsd', 123n],
]

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it. */
async function planted<T>(key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

/** A metering service whose gpt-5 price has a rate on every axis a plant could reach, and a cheaper batch tier. */
async function world(): Promise<MeteringService> {
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    wallets: { enabled: false },
    budgets: { enabled: false },
  } as unknown as ResolvedAiTokensOptions
  const pricing = new InMemoryPricingStore()
  const rates = {
    provider: 'openai' as const, model: 'gpt-5', operation: 'chat' as const,
    outputNanoUsdPerMillion: 10_000_000_000n, cacheReadNanoUsdPerMillion: 125_000_000n, cacheWrite5mNanoUsdPerMillion: 4_000_000_000n, cacheWrite1hNanoUsdPerMillion: 4_000_000_000n,
    reasoningNanoUsdPerMillion: 9_000_000_000n, audioInNanoUsdPerMillion: 3_000_000_000n, audioOutNanoUsdPerMillion: 3_000_000_000n, imageInNanoUsdPerMillion: 3_000_000_000n, imageOutNanoUsdPerMillion: 3_000_000_000n,
    unitRates: { web_search: 10_000_000n }, effectiveFrom: new Date(0),
  }
  await pricing.upsertPrice({ ...rates, serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n })
  await pricing.upsertPrice({ ...rates, serviceTier: 'batch', inputNanoUsdPerMillion: 625_000_000n })
  return new MeteringService(new LedgerService(new InMemoryLedgerStore(), options), new PricingService(options, pricing), new MarkupResolver(options), options, undefined, undefined, undefined, () => new Date())
}

describe('the usage a normalizer builds', () => {
  it.each(PLANTS)('is billed 6,250,000 when %s is planted, recorded at once', async (key, value) => {
    const service = await world()
    const record = await planted(key, value, () => service.record({ usage: RAW, preset: providerPresets.openaiChat, context: { ...CONTEXT, idempotencyKey: `r-${key}` } }))
    expect(record.billedCostNanoUsd).toBe(6_250_000n)
  })

  it.each(PLANTS)('is billed 6,250,000 when %s is planted, held and captured', async (key, value) => {
    const service = await world()
    const hold = await service.hold({ ...CONTEXT, idempotencyKey: `h-${key}` }, ESTIMATE)
    const captured = await planted(key, value, () => service.capture(hold, { tenantId: CONTEXT.tenantId, scope: CONTEXT.scope }, RAW, providerPresets.openaiChat))
    expect(captured.billedCostNanoUsd).toBe(6_250_000n)
  })
})

describe('buildUsage', () => {
  const DRAFT = { provider: 'openai' as const, model: 'gpt-5', operation: 'chat' as const, inputTokens: 1, outputTokens: 2 }

  it.each(PLANTS)('keeps %s planted on Object.prototype out of the usage, which has no prototype', async (key, value) => {
    const usage = await planted(key, value, () => Promise.resolve(buildUsage(DRAFT)))
    expect(Object.getPrototypeOf(usage)).toBeNull()
    expect(Object.keys(usage).sort()).toEqual(['audioInTokens', 'audioOutTokens', 'cacheReadTokens', 'cacheWrite1hTokens', 'cacheWrite5mTokens', 'imageInTokens', 'imageOutTokens', 'inputTokens', 'model', 'operation', 'outputTokens', 'provider', 'reasoningTokens'])
    expect(usage.cacheReadTokens).toBe(0)
  })

  it('still builds what the draft sets', () => {
    const usage = buildUsage({ ...DRAFT, serviceTier: 'batch', serverToolUse: { web_search: 3 }, providerReportedCostNanoUsd: 9n, audioInTokens: 4, raw: { a: 1 } })
    expect(usage).toEqual(expect.objectContaining({ serviceTier: 'batch', serverToolUse: { web_search: 3 }, providerReportedCostNanoUsd: 9n, audioInTokens: 4, raw: { a: 1 } }))
  })
})
