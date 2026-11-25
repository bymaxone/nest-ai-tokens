/**
 * @fileoverview What reaches the caller, and what is announced, when a handler fails after emitting, when the caller stops
 * waiting during the settle, and when a host's logger or metering service misbehaves.
 * @layer server/enforcement
 */

import { Logger, ServiceUnavailableException } from '@nestjs/common'
import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Observable, concat, lastValueFrom, of, throwError } from 'rxjs'
import type { NormalizedUsage } from '../../shared'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { Hold, MeteringContext } from '../interfaces'
import { LedgerService, MarkupResolver, MeteringService, PricingService, WalletService } from '../services'
import type { MeteringEventHooks } from '../services'
import { MeteringEffects } from '../services/metering-effects'
import type { RequestAiTokens } from './budget.guard'
import { Meter } from './decorators'
import { MeteringInterceptor } from './metering.interceptor'

const WALLET = { tenantId: 'tenant-1', ownerType: 'user' as const, ownerId: 'u1' }
const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }
const ESTIMATE = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 } as const

/** A complete normalized usage (1000-in / 500-out gpt-5 chat). */
function normalized(): NormalizedUsage {
  return { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
}

class Fixture {
  @Meter({ feature: 'chat.reply' })
  metered(): unknown {
    return { usage: normalized() }
  }
}

const fixture = new Fixture()
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A funded metering stack over in-memory stores, with recording event hooks. */
async function setup(): Promise<{ metering: MeteringService; interceptor: MeteringInterceptor; ledger: LedgerService; events: Record<keyof MeteringEventHooks, jest.Mock>; statusOf: (hold: Hold) => Promise<string | undefined> }> {
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    settlement: { enabled: false },
    wallets: { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    budgets: { enabled: false },
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
  const wallets = new WalletService(new InMemoryWalletStore(), options.wallets as never)
  await wallets.grant(WALLET, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
  const metering = new MeteringService(ledger, new PricingService(options, pricingStore), new MarkupResolver(options), options, events, wallets)
  const interceptor = new MeteringInterceptor(new Reflector(), metering, {})
  const statusOf = async (hold: Hold): Promise<string | undefined> => (await ledger.findById(hold.id))?.status
  return { metering, interceptor, ledger, events, statusOf }
}

/** The interceptor's stream over a request with a context and, when given, a hold. */
function stream(interceptor: MeteringInterceptor, hold: Hold | undefined, handler: CallHandler, given: MeteringContext = CONTEXT): Observable<unknown> {
  const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [], context: given, ...(hold !== undefined ? { hold } : {}) } }
  const context = { getHandler: () => fixture.metered, getClass: () => Fixture, switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) } as unknown as ExecutionContext
  return interceptor.intercept(context, handler)
}

/** What the caller of the stream sees. */
const run = (interceptor: MeteringInterceptor, hold: Hold | undefined, handler: CallHandler, given?: MeteringContext): Promise<unknown> =>
  lastValueFrom(stream(interceptor, hold, handler, given)).catch((error: unknown) => error)

const returning = (value: unknown): CallHandler => ({ handle: () => of(value) })
const down = new ServiceUnavailableException('provider down')

/** The payloads of the settle failures announced. */
const payloads = (events: { settleFailed: jest.Mock }): unknown[] => events.settleFailed.mock.calls.map((call: unknown[]) => call[2])

