/**
 * @fileoverview Pins that `MeteringService.meter` lets a provider SDK's promise through: the metered function may return a subclass of
 * `Promise` with a `then` of its own, on the path with a hold and on the path without an estimate.
 * @layer server
 */

import type { NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { HoldEstimate, MeteringContext } from '../interfaces'
import { ContentCapture } from './content-capture'
import { TelemetryEmitter } from '../telemetry/otel-emitter'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService } from './metering.service'
import { PricingService } from './pricing.service'
import { WalletService } from './wallet.service'

const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }
const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }
const USAGE: NormalizedUsage = {
  provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0,
}

/** A metering service over in-memory stores, with a funded wallet and a gpt-5 price. */
async function build(): Promise<MeteringService> {
  const now = (): Date => new Date()
  const pricingStore = new InMemoryPricingStore()
  const options = {
    ratingMode: 'rate-table', markup: 1, ledger: { hashChain: false },
    pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    wallets: { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    budgets: { enabled: false },
  } as ResolvedAiTokensOptions
  const wallets = new WalletService(new InMemoryWalletStore({ now }), options.wallets as never)
  await pricingStore.upsertPrice({
    provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n,
    outputNanoUsdPerMillion: 10_000_000_000n, unitRates: { web_search_requests: 1n }, effectiveFrom: new Date(0),
  })
  await wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'grant-u1', reason: 'seed' })
  const events = { usageRecorded: jest.fn(() => Promise.resolve()), priceMissing: jest.fn(() => Promise.resolve()), holdReleased: jest.fn(() => Promise.resolve()), usageReversed: jest.fn(() => Promise.resolve()), audit: jest.fn(() => Promise.resolve()) }
  return new MeteringService(new LedgerService(new InMemoryLedgerStore(), options), new PricingService(options, pricingStore), new MarkupResolver(options), options, events, wallets, undefined, now, new TelemetryEmitter(null), new ContentCapture({ enabled: false }))
}

describe('MeteringService.meter with a provider SDK promise', () => {
  /** A provider SDK answers with a subclass of Promise whose `then` is its own: the metered function is where that is let through, on both paths. */
  it.each([['with a hold', ESTIMATE], ['without an estimate', undefined]] as const)('meters a function that returns a promise subclass, %s', async (_name, estimate) => {
    class SdkPromise<T> extends Promise<T> {}
    const service = await build()
    const { result, usage } = await service.meter(() => SdkPromise.resolve({ usage: USAGE }), CONTEXT, (r) => r.usage, estimate)
    expect(result.usage.provider).toBe('openai')
    expect(usage.status).toBe('posted')
  })
})
