/**
 * @fileoverview What counts as a date a caller may supply. A valid `Date` from another realm (a `vm` context, an iframe) or a
 * subclass of `Date`, which a clock-shifting test double is, is a date, so the test reads the internal slot, not the prototype
 * chain. A value that only looks like one is not: a subclass whose `getTime` throws, or a Proxy of a `Date`, which would fail later with
 * the host's own error. A date outside the years 1 to 9999 is refused by name, because a store cannot hold it and would fail
 * with an error that does not say which input it was.
 * @layer server
 */

import { runInNewContext } from 'node:vm'
import { TENANT, USER_SCOPE, budgetInput, makeService } from '../test/fakes/budget-fixtures'
import { AiTokensException } from './server/errors'

/** The first and the last instant of the supported range, in milliseconds since the epoch. */
const FIRST_MS = -62_135_596_800_000
const LAST_MS = 253_402_300_799_999

/** A `Date` whose `getTime` throws the host's own text, which a caller's subclass can be. */
class ThrowingDate extends Date {
  override getTime(): number {
    throw new Error('host-private-getTime-text')
  }
}

/** A `Date` from a `vm` context: a valid date that is not an instance of this realm's `Date`. */
const crossRealm = (iso: string): Date => runInNewContext(`new Date('${iso}')`) as Date

/** The code of the refusal `run` raises, or `undefined` when it is accepted. */
async function outcome(run: () => Promise<unknown>): Promise<{ code: string; reason: string } | undefined> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    const { error: body } = error.getResponse() as { error: { code: string; details?: { reason?: string } } }
    return { code: body.code, reason: body.details?.reason ?? '' }
  }
  return undefined
}

/** Upsert a budget whose `anchorAt` is `value`, which is the call every case below makes. */
const anchoredAt = (value: unknown): Promise<unknown> => makeService().service.upsertBudget(budgetInput({ anchorAt: value as Date }))

describe('a date from another realm or a subclass of Date', () => {
  it('is accepted as a date', async () => {
    expect(await outcome(() => anchoredAt(crossRealm('2026-01-01T00:00:00Z')))).toBeUndefined()
    expect(await outcome(() => anchoredAt(new (class extends Date {})('2026-01-01T00:00:00Z')))).toBeUndefined()
  })

  it('is refused when it is not valid, as an ordinary Invalid Date is', async () => {
    expect(await outcome(() => anchoredAt(crossRealm('not a date')))).toEqual({ code: 'AI_TOKENS_INVALID_CONFIG', reason: 'anchorAt must be a valid date' })
  })

  it('is refused when its getTime throws, without the text it throws', async () => {
    const refusal = await outcome(() => anchoredAt(new ThrowingDate(0)))
    expect(refusal).toEqual({ code: 'AI_TOKENS_INVALID_CONFIG', reason: 'anchorAt must be a valid date' })
  })

  it('is refused when it is a Proxy of a Date, which is not a date', async () => {
    expect(await outcome(() => anchoredAt(new Proxy(new Date(0), {})))).toEqual({ code: 'AI_TOKENS_INVALID_CONFIG', reason: 'anchorAt must be a valid date' })
  })
})

describe('a date at the edge of what a store can hold', () => {
  it.each([FIRST_MS, 0, LAST_MS])('accepts the instant %p', async (ms) => {
    expect(await outcome(() => anchoredAt(new Date(ms)))).toBeUndefined()
  })

  it.each([FIRST_MS - 1, LAST_MS + 1, -8.64e15, 8.64e15])('refuses the instant %p by name, as invalid configuration', async (ms) => {
    expect(await outcome(() => anchoredAt(new Date(ms)))).toEqual({ code: 'AI_TOKENS_INVALID_CONFIG', reason: 'anchorAt must be a date from the year 1 to the year 9999' })
  })

  it('refuses it at a budget movement, naming `at`, and moves nothing', async () => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    const call = { tenantId: TENANT, scope: USER_SCOPE, feature: 'f' }
    expect(await outcome(() => service.consume(call, { nanoUsd: 10n, tokens: 0, count: 0 }, new Date(LAST_MS + 1)))).toEqual({
      code: 'AI_TOKENS_INVALID_CONFIG',
      reason: 'at must be a date from the year 1 to the year 9999',
    })
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.spent.nanoUsd).toBe(0n)
  })
})