describe('MeteringInterceptor settle outcomes', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

  /** The handler's own error reaches the caller, and the release it causes is no settle failure. */
  it.each<[string, CallHandler]>([
    ['at once', { handle: () => concat(of({ usage: normalized() }), throwError(() => down)) }],
    [
      'while the capture is in flight',
      {
        handle: () =>
          new Observable((subscriber) => {
            subscriber.next({ usage: normalized() })
            setTimeout(() => subscriber.error(down), 5)
          }),
      },
    ],
  ])('passes on a handler error raised %s after a value', async (_name, handler) => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    const transition = built.ledger.transition.bind(built.ledger)
    jest.spyOn(built.ledger, 'transition').mockImplementation(async (...args) => {
      if (args[2] === 'posted') await pause(20)
      return transition(...args)
    })
    // The release is still being announced when the capture that lost to it fails.
    built.events.holdReleased.mockImplementationOnce(() => pause(60))
    expect(await run(built.interceptor, hold, handler)).toBe(down)
    await pause(100)
    expect(await built.statusOf(hold)).toBe('released')
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** A caller that stops waiting (a timeout, an aborted stream) does not take the announcement with it. */
  it.each([true, false])('announces a settle that fails after the caller stopped waiting (hold: %s)', async (held) => {
    const built = await setup()
    const hold = held ? await built.metering.hold(CONTEXT, ESTIMATE) : undefined
    const fail = async (): Promise<never> => {
      await pause(20)
      throw new Error('store down')
    }
    if (held) jest.spyOn(built.ledger, 'transition').mockImplementationOnce(fail)
    else jest.spyOn(built.ledger, 'append').mockImplementationOnce(fail)
    const subscription = stream(built.interceptor, hold, returning({ usage: normalized() })).subscribe({ error: () => undefined })
    await pause(5)
    subscription.unsubscribe()
    await pause(40)
    expect(built.events.settleFailed).toHaveBeenCalledTimes(1)
  })

  /** A host logger that throws replaces neither the settle error nor the event, nor does a failing hook behind it. */
  it.each([false, true])('keeps the settle error when the logger throws (hook fails: %s)', async (hookFails) => {
    const built = await setup()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('logger down')
    })
    if (hookFails) built.events.settleFailed.mockRejectedValueOnce(new Error('bus down'))
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    const failure = new Error('store down')
    jest.spyOn(built.ledger, 'transition').mockRejectedValueOnce(failure)
    expect(await run(built.interceptor, hold, returning({ usage: normalized() }))).toBe(failure)
    expect(built.events.settleFailed).toHaveBeenCalledTimes(1)
  })

  /** The reservation of an unsettled hold is given back with what the event carries. */
  it('releases an unsettled hold by the holdId, tenant and scope of the event', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    jest.spyOn(built.ledger, 'transition').mockRejectedValueOnce(new Error('store down'))
    await run(built.interceptor, hold, returning({ usage: normalized() }))
    const [tenantId, scope, data] = built.events.settleFailed.mock.calls[0] as [string, MeteringContext['scope'], { holdId: string }]
    await built.metering.release({ id: data.holdId } as Hold, { tenantId, scope }, 'reconciled')
    expect(await built.statusOf(hold)).toBe('released')
  })

  /** A substitute service that has no announcement leaves the settle error as it is. */
  it.each([true, false])('keeps the settle error with a service that cannot announce (hold: %s)', async (held) => {
    const failure = new Error('store down')
    const fail = (): Promise<never> => Promise.reject(failure)
    const interceptor = new MeteringInterceptor(new Reflector(), { capture: fail, record: fail } as unknown as MeteringService, {})
    const hold: Hold | undefined = held ? { id: 'h1', tenantId: 'tenant-1', scope: CONTEXT.scope, estimatedTokens: 1, estimatedCostNanoUsd: 1n, expiresAt: new Date() } : undefined
    expect(await run(interceptor, hold, returning({ usage: normalized() }))).toBe(failure)
  })

  /** A correlation id travels only when it is text of a bounded length that any column can hold. */
  it.each<[string, string, boolean]>([
    ['of 256 characters', 'c'.repeat(256), true],
    ['of 257 characters', 'c'.repeat(257), false],
    ['with a NUL character', 'a\u0000b', false],
  ])('bounds a correlation id %s', async (_name, correlationId, carried) => {
    const built = await setup()
    await run(built.interceptor, undefined, returning({ nothing: true }), { ...CONTEXT, correlationId })
    expect(payloads(built.events)).toEqual([{ errorCode: 'AI_TOKENS_USAGE_MALFORMED', where: 'interceptor', ...(carried ? { correlationId } : {}) }])
  })

  /** A step that fails after the row of a keyed call posted leaves nothing to reconcile. */
  it('announces nothing for a keyed call whose row posted', async () => {
    const built = await setup()
    const failure = new Error('hook exploded')
    built.events.usageRecorded.mockRejectedValueOnce(failure)
    expect(await run(built.interceptor, undefined, returning({ usage: normalized() }), { ...CONTEXT, idempotencyKey: 'k1' })).toBe(failure)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** The row is known to be written before the budget is committed. */
  it('announces nothing when committing the budget fails after the row posted', async () => {
    const built = await setup()
    const failure = new Error('counter down')
    jest.spyOn(MeteringEffects.prototype, 'commitBudget').mockRejectedValueOnce(failure)
    expect(await run(built.interceptor, undefined, returning({ usage: normalized() }))).toBe(failure)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** The announcement is delivered before the caller sees the error. */
  it.each([true, false])('announces before the error reaches the caller (hold: %s)', async (held) => {
    const built = await setup()
    const hold = held ? await built.metering.hold(CONTEXT, ESTIMATE) : undefined
    let delivered = false
    built.events.settleFailed.mockImplementationOnce(async () => {
      await pause(20)
      delivered = true
    })
    await run(built.interceptor, hold, returning({ nothing: true }))
    expect(delivered).toBe(true)
  })
})
