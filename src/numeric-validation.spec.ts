/**
 * @fileoverview Every numeric option and amount the library takes refuses NaN, Infinity, a negative, a fraction and a string where a
 * whole non-negative number or a bigint is required, with the typed invalid-configuration error that names the field and echoes no
 * value. A comparison written as `value < 0` lets NaN through, so each boundary is driven with the whole table of bad values.
 * @layer server
 */

import { TENANT, USER_SCOPE, budgetInput, makeService } from '../test/fakes/budget-fixtures'
import { makeFullStore } from '../test/fakes/full-store'
import { InMemoryLedgerStore } from '../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../test/fakes/in-memory-wallet-store'
import { validateOptions, applyDefaults } from './server/config'
import { AiTokensException } from './server/errors'
import { LedgerService } from './server/services/ledger.service'
import { MarkupResolver } from './server/services/markup.resolver'
import { MeteringService } from './server/services/metering.service'
import { PricingService } from './server/services/pricing.service'
import { WalletService } from './server/services/wallet.service'

/** A marker no valid value contains, to show the response never echoes the value it refused. */
const MARKER = '9876543'

const BAD_NUMBERS: readonly unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, MARKER, null]
const BAD_BIGINTS: readonly unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 3, MARKER, null, -1n]
/** The bad values of an option: `null` is not one, because an option set to `null` takes its default as an option left out does. */
const BAD_OPTION_BIGINTS: readonly unknown[] = BAD_BIGINTS.filter((value) => value !== null)

/** The exception `run` rejects with; fails when it neither throws nor rejects. */
async function refusal(run: () => unknown): Promise<AiTokensException> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AiTokensException) return error
    throw error
  }
  throw new Error('expected the call to be refused')
}

/** Assert the refusal is the typed invalid-configuration error naming `field` and carrying none of the value. */
async function expectRefused(run: () => unknown, field: string): Promise<void> {
  const error = await refusal(run)
  const body = JSON.stringify(error.getResponse())
  expect(body).toContain('AI_TOKENS_INVALID_CONFIG')
  // The field is named in the reason of the error, not merely somewhere in the body.
  expect(body).toMatch(new RegExp(`"reason":"[^"]*${field}`))
  expect(body).not.toContain(MARKER)
}

const withStore = { store: makeFullStore() } as never

describe('module options that hold money or limits', () => {
  it.each(BAD_OPTION_BIGINTS)('refuses wallets.creditRateNanoUsd %p', async (value) => {
    await expectRefused(() => validateOptions({ ...(withStore as object), wallets: { creditRateNanoUsd: value } } as never), 'wallets.creditRateNanoUsd')
  })

  it.each([...BAD_OPTION_BIGINTS, 0n])('refuses wallets.creditRateNanoUsd of the rate %p when it is not above zero', async (value) => {
    await expectRefused(() => validateOptions({ ...(withStore as object), wallets: { creditRateNanoUsd: value } } as never), 'wallets.creditRateNanoUsd')
  })

  it.each(BAD_OPTION_BIGINTS)('refuses wallets.overdraftNanoUsd %p', async (value) => {
    await expectRefused(() => validateOptions({ ...(withStore as object), wallets: { overdraftNanoUsd: value } } as never), 'wallets.overdraftNanoUsd')
  })

  /** An option set to `null` is absent, as one left out is: it takes its default and is neither refused nor switched off. */
  it('takes a null rate and a null overdraft as the defaults', () => {
    const options = { ...(withStore as object), wallets: { overdraftNanoUsd: null, creditRateNanoUsd: null } } as never
    expect(() => validateOptions(options)).not.toThrow()
    expect(applyDefaults(options).wallets).toMatchObject({ enabled: true, overdraftNanoUsd: 0n })
  })

  /** Zero overdraft and a positive bigint rate are the valid values and are accepted. */
  it('accepts a zero overdraft and a positive bigint rate', () => {
    expect(() => validateOptions({ ...(withStore as object), wallets: { overdraftNanoUsd: 0n, creditRateNanoUsd: 1n } } as never)).not.toThrow()
  })
})

