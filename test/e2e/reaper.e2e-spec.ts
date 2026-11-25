/**
 * @fileoverview E2E scenario 10 (spec §19.2, §8.3): a crashed hold (its TTL
 * elapsed) is swept EXACTLY ONCE across two racing reaper replicas; the wallet and
 * budget headroom are restored, and a `capture()` afterward is a 410. Exercises the
 * Redis live-counter release path. Against real PostgreSQL + Redis.
 * @layer test
 */

import type { AiTokensErrorResponse } from '@bymax-one/nest-ai-tokens/shared'
import type { AiTokensException, Hold, HoldEstimate, MeteringContext } from '@bymax-one/nest-ai-tokens'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { lastValueFrom, of } from 'rxjs'
import { Meter } from '../../src/server/enforcement/decorators'
import { MeteringInterceptor } from '../../src/server/enforcement/metering.interceptor'
import { HoldReaper } from '../../src/server/enforcement/hold-reaper'
import { E2E_WALLET, bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, startRedis, upsertBudget, type Booted, type PostgresFixture, type RedisFixture } from './harness'

const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }
const REAPER_OPTIONS = { holds: { ttlSeconds: 1, reaperIntervalSeconds: 3_600 } }

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class Controller {
  @Meter({ feature: 'chat.reply' })
  reply(): unknown {
    return { nothing: true }
  }
}

/** Run the interceptor over a held request whose handler returns no usage. */
function run(interceptor: MeteringInterceptor, context: MeteringContext, hold: Hold): Promise<unknown> {
  const request = { aiTokens: { status: [], context, hold } }
  const execution = { getHandler: () => Controller.prototype.reply, getClass: () => Controller, switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) } as unknown as ExecutionContext
  return lastValueFrom(interceptor.intercept(execution, { handle: () => of({ nothing: true }) }))
}

let pg: PostgresFixture
let redis: RedisFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  redis = await startRedis()
  app = await bootMeteringModule({ store: pg.store, counter: redis.counter, holdTtlSeconds: 1 })
  await seedPrice(app.pricing)
  await grantWallet(app.wallets, 100_000_000n)
  await upsertBudget(app.budgets, { limitCount: 10, limitNanoUsd: 100_000_000n })
}, 180_000)

afterAll(async () => {
  await app.close()
  await redis.stop()
  await pg.stop()
})

describe('E2E — hold reaper across replicas (§8.3)', () => {
  /** An expired hold is reclaimed once by two racing reapers; funds restored; capture → 410. */
  it('reclaims an expired hold exactly once and restores headroom', async () => {
    const hold = await app.metering.hold(e2eContext({ idempotencyKey: 'reap-1' }), ESTIMATE)
    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(93_750_000n)

    await sleep(1_300) // let the 1s TTL elapse

    const restoreSpy = jest.spyOn(app.metering, 'restoreReleasedHold')
    const one = new HoldReaper(app.ledger, app.metering, REAPER_OPTIONS)
    const two = new HoldReaper(app.ledger, app.metering, REAPER_OPTIONS)
    await Promise.all([one.sweep(), two.sweep()])
    expect(restoreSpy).toHaveBeenCalledTimes(1)

    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(100_000_000n)
    const status = (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]
    expect(status?.spent.count).toBe(0)

    const error = await app.metering.capture(hold, e2eContext(), e2eUsage()).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_HOLD_EXPIRED')
  })

  /**
   * A handler that succeeded and a settle that failed: the hold stays pending in PostgreSQL with its Redis reservation, a retry with
   * the same idempotency key gets that hold, and the reaper releases it with its own reason.
   */
  it('keeps a hold pending after a failed settle until the reaper releases it', async () => {
    const context = e2eContext({ idempotencyKey: 'settle-fail-1' })
    const before = (await app.wallets.getBalance(E2E_WALLET)).nanoUsd
    const hold = await app.metering.hold(context, ESTIMATE)
    const interceptor = new MeteringInterceptor(new Reflector(), app.metering, {})
    expect(codeOf(await run(interceptor, context, hold).catch((e: unknown) => e))).toBe('AI_TOKENS_USAGE_MALFORMED')

    const count = async (): Promise<number | undefined> => (await app.budgets.status('e2e', { type: 'user', id: 'u1' }))[0]?.spent.count
    expect((await app.ledger.findById(hold.id))?.status).toBe('pending')
    expect(await count()).toBe(1)
    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(before - 6_250_000n)
    expect((await app.metering.hold(context, ESTIMATE)).id).toBe(hold.id)
    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(before - 6_250_000n)

    await sleep(1_300)
    const restoreSpy = jest.spyOn(app.metering, 'restoreReleasedHold')
    await new HoldReaper(app.ledger, app.metering, REAPER_OPTIONS).sweep()
    expect(restoreSpy.mock.calls.map(([record, reason, expired]) => [record.id, reason, expired])).toEqual([[hold.id, 'expired', true]])
    expect((await app.wallets.getBalance(E2E_WALLET)).nanoUsd).toBe(before)
    expect(await count()).toBe(0)
  })
})
