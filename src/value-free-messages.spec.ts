/**
 * @fileoverview The message of a refused option or input names what was refused and the bound it broke, and never repeats the
 * value it was given. A string or an object a host read from the environment can carry a credential or a private address, and the
 * reason of an error is serialised into an HTTP body and into logs. Each case sends a marker string through one input and asserts
 * the marker is absent from the error, together with the word that introduced an echo.
 * @layer server
 */

import { applyMarkup, floatUsdToNanoUsd, formatNanoUsd } from './shared'
import { TENANT, makeService } from '../test/fakes/budget-fixtures'
import { makeFullStore } from '../test/fakes/full-store'
import { validateOptions } from './server/config'
import { AiTokensException } from './server/errors'

/** A string no valid value contains, to show a refusal never repeats what it was given. */
const MARKER = 'private-host-10.0.0.5-s3cr3t'

/** The exception `run` throws; fails when it does not throw. */
function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

/**
 * Assert the options are refused with the typed error, and that the reason carries neither the marker nor the word `received`;
 * when `reason` is given, the reason is exactly it, which is how a number supplied by the test is shown not to be in it.
 */
function expectValueFree(options: object, reason?: string): void {
  const error = thrownBy(() => validateOptions({ store: makeFullStore(), ...options }))
  expect(error).toBeInstanceOf(AiTokensException)
  const body = JSON.stringify((error as AiTokensException).getResponse())
  expect(body).toContain('AI_TOKENS_INVALID_CONFIG')
  expect(body).not.toContain(MARKER)
  expect(body).not.toMatch(/received/i)
  if (reason !== undefined) expect(body).toContain(`"reason":"${reason}"`)
}

describe('the message of a refused option', () => {
  it.each([
    ['holds.ttlSeconds', { holds: { ttlSeconds: MARKER } }],
    ['holds.reaperIntervalSeconds', { holds: { reaperIntervalSeconds: MARKER } }],
    ['settlement.graceSeconds', { settlement: { graceSeconds: MARKER } }],
    ['settlement.retentionSeconds', { settlement: { retentionSeconds: MARKER } }],
    ['settlement.enabled', { settlement: { enabled: MARKER } }],
    ['content.ttlSeconds', { content: { store: {}, ttlSeconds: MARKER } }],
    ['reporting.maxExportRows', { reporting: { maxExportRows: MARKER } }],
    ['pricing.cacheTtlMs', { pricing: { cacheTtlMs: MARKER } }],
  ])('keeps the value of %s out of the reason', (_name, options) => {
    expectValueFree(options)
  })

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])('keeps a numeric markup of %p out of the reason', (markup) => {
    expectValueFree({ markup }, 'markup must be a finite number greater than 0')
  })

  /** The relation between the retention and the grace or the hold TTL names the three options and none of their values. */
  it('keeps the numbers of a retention that does not exceed the grace out of the reason', () => {
    const reason = 'settlement.retentionSeconds must exceed settlement.graceSeconds and holds.ttlSeconds'
    expectValueFree({ settlement: { retentionSeconds: 100, graceSeconds: 300 } }, reason)
    expectValueFree({ settlement: { retentionSeconds: 100 }, holds: { ttlSeconds: 4_000 } }, reason)
  })

  it.each([0, 1.5, -3])('keeps a numeric bound violation of %p out of the reason', (value) => {
    expectValueFree({ holds: { ttlSeconds: value } }, 'holds.ttlSeconds must be an integer from 1 to 2147483647')
    expectValueFree({ pricing: { cacheTtlMs: value } }, 'pricing.cacheTtlMs must be a positive integer number of milliseconds')
  })
})

describe('the message of a refused pricing input', () => {
  it('keeps the value out of the RangeError of a cost conversion, a format and a markup', () => {
    for (const run of [() => floatUsdToNanoUsd(MARKER as never), () => formatNanoUsd(1n, { decimals: MARKER as never }), () => applyMarkup(1n, MARKER as never)]) {
      const error = thrownBy(run)
      expect(error).toBeInstanceOf(RangeError)
      expect((error as RangeError).message).not.toContain(MARKER)
      expect((error as RangeError).message).not.toMatch(/received/i)
    }
  })
})

describe('the message of a refused budget id', () => {
  /** An id the caller passed is an input like any other: the reason says the budget does not exist and does not repeat the id. */
  it('keeps the id of an unknown budget out of the reason', async () => {
    const { service } = makeService()
    const error = await service.rotateWindow(MARKER, TENANT).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiTokensException)
    const body = JSON.stringify((error as AiTokensException).getResponse())
    expect(body).toContain('AI_TOKENS_INVALID_CONFIG')
    expect(body).not.toContain(MARKER)
  })
})

