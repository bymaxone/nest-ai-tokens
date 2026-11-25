/**
 * @fileoverview The interceptor when the handler returned and its hold could not be settled: the hold stays pending for the reaper
 * and the failure is announced.
 * @layer server/enforcement
 */

import { Logger } from '@nestjs/common'
import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { lastValueFrom, of, throwError } from 'rxjs'
import type { NormalizedUsage } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import type { Hold, MeteringContext } from '../interfaces'
import { BudgetService, LedgerService, MarkupResolver, MeteringService, PricingService, WalletService } from '../services'
import type { MeteringEventHooks } from '../services'
import type { RequestAiTokens } from './budget.guard'
import { Meter } from './decorators'
import { HoldReaper } from './hold-reaper'
import { MeteringInterceptor } from './metering.interceptor'

const SECRET = 'postgres://user:hunter2@db/prod'
const WALLET = { tenantId: 'tenant-1', ownerType: 'user' as const, ownerId: 'u1' }
const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }
const ESTIMATE = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 } as const
const FUNDED = 100_000_000n

/** A complete normalized usage (1000-in / 500-out gpt-5 chat). */
function normalized(): NormalizedUsage {
  return { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
}

class Fixture {
  @Meter({ feature: 'chat.reply' })
  metered(): unknown {
    return { usage: normalized() }
  }

  @Meter({ feature: 'chat.reply', exposeHeaders: true })
  withHeaders(): unknown {
    return { usage: normalized() }
  }
}

const fixture = new Fixture()

/** What a row works with. */
interface Stack {
  metering: MeteringService
  interceptor: MeteringInterceptor
  ledger: LedgerService
  events: { [K in keyof MeteringEventHooks]: jest.Mock }
  reaper: HoldReaper
  balance: () => Promise<bigint>
  statusOf: (hold: Hold) => Promise<string | undefined>
  expire: () => void
}

/** A funded metering stack over in-memory stores, with recording event hooks and a movable clock for the reaper. */
async function setup(): Promise<Stack> {
  let offsetMs = 0
  const now = (): Date => new Date(Date.now() + offsetMs)
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
  const interceptor = new MeteringInterceptor(new Reflector(), metering, {})
  const reaper = new HoldReaper(ledger, metering, options, now)
  const balance = async (): Promise<bigint> => (await wallets.getBalance(WALLET)).nanoUsd
  const statusOf = async (hold: Hold): Promise<string | undefined> => (await ledger.findById(hold.id))?.status
  const expire = (): void => {
    offsetMs = 3_601_000
  }
  return { metering, interceptor, ledger, events, reaper, balance, statusOf, expire }
}

/** Run the interceptor over a held request and return what the caller sees. */
async function run(interceptor: MeteringInterceptor, hold: Hold | undefined, handler: CallHandler, target: () => unknown = fixture.metered, response: unknown = {}, given: MeteringContext = CONTEXT): Promise<unknown> {
  const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [], context: given, ...(hold !== undefined ? { hold } : {}) } }
  const context = { getHandler: () => target, getClass: () => Fixture, switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ExecutionContext
  return lastValueFrom(interceptor.intercept(context, handler)).catch((error: unknown) => error)
}

const returning = (value: unknown): CallHandler => ({ handle: () => of(value) })
const throwing = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) })

