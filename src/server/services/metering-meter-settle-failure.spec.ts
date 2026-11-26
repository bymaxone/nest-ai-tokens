/**
 * @fileoverview `MeteringService.meter()` when the function served and its usage could not be settled: the failure is announced,
 * with or without a hold.
 * @layer server/services
 */

import { Logger } from '@nestjs/common'
import type { NormalizedUsage } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { MeteringContext } from '../interfaces'
import { BudgetService, LedgerService, MarkupResolver, MeteringService, PricingService, WalletService } from '.'
import type { MeteringEventHooks } from '.'

const SECRET = 'postgres://user:hunter2@db/prod'
const WALLET = { tenantId: 'tenant-1', ownerType: 'user' as const, ownerId: 'u1' }
const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }
const ESTIMATE = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 } as const
const FUNDED = 100_000_000n

/** A complete normalized usage (1000-in / 500-out gpt-5 chat). */
function normalized(): NormalizedUsage {
  return { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
}

/** What a row works with. */
interface Stack {
  metering: MeteringService
  ledger: LedgerService
  events: { [K in keyof MeteringEventHooks]: jest.Mock }
  balance: () => Promise<bigint>
}

/** A funded metering stack over in-memory stores, with recording event hooks. */
async function setup(): Promise<Stack> {
  const now = (): Date => new Date()
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    settlement: { enabled: false },
    wallets: { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    budgets: { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true },
  } as unknown as ResolvedAiTokensOptions
  const events = {
    usageRecorded: jest.fn(() => Promise.resolve()),
    priceMissing: jest.fn(() => Promise.resolve()),
    holdReleased: jest.fn(() => Promise.resolve()),
    usageReversed: jest.fn(() => Promise.resolve()),
    settleFailed: jest.fn(() => Promise.resolve()),
    audit: jest.fn(() => Promise.resolve()),
  }
  const ledger = new LedgerService(new InMemoryLedgerStore(), options)
  const pricingStore = new InMemoryPricingStore()
  await pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  const wallets = new WalletService(new InMemoryWalletStore({ now }), options.wallets as never)
  await wallets.grant(WALLET, { amountNanoUsd: FUNDED, idempotencyKey: 'g1', reason: 'seed' })
  const budgets = new BudgetService(new InMemoryBudgetStore({ now }), ledger, options.budgets as never, now)
  const metering = new MeteringService(ledger, new PricingService(options, pricingStore), new MarkupResolver(options), options, events, wallets, budgets, now)
  const balance = async (): Promise<bigint> => (await wallets.getBalance(WALLET)).nanoUsd
  return { metering, ledger, events, balance }
}

/** Call `meter()` over a served function and return what the caller sees; an estimate selects the hold path. */
function meter(built: Stack, served: () => Promise<unknown>, estimate?: typeof ESTIMATE): Promise<unknown> {
  return built.metering.meter(served, CONTEXT, (result) => result, estimate).catch((error: unknown) => error)
}

const usable = (): Promise<unknown> => Promise.resolve(normalized())
const unusable = (): Promise<unknown> => Promise.resolve({ not: 'usable' })

/** The one event a failed settle of `meter()` emits for this payer. */
const announced = (data: Record<string, unknown>): unknown[][] => [['tenant-1', CONTEXT.scope, { ...data, where: 'meter' }]]

describe('MeteringService.meter() when settling fails after the function served', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

  /** The reservation is released, then the lost usage is announced with the hold id and the code. */
  it('releases the hold and then announces a failed capture', async () => {
    const built = await setup()
    const error = await meter(built, unusable, ESTIMATE)
    expect(error).toMatchObject({ response: { error: { code: 'AI_TOKENS_USAGE_MALFORMED' } } })
    expect(built.events.holdReleased).toHaveBeenCalledWith(expect.anything(), 'capture failed', false)
    const holdId = (built.events.holdReleased.mock.calls[0] as [{ id: string }])[0].id
    expect(built.events.settleFailed.mock.calls).toEqual(announced({ holdId, errorCode: 'AI_TOKENS_USAGE_MALFORMED' }))
    expect(built.events.holdReleased.mock.invocationCallOrder[0]).toBeLessThan(Number(built.events.settleFailed.mock.invocationCallOrder[0]))
    expect(await built.balance()).toBe(FUNDED)
  })

  /** A cleanup release and an event hook that both fail do not replace the capture error. */
  it('keeps the capture error when the release and the event hook fail', async () => {
    const built = await setup()
    const failure = new Error('capture exploded')
    jest.spyOn(built.metering, 'capture').mockRejectedValueOnce(failure)
    jest.spyOn(built.metering, 'release').mockRejectedValueOnce(new Error('release exploded'))
    built.events.settleFailed.mockRejectedValueOnce(new Error('hook exploded'))
    expect(await meter(built, usable, ESTIMATE)).toBe(failure)
    expect(built.events.settleFailed).toHaveBeenCalledTimes(1)
  })

  /** A capture that throws after the row posted lost nothing, so nothing is announced. */
  it('announces nothing when the held row posted', async () => {
    const built = await setup()
    const capture = built.metering.capture.bind(built.metering)
    const failure = new Error('after posting')
    jest.spyOn(built.metering, 'capture').mockImplementationOnce(async (...args) => {
      await capture(...args)
      throw failure
    })
    expect(await meter(built, usable, ESTIMATE)).toBe(failure)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** A function that throws served nothing to settle, with or without a hold. */
  it.each([ESTIMATE, undefined])('announces nothing when the function throws (estimate %#)', async (estimate) => {
    const built = await setup()
    const boom = new Error('llm failed')
    expect(await meter(built, () => Promise.reject(boom), estimate)).toBe(boom)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** With no estimate there is no hold: the event carries the payer and the code. */
  it('announces unusable usage on the post-hoc path without a hold id', async () => {
    const built = await setup()
    const error = await meter(built, unusable)
    expect(error).toMatchObject({ response: { error: { code: 'AI_TOKENS_UNKNOWN_PROVIDER' } } })
    expect(built.events.settleFailed.mock.calls).toEqual(announced({ errorCode: 'AI_TOKENS_UNKNOWN_PROVIDER' }))
  })

  /** A ledger that refused the append wrote nothing: announced, with the code and no message text. */
  it('announces a refused append on the post-hoc path', async () => {
    const built = await setup()
    const failure = Object.assign(new Error(SECRET), { code: 'ECONNRESET' })
    jest.spyOn(built.ledger, 'append').mockRejectedValueOnce(failure)
    expect(await meter(built, usable)).toBe(failure)
    expect(built.events.settleFailed.mock.calls).toEqual(announced({ errorCode: 'ECONNRESET' }))
    expect(JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls)).not.toContain('hunter2')
  })

  /** An append that wrote the row before it threw leaves the usage in the ledger. */
  it('announces nothing when the post-hoc append wrote the row before it threw', async () => {
    const built = await setup()
    const append = built.ledger.append.bind(built.ledger)
    const failure = new Error('connection lost after commit')
    jest.spyOn(built.ledger, 'append').mockImplementationOnce(async (...args) => {
      await append(...args)
      throw failure
    })
    expect(await meter(built, usable)).toBe(failure)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** A leg that fails after the append leaves the usage in the ledger too. */
  it('announces nothing when a step after the post-hoc append throws', async () => {
    const built = await setup()
    const failure = new Error('hook exploded')
    built.events.usageRecorded.mockRejectedValueOnce(failure)
    expect(await meter(built, usable)).toBe(failure)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** A settled call announces nothing. */
  it.each([ESTIMATE, undefined])('announces nothing on success (estimate %#)', async (estimate) => {
    const built = await setup()
    await meter(built, usable, estimate)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** `record()` handed to a caller that passes more arguments, as `map` or `async.map` does, records and leaves each of them alone. */
  it.each<[string, (touched: string[]) => unknown]>([
    ['a number', () => 0],
    ['null', () => null],
    ['a callback', (touched) => () => touched.push('called')],
    [
      'a callback that throws',
      (touched) => () => {
        touched.push('called')
        throw new Error('host callback')
      },
    ],
    ['an object', (touched) => ({ get appended() { touched.push('read'); return false }, mark: () => touched.push('called') })],
    [
      'a proxy',
      (touched) =>
        new Proxy(
          {},
          {
            get: () => void touched.push('get'),
            has: () => touched.push('has') < 0,
            getPrototypeOf: () => {
              touched.push('prototype')
              return null
            },
          },
        ),
    ],
  ])('ignores a second argument of record() that is %s', async (_name, second) => {
    const built = await setup()
    const touched: string[] = []
    const record = built.metering.record.bind(built.metering) as (input: unknown, extra: unknown) => Promise<unknown>
    await expect(record({ usage: normalized(), context: CONTEXT }, second(touched))).resolves.toMatchObject({ status: 'posted' })
    expect(touched).toEqual([])
    expect(built.events.usageRecorded).toHaveBeenCalledTimes(1)
  })

  /** The line about an event that could not be delivered is the host logger's too, and `meter()` has nothing behind it to catch. */
  it('keeps the settle error when the sink rejects and the logger throws', async () => {
    const built = await setup()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('logger down')
    })
    built.events.settleFailed.mockRejectedValueOnce(new Error('bus down'))
    const failure = new Error('store down')
    jest.spyOn(built.ledger, 'append').mockRejectedValueOnce(failure)
    expect(await meter(built, usable)).toBe(failure)
    expect(built.events.settleFailed).toHaveBeenCalledTimes(1)
  })
})