describe('budget limits', () => {
  const FIELDS: readonly { field: 'limitNanoUsd' | 'limitTokens' | 'limitCount'; bad: readonly unknown[] }[] = [
    { field: 'limitNanoUsd', bad: BAD_BIGINTS },
    { field: 'limitTokens', bad: BAD_NUMBERS },
    { field: 'limitCount', bad: BAD_NUMBERS },
  ]
  for (const { field, bad } of FIELDS) {
    it.each(bad)(`refuses ${field} %p`, async (value) => {
      const { service } = makeService()
      await expectRefused(() => service.upsertBudget(budgetInput({ limitNanoUsd: undefined, [field]: value })), field)
    })
  }

  /** Zero is a hard block and is accepted in each dimension. */
  it('accepts zero in each dimension', async () => {
    const { service } = makeService()
    await expect(service.upsertBudget(budgetInput({ limitNanoUsd: 0n, limitTokens: 0, limitCount: 0 }))).resolves.toBeDefined()
  })
})

describe('wallet amounts', () => {
  const REF = { tenantId: 't', ownerType: 'user', ownerId: 'u' } as const
  const wallets = (): WalletService => new WalletService(new InMemoryWalletStore(), { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' })
  const AMOUNTS: readonly unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 3, MARKER, null, 0n, -5n]

  it.each(AMOUNTS)('refuses a grant of %p', async (value) => {
    await expectRefused(() => wallets().grant(REF, { amountNanoUsd: value, idempotencyKey: 'k', reason: 'r' } as never), 'grant')
  })
  it.each(AMOUNTS)('refuses a debit of %p', async (value) => {
    await expectRefused(() => wallets().debit(REF, { amountNanoUsd: value, idempotencyKey: 'k', reason: 'r' } as never), 'debit')
  })
  it.each(AMOUNTS)('refuses a refund of %p', async (value) => {
    await expectRefused(() => wallets().refund(REF, { amountNanoUsd: value, idempotencyKey: 'k', reason: 'r' } as never), 'refund')
  })
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 3, MARKER, null, 0n])('refuses an adjustment of %p', async (value) => {
    await expectRefused(() => wallets().adjust(REF, { amountNanoUsd: value, idempotencyKey: 'k', reason: 'r' } as never), 'adjustment')
  })
})

describe('hold estimates', () => {
  async function metering(): Promise<MeteringService> {
    const options = applyDefaults({ store: makeFullStore(), markup: 1, pricing: { seedFromSnapshot: false, strict: true } })
    const pricing = new InMemoryPricingStore()
    await pricing.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
    return new MeteringService(new LedgerService(new InMemoryLedgerStore(), options), new PricingService(options, pricing), new MarkupResolver(options), options)
  }
  const call = { tenantId: TENANT, scope: USER_SCOPE, feature: 'f' }
  const rated = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 } as const

  it.each(BAD_NUMBERS)('refuses inputTokens %p', async (value) => {
    await expectRefused(async () => (await metering()).hold(call, { ...rated, inputTokens: value } as never), 'inputTokens')
  })
  it.each(BAD_NUMBERS)('refuses maxOutputTokens %p', async (value) => {
    await expectRefused(async () => (await metering()).hold(call, { ...rated, maxOutputTokens: value } as never), 'maxOutputTokens')
  })
  it.each(BAD_NUMBERS)('refuses a tokens estimate of %p', async (value) => {
    await expectRefused(async () => (await metering()).hold({ ...call, preset: { provider: 'openai' } } as never, { tokens: value } as never), 'tokens')
  })
  it.each([Number.NaN, 1.5, 3, MARKER, null, -1n])('refuses an amountNanoUsd estimate of %p', async (value) => {
    await expectRefused(async () => (await metering()).hold(call, { amountNanoUsd: value } as never), 'amountNanoUsd')
  })

  /** A zero token count is a valid estimate. */
  it('accepts zero token counts', async () => {
    await expect((await metering()).hold(call, { ...rated, inputTokens: 0, maxOutputTokens: 0 })).resolves.toBeDefined()
  })
})