describe('MeteringInterceptor when settling fails after the handler returned', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

  /** A handler error is not a settle failure: same release, same error instance, no settle.failed. */
  it('releases on a handler error and announces no settle failure', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    const boom = new Error('handler exploded')
    expect(await run(built.interceptor, hold, throwing(boom))).toBe(boom)
    expect(built.events.holdReleased).toHaveBeenCalledWith(expect.anything(), 'handler threw', false)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
    expect(await built.balance()).toBe(FUNDED)
  })

  /** Unusable usage leaves the hold pending and reserved, and says so with the hold id and the error code. */
  it('keeps the hold pending on malformed usage and announces it', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    const reserved = await built.balance()
    const error = await run(built.interceptor, hold, returning({ nothing: true }))
    expect(error).toBeInstanceOf(AiTokensException)
    expect(await built.statusOf(hold)).toBe('pending')
    expect(await built.balance()).toBe(reserved)
    expect(built.events.holdReleased).not.toHaveBeenCalled()
    expect(built.events.settleFailed.mock.calls).toEqual([['tenant-1', CONTEXT.scope, { holdId: hold.id, errorCode: 'AI_TOKENS_USAGE_MALFORMED', where: 'interceptor' }]])
  })

  /** A store failure is treated the same, propagates as the same instance, and no message text reaches the event or the log. */
  it('keeps the hold pending on a store error and carries its code only', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    const failure = Object.assign(new Error(SECRET), { code: 'ECONNRESET' })
    jest.spyOn(built.ledger, 'transition').mockRejectedValueOnce(failure)
    expect(await run(built.interceptor, hold, returning({ usage: normalized() }))).toBe(failure)
    expect(await built.statusOf(hold)).toBe('pending')
    expect(built.events.holdReleased).not.toHaveBeenCalled()
    expect(built.events.settleFailed.mock.calls).toEqual([['tenant-1', CONTEXT.scope, { holdId: hold.id, errorCode: 'ECONNRESET', where: 'interceptor' }]])
    expect(JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls)).not.toContain(SECRET)
  })

  /** An error with no code-shaped code is announced without one. */
  it('omits the error code when the failure has none of the shape of one', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    jest.spyOn(built.ledger, 'transition').mockRejectedValueOnce(Object.assign(new Error('x'), { code: SECRET }))
    await run(built.interceptor, hold, returning({ usage: normalized() }))
    expect(built.events.settleFailed.mock.calls).toEqual([['tenant-1', CONTEXT.scope, { holdId: hold.id, where: 'interceptor' }]])
  })

  /** When the row cannot be read back either, the failure is still announced. */
  it('announces the failure when the hold cannot be read back', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    jest.spyOn(built.ledger, 'findById').mockRejectedValue(new Error('down'))
    await run(built.interceptor, hold, returning({ usage: normalized() }))
    expect(built.events.settleFailed).toHaveBeenCalledTimes(1)
  })

  /** A row that did post has nothing to reconcile: a failure after the posting announces nothing. */
  it('announces nothing when the row posted before the failure', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    const boom = new Error('header write failed')
    const response = {
      setHeader: (): never => {
        throw boom
      },
    }
    expect(await run(built.interceptor, hold, returning({ usage: normalized() }), fixture.withHeaders, response)).toBe(boom)
    expect(await built.statusOf(hold)).toBe('posted')
    expect(built.events.settleFailed).not.toHaveBeenCalled()
    expect(built.events.holdReleased).not.toHaveBeenCalled()
  })

  /** A hook that fails must not replace the settle error. */
  it('propagates the settle error when announcing it fails', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    const failure = new Error('store down')
    jest.spyOn(built.ledger, 'transition').mockRejectedValueOnce(failure)
    built.events.settleFailed.mockRejectedValueOnce(new Error('bus down'))
    expect(await run(built.interceptor, hold, returning({ usage: normalized() }))).toBe(failure)
  })

  /** Without a hold the served usage is announced all the same, with no hold id; the error is the handler's caller's as before. */
  it.each<[string, unknown, string]>([
    ['usable usage is missing', { nothing: true }, 'AI_TOKENS_USAGE_MALFORMED'],
    ['the usage cannot be normalized', { usage: { not: 'usable' } }, 'AI_TOKENS_UNKNOWN_PROVIDER'],
  ])('announces a failed record() with no hold when %s', async (_name, result, errorCode) => {
    const built = await setup()
    expect(await run(built.interceptor, undefined, returning(result))).toMatchObject({ response: { error: { code: errorCode } } })
    expect(built.events.settleFailed.mock.calls).toEqual([['tenant-1', CONTEXT.scope, { errorCode, where: 'interceptor' }]])
  })

  /** A context that names no payer cannot be announced for anyone: it is only logged, and the refusal reaches the caller. */
  it.each<[string, Record<string, unknown>]>([
    ['no tenant', { scope: CONTEXT.scope, feature: 'chat.reply' }],
    ['no scope', { tenantId: 'tenant-1', feature: 'chat.reply' }],
  ])('emits no event for a context with %s', async (_name, context) => {
    const built = await setup()
    const error = await run(built.interceptor, undefined, returning({ usage: normalized() }), fixture.metered, {}, context as unknown as MeteringContext)
    expect(error).toMatchObject({ response: { error: { code: 'AI_TOKENS_INVALID_CONFIG' } } })
    expect(built.events.settleFailed).not.toHaveBeenCalled()
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('was not settled'))
  })

  /** A ledger that wrote the row before it threw leaves the usage recorded, so nothing is announced. */
  it('announces nothing with no hold when the row was written', async () => {
    const built = await setup()
    const append = built.ledger.append.bind(built.ledger)
    const failure = new Error('connection lost after commit')
    jest.spyOn(built.ledger, 'append').mockImplementationOnce(async (...args) => {
      await append(...args)
      throw failure
    })
    expect(await run(built.interceptor, undefined, returning({ usage: normalized() }))).toBe(failure)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** A header that cannot be set fails after the row posted: nothing to reconcile. */
  it('announces nothing with no hold when setting a header fails', async () => {
    const built = await setup()
    const failure = new Error('headers already sent')
    const response = { setHeader: (): never => { throw failure } }
    expect(await run(built.interceptor, undefined, returning({ usage: normalized() }), fixture.withHeaders, response)).toBe(failure)
    expect(built.events.settleFailed).not.toHaveBeenCalled()
  })

  /** The context's own correlation id travels with the event, with a hold or without; one planted on Object.prototype does not. */
  it.each([true, false])('carries the correlation id of the context (hold: %s)', async (held) => {
    const built = await setup()
    const context = { ...CONTEXT, correlationId: 'req-7' }
    const hold = held ? await built.metering.hold(context, ESTIMATE) : undefined
    await run(built.interceptor, hold, returning({ nothing: true }), fixture.metered, {}, context)
    expect((built.events.settleFailed.mock.calls[0] as unknown[])[2]).toMatchObject({ correlationId: 'req-7' })
  })

  /** The payload declares a string: a numeric id, which `record()` refuses, is left out of the event it caused. */
  it('takes no correlation id that is not a string', async () => {
    const built = await setup()
    const context = { ...CONTEXT, correlationId: 7 } as unknown as MeteringContext
    await run(built.interceptor, undefined, returning({ usage: normalized() }), fixture.metered, {}, context)
    expect(built.events.settleFailed.mock.calls).toEqual([['tenant-1', CONTEXT.scope, { errorCode: 'AI_TOKENS_INVALID_CONFIG', where: 'interceptor' }]])
  })

  it('takes no correlation id from Object.prototype', async () => {
    const built = await setup()
    Object.defineProperty(Object.prototype, 'correlationId', { value: 'planted', configurable: true, writable: true, enumerable: false })
    try {
      await run(built.interceptor, undefined, returning({ nothing: true }))
    } finally {
      Reflect.deleteProperty(Object.prototype, 'correlationId')
    }
    expect((built.events.settleFailed.mock.calls[0] as unknown[])[2]).toEqual({ errorCode: 'AI_TOKENS_USAGE_MALFORMED', where: 'interceptor' })
  })

  /** A thrown value that is no Error, and an error whose code cannot be read, are announced without a code. */
  it.each<[string, unknown]>([
    ['a string', 'ECONNRESET'],
    ['an error whose code getter throws', Object.defineProperty(new Error('x'), 'code', { get: (): never => { throw new Error('unreadable') } })],
  ])('announces %s without an error code', async (_name, thrown) => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    jest.spyOn(built.ledger, 'transition').mockRejectedValueOnce(thrown)
    expect(await run(built.interceptor, hold, returning({ usage: normalized() }))).toBe(thrown)
    expect(built.events.settleFailed.mock.calls).toEqual([['tenant-1', CONTEXT.scope, { holdId: hold.id, where: 'interceptor' }]])
  })

  /** A service wired without event hooks takes the same path and rejects nothing. */
  it('reports a settle failure with no event hooks wired', async () => {
    const options = { ratingMode: 'rate-table', ledger: { hashChain: false }, pricing: { strict: false, cacheTtlMs: 0, modelAliases: {} } } as unknown as ResolvedAiTokensOptions
    const ledger = new LedgerService(new InMemoryLedgerStore(), options)
    const metering = new MeteringService(ledger, new PricingService(options, new InMemoryPricingStore()), new MarkupResolver({ ...options, markup: 1 }), options)
    const hold: Hold = { id: 'absent', tenantId: 'tenant-1', scope: CONTEXT.scope, estimatedTokens: 1, estimatedCostNanoUsd: 1n, expiresAt: new Date() }
    await expect(metering.reportSettleFailure(hold, CONTEXT, new Error('x'))).resolves.toBeUndefined()
  })

  /** The reaper takes the pending hold after its TTL, with its own reason, and the reservation returns. */
  it('lets the reaper release the pending hold after the TTL', async () => {
    const built = await setup()
    const hold = await built.metering.hold(CONTEXT, ESTIMATE)
    await run(built.interceptor, hold, returning({ nothing: true }))
    built.expire()
    await built.reaper.sweep()
    expect(await built.statusOf(hold)).toBe('released')
    expect(built.events.holdReleased).toHaveBeenCalledWith(expect.anything(), 'expired', true)
    expect(await built.balance()).toBe(FUNDED)
  })

  /** A client retry with the same idempotency key gets the same pending hold and is charged once. */
  it('charges a retry with the same idempotency key once', async () => {
    const built = await setup()
    const keyed: MeteringContext = { ...CONTEXT, idempotencyKey: 'req-1' }
    const first = await built.metering.hold(keyed, ESTIMATE)
    jest.spyOn(built.ledger, 'transition').mockRejectedValueOnce(new Error('store down'))
    await run(built.interceptor, first, returning({ usage: normalized() }))
    const retried = await built.metering.hold(keyed, ESTIMATE)
    expect(retried.id).toBe(first.id)
    await run(built.interceptor, retried, returning({ usage: normalized() }))
    const posted = await built.ledger.findById(first.id)
    expect(posted?.status).toBe('posted')
    expect(await built.balance()).toBe(FUNDED - (posted?.billedCostNanoUsd ?? 0n))
    const after = await built.balance()
    await run(built.interceptor, retried, returning({ usage: normalized() }))
    expect(await built.balance()).toBe(after)
  })
})
