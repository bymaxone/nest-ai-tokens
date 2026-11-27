/**
 * @fileoverview What `MeteringService` says about the calls it refuses: the error details, and the instant a hold expires.
 * @layer test
 */
import type { AiTokensErrorResponse, NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { providerPresets } from '../config/provider-presets'
import type { ResolvedAiTokensOptions } from '../config'
import type { AiTokensException } from '../errors'
import type { HoldEstimate, MeteringContext } from '../interfaces'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService, type MeteringEventHooks } from './metering.service'
import { PricingService } from './pricing.service'
import { WalletService } from './wallet.service'

const WALLETS = { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' } as const

const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }

const USAGE: NormalizedUsage = {
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningTokens: 0,
  audioInTokens: 0,
  audioOutTokens: 0,
  imageInTokens: 0,
  imageOutTokens: 0,
}

const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }

/** Read the error body from a thrown `AiTokensException`. */
function errorOf(error: unknown): AiTokensErrorResponse['error'] {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error
}

/** A MeteringService with a priced model and, on demand, a funded wallet. */
async function build(opts: { wallets?: boolean; clock?: () => Date } = {}): Promise<{ service: MeteringService; ledgerStore: InMemoryLedgerStore }> {
  const now = opts.clock ?? ((): Date => new Date())
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 60, reaperIntervalSeconds: 300 },
    wallets: opts.wallets ? WALLETS : { enabled: false },
    budgets: { enabled: false },
  } as ResolvedAiTokensOptions
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  await pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  const wallets = opts.wallets ? new WalletService(new InMemoryWalletStore({ now }), WALLETS) : undefined
  await wallets?.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'grant', reason: 'seed' })
  const events: MeteringEventHooks = {
    usageRecorded: () => Promise.resolve(),
    priceMissing: () => Promise.resolve(),
    holdReleased: () => Promise.resolve(),
    usageReversed: () => Promise.resolve(),
    settleFailed: () => Promise.resolve(),
    audit: () => Promise.resolve(),
  }
  const service = new MeteringService(new LedgerService(ledgerStore, options), new PricingService(options, pricingStore), new MarkupResolver(options), options, events, wallets, undefined, now)
  return { service, ledgerStore }
}

describe('MeteringService error details', () => {
  /** Raw usage with nothing to read it by is refused, and the details say what was expected. */
  it('says what usage it expected when no preset or normalizer is given', async () => {
    const { service } = await build()
    const error = await service.record({ usage: {}, context: CONTEXT }).catch((e: unknown) => e)
    expect(errorOf(error).code).toBe('AI_TOKENS_UNKNOWN_PROVIDER')
    expect(errorOf(error).details).toEqual({ reason: 'raw usage requires a preset or normalizer, or an already-normalized usage' })
  })

  /** Enforcement needs a feature that can enforce. */
  it('says which features enforce needs', async () => {
    const { service } = await build()
    const error = await service.record({ usage: USAGE, context: { ...CONTEXT, enforce: true } }).catch((e: unknown) => e)
    expect(errorOf(error).code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(errorOf(error).details).toEqual({ reason: 'enforce requires the wallets or budgets feature to be enabled' })
  })

  /** A normalizer that fails on the usage is reported as malformed usage, with a reason that quotes none of it. */
  it('reports a normalizer that throws as malformed usage', async () => {
    const { service } = await build()
    const preset = { ...providerPresets.openaiChat, normalizer: (): never => { throw new TypeError('cannot read usage') } }
    const error = await service.record({ usage: {}, preset, context: CONTEXT }).catch((e: unknown) => e)
    expect(errorOf(error).code).toBe('AI_TOKENS_USAGE_MALFORMED')
    expect(errorOf(error).details).toEqual({ reason: 'the normalizer could not read the usage token fields' })
  })

  /** The hold has expired at the instant its time to live ends, not only after it; before that it is merely settled. */
  it.each<[string, number, string]>([
    ['within', 59_999, 'AI_TOKENS_HOLD_ALREADY_SETTLED'],
    ['at the exact end of', 60_000, 'AI_TOKENS_HOLD_EXPIRED'],
  ])('names the hold when a released one is captured %s its time to live', async (_when, elapsedMs, code) => {
    let clock = new Date(Date.now() + 3_600_000)
    const { service, ledgerStore } = await build({ wallets: true, clock: () => clock })
    const hold = await service.hold(CONTEXT, ESTIMATE)
    const record = await ledgerStore.findById(hold.id)
    await service.release(hold, CONTEXT, 'abort')
    clock = new Date(record!.createdAt.getTime() + elapsedMs)
    const error = await service.capture(hold, CONTEXT, USAGE).catch((e: unknown) => e)
    expect(errorOf(error).code).toBe(code)
    expect(errorOf(error).details).toEqual({ holdId: hold.id })
  })

  /** A hold whose row is gone by the time the capture reads it again is reported as not found. */
  it('names the hold that vanished during a capture', async () => {
    const { service, ledgerStore } = await build({ wallets: true })
    const hold = await service.hold(CONTEXT, ESTIMATE)
    const pending = await ledgerStore.findById(hold.id)
    jest.spyOn(ledgerStore, 'transition').mockResolvedValueOnce(null)
    jest.spyOn(ledgerStore, 'findById').mockResolvedValueOnce(pending).mockResolvedValueOnce(null)
    const error = await service.capture(hold, CONTEXT, USAGE).catch((e: unknown) => e)
    expect(errorOf(error).code).toBe('AI_TOKENS_HOLD_NOT_FOUND')
    expect(errorOf(error).details).toEqual({ holdId: hold.id })
  })
})