describe('alert thresholds', () => {
  const BAD_THRESHOLDS: readonly unknown[] = [Number.NaN, 0, 1.5, -0.1, '0.5', true, null]

  it.each(BAD_THRESHOLDS)('refuses the module threshold %p', async (value) => {
    await expectRefused(() => validateOptions({ ...(withStore as object), budgets: { alertThresholds: [value] } } as never), 'alert thresholds')
  })
  it.each([...BAD_THRESHOLDS, 'x'])('refuses the budget soft threshold %p', async (value) => {
    const { service } = makeService()
    await expectRefused(() => service.upsertBudget(budgetInput({ softThresholds: [value] } as never)), 'softThresholds')
  })
  it.each([MARKER, 5, {}, true])('refuses thresholds that are not a list: %p', async (value) => {
    const { service } = makeService()
    await expectRefused(() => service.upsertBudget(budgetInput({ softThresholds: value } as never)), 'softThresholds')
    await expectRefused(() => validateOptions({ ...(withStore as object), budgets: { alertThresholds: value } } as never), 'alert thresholds')
  })
  /** One bad entry among valid ones refuses the whole list. */
  it.each(BAD_THRESHOLDS)('refuses a list of thresholds with %p among valid ones', async (value) => {
    const { service } = makeService()
    await expectRefused(() => service.upsertBudget(budgetInput({ softThresholds: [0.5, value, 1] } as never)), 'softThresholds')
    await expectRefused(() => validateOptions({ ...(withStore as object), budgets: { alertThresholds: [0.5, value, 1] } } as never), 'alert thresholds')
  })
  /** A list of valid fractions, one at the upper bound, is accepted. */
  it('accepts a list of fractions up to and including 1', async () => {
    const { service } = makeService()
    await expect(service.upsertBudget(budgetInput({ softThresholds: [0.1, 0.5, 1] }))).resolves.toBeDefined()
    expect(() => validateOptions({ ...(withStore as object), budgets: { alertThresholds: [0.1, 1] } } as never)).not.toThrow()
  })
})

describe('wallet grant fields other than the amount', () => {
  const REF = { tenantId: 't', ownerType: 'user', ownerId: 'u' } as const
  const grant = (over: object): Promise<unknown> =>
    new WalletService(new InMemoryWalletStore(), { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'priority' }).grant(REF, { amountNanoUsd: 5n, idempotencyKey: 'k', reason: 'r', ...over })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, MARKER, null])('refuses a grant priority of %p', async (value) => {
    await expectRefused(() => grant({ priority: value }), 'priority')
  })
  it.each([new Date(Number.NaN), MARKER, 5, null])('refuses a grant effectiveAt of %p', async (value) => {
    await expectRefused(() => grant({ effectiveAt: value }), 'effectiveAt')
  })
  it.each([new Date(Number.NaN), MARKER, 5, null])('refuses a grant expiresAt of %p', async (value) => {
    await expectRefused(() => grant({ expiresAt: value }), 'expiresAt')
  })
  it('accepts a negative whole priority, a date, and no optional field', async () => {
    await expect(grant({ priority: -2, effectiveAt: new Date(0), expiresAt: new Date('2100-01-01') })).resolves.toBeDefined()
    await expect(grant({})).resolves.toBeDefined()
  })
})

describe('usage token counts of a normalized usage', () => {
  async function recordWith(over: object): Promise<unknown> {
    const options = applyDefaults({ store: makeFullStore(), markup: 1, pricing: { seedFromSnapshot: false, strict: true } })
    const pricing = new InMemoryPricingStore()
    await pricing.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
    const metering = new MeteringService(new LedgerService(new InMemoryLedgerStore(), options), new PricingService(options, pricing), new MarkupResolver(options), options)
    const usage = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0, ...over }
    return metering.record({ usage: usage, context: { tenantId: TENANT, scope: USER_SCOPE, feature: 'f' } })
  }
  /** The typed error code a call refuses with. */
  async function codeOf(run: () => Promise<unknown>): Promise<string> {
    return (JSON.parse(JSON.stringify((await refusal(run)).getResponse())) as { error: { code: string } }).error.code
  }

  /** A fractional count is refused with the typed malformed-usage error, not left to fail in the cost arithmetic. */
  it.each(['inputTokens', 'outputTokens', 'cacheReadTokens'])('refuses a fractional %s with the malformed-usage error', async (field) => {
    expect(await codeOf(() => recordWith({ [field]: 1.5 }))).toBe('AI_TOKENS_USAGE_MALFORMED')
  })
  /** A count that is not a finite number was never a normalized usage, and still is not one. */
  it.each([Number.NaN, Number.POSITIVE_INFINITY, MARKER, null])('refuses a count of %p', async (value) => {
    await refusal(() => recordWith({ inputTokens: value }))
  })
  /** A negative count keeps its documented floor at zero. */
  it('floors a negative count at zero', async () => {
    const result = (await recordWith({ inputTokens: -5 })) as { inputTokens: number }
    expect(result.inputTokens).toBe(0)
  })
})
