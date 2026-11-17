/**
 * @fileoverview A date the caller supplies is a valid `Date` or it is refused. An Invalid Date, a number, a string or a null
 * reaches a store as a raw `RangeError` from a driver, or is accepted and stored as a date that never arrives: a budget that never
 * expires, a window that never starts. Each case sends one bad value through one input and asserts the typed
 * `AI_TOKENS_INVALID_CONFIG` error that names the input and echoes none of the value, and that nothing was stored.
 * @layer server
 */

import { TENANT, USER_SCOPE, budgetInput, makeService } from '../test/fakes/budget-fixtures'
import { makeFullStore } from '../test/fakes/full-store'
import { InMemoryLedgerStore } from '../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../test/fakes/in-memory-pricing-store'
import { applyDefaults } from './server/config'
import { AiTokensException } from './server/errors'
import { LedgerService } from './server/services/ledger.service'
import { MarkupResolver } from './server/services/markup.resolver'
import { MeteringService } from './server/services/metering.service'
import { PricingService } from './server/services/pricing.service'
import { UsageReportService } from './server/services/usage-report.service'
import { WalletService } from './server/services/wallet.service'
import { InMemoryWalletStore } from '../test/fakes/in-memory-wallet-store'

/** A string no valid date contains, to show a refusal never repeats what it was given. */
const MARKER = 'not-a-date-9876543'
const BAD_DATES: readonly unknown[] = [new Date(Number.NaN), new Date(MARKER), new Date(Number.POSITIVE_INFINITY), MARKER, 5, null, {}, true]

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

/** Assert the refusal is the typed invalid-configuration error whose reason starts with `field` and carries none of the value. */
async function expectRefused(run: () => unknown, field: string): Promise<void> {
  const body = JSON.stringify((await refusal(run)).getResponse())
  expect(body).toContain('AI_TOKENS_INVALID_CONFIG')
  expect(body).toContain(`"reason":"${field} must be a valid date"`)
  expect(body).not.toContain(MARKER)
}

describe('the dates of a budget', () => {
  it.each(['anchorAt', 'expiresAt'] as const)('refuses a bad %s at upsert and stores nothing', async (field) => {
    for (const value of BAD_DATES) {
      const { service } = makeService()
      await expectRefused(() => service.upsertBudget(budgetInput({ [field]: value })), field)
      expect(await service.status(TENANT, USER_SCOPE)).toEqual([])
    }
  })

  it('accepts a valid date, or none, for each', async () => {
    const { service } = makeService()
    await expect(service.upsertBudget(budgetInput({ anchorAt: new Date(0), expiresAt: new Date('2100-01-01T00:00:00Z') }))).resolves.toBeDefined()
    await expect(service.upsertBudget(budgetInput({}))).resolves.toBeDefined()
  })

  it.each(BAD_DATES)('refuses the new window start %p of a rotation and leaves the window as it was', async (value) => {
    const { service } = makeService()
    const budget = await service.upsertBudget(budgetInput({ anchorAt: new Date('2026-01-01T00:00:00Z') }))
    const before = await service.status(TENANT, USER_SCOPE)
    await expectRefused(() => service.rotateWindow(budget.id, TENANT, value as never), 'newWindowStart')
    expect(await service.status(TENANT, USER_SCOPE)).toEqual(before)
  })

  it('rotates to a valid date, or to now when none is given', async () => {
    const { service } = makeService()
    const budget = await service.upsertBudget(budgetInput({}))
    await expect(service.rotateWindow(budget.id, TENANT, new Date('2026-02-01T00:00:00Z'))).resolves.toBeUndefined()
    await expect(service.rotateWindow(budget.id, TENANT)).resolves.toBeUndefined()
  })
})

describe('the instant of a record', () => {
  async function metering(): Promise<{ metering: MeteringService; ledger: InMemoryLedgerStore }> {
    const options = applyDefaults({ store: makeFullStore(), markup: 1, pricing: { seedFromSnapshot: false, strict: true } })
    const pricing = new InMemoryPricingStore()
    await pricing.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
    const ledger = new InMemoryLedgerStore()
    return { ledger, metering: new MeteringService(new LedgerService(ledger, options), new PricingService(options, pricing), new MarkupResolver(options), options) }
  }
  const usage = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
  const context = { tenantId: TENANT, scope: USER_SCOPE, feature: 'f' }

  it.each(BAD_DATES)('refuses an occurredAt of %p and appends nothing', async (value) => {
    const { metering: service, ledger } = await metering()
    await expectRefused(() => service.record({ usage, context, occurredAt: value } as never), 'occurredAt')
    expect(await ledger.query({ tenantId: TENANT })).toEqual([])
  })

  it('records at a valid instant, or at now when none is given', async () => {
    const { metering: service } = await metering()
    await expect(service.record({ usage, context, occurredAt: new Date('2026-03-01T00:00:00Z') })).resolves.toBeDefined()
    await expect(service.record({ usage, context })).resolves.toBeDefined()
  })
})

describe('the dates of a filter, an estimate, a reconciliation and a price', () => {
  const REF = { tenantId: TENANT, ownerType: 'user', ownerId: 'u' } as const
  async function services(): Promise<{ ledger: LedgerService; pricing: PricingService; metering: MeteringService; wallets: WalletService }> {
    const options = applyDefaults({ store: makeFullStore(), markup: 1, pricing: { seedFromSnapshot: false, strict: false } })
    const store = new InMemoryPricingStore()
    const ledger = new LedgerService(new InMemoryLedgerStore(), options)
    const pricing = new PricingService(options, store)
    const wallets = new WalletService(new InMemoryWalletStore(), { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' })
    return { ledger, pricing, wallets, metering: new MeteringService(ledger, pricing, new MarkupResolver(options), options) }
  }
  const ESTIMATE = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1, maxOutputTokens: 1 } as const

  it.each(BAD_DATES)('refuses a ledger filter whose from or to is %p', async (value) => {
    const { ledger } = await services()
    await expectRefused(() => ledger.query({ tenantId: TENANT, from: value } as never), 'from')
    await expectRefused(() => ledger.sumCost({ tenantId: TENANT, to: value } as never), 'to')
  })

  it.each(BAD_DATES)('refuses verifyChain with a from or to of %p', async (value) => {
    const { ledger } = await services()
    await expectRefused(() => ledger.verifyChain(TENANT, value as never), 'from')
    await expectRefused(() => ledger.verifyChain(TENANT, undefined, value as never), 'to')
  })

  it.each(BAD_DATES)('refuses wallet entries filtered from or to %p', async (value) => {
    const { wallets } = await services()
    await expectRefused(() => wallets.getEntries(REF, { from: value } as never), 'from')
    await expectRefused(() => wallets.getEntries(REF, { to: value } as never), 'to')
  })

  it.each(BAD_DATES)('refuses a cost estimate at %p', async (value) => {
    const { metering } = await services()
    await expectRefused(() => metering.estimateCost({ ...ESTIMATE, at: value } as never), 'at')
  })

  it.each([...BAD_DATES, undefined])('refuses the window start %p of a reconciliation', async (value) => {
    const { service } = makeService()
    const budget = await service.upsertBudget(budgetInput({}))
    await expectRefused(() => service.reconcileWindow(budget.id, TENANT, value as never), 'windowStart')
  })

  it.each(BAD_DATES)('refuses the effectiveFrom %p of a price version and stores nothing', async (value) => {
    const { pricing } = await services()
    const input = { provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n, effectiveFrom: value }
    await expectRefused(() => pricing.upsertPrice(input as never), 'effectiveFrom')
    expect(await pricing.getPriceHistory('openai', 'gpt-5', 'chat')).toEqual([])
  })

  /** The start of a price version is optional and defaults to now, as documented, so leaving it out is not refused. */
  it('takes a price version without an effectiveFrom, and stores it', async () => {
    const { pricing } = await services()
    await expect(pricing.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n })).resolves.toBeDefined()
    expect(await pricing.getPriceHistory('openai', 'gpt-5', 'chat')).toHaveLength(1)
  })

  it('takes the optional date inputs of the ledger, the wallet, the reports and the estimate left out', async () => {
    const { ledger, wallets, metering } = await services()
    await expect(ledger.query({ tenantId: TENANT })).resolves.toEqual([])
    await expect(ledger.sumCost({ tenantId: TENANT })).resolves.toMatchObject({ records: 0, rawCostNanoUsd: 0n })
    await expect(ledger.verifyChain(TENANT)).resolves.toMatchObject({ valid: true })
    await expect(wallets.getEntries(REF)).resolves.toMatchObject({ entries: [] })
    await expect(wallets.getEntries(REF, {})).resolves.toMatchObject({ entries: [] })
    await expect(metering.estimateCost(ESTIMATE)).resolves.toMatchObject({ rawCostNanoUsd: 0n, billedCostNanoUsd: 0n })
    const reports = new UsageReportService(new InMemoryLedgerStore(), new InMemoryPricingStore(), { currency: 'USD', reporting: { maxExportRows: 1000 } })
    await expect(reports.summarize({ tenantId: TENANT, groupBy: [] } as never)).resolves.toEqual([])
    await expect(reports.export({ tenantId: TENANT } as never, 'csv')).resolves.toBeDefined()
  })

  it('accepts a valid date for each input', async () => {
    const { ledger, wallets, metering, pricing } = await services()
    const from = new Date('2026-01-01T00:00:00Z')
    await expect(ledger.query({ tenantId: TENANT, from, to: new Date('2026-02-01T00:00:00Z') })).resolves.toBeDefined()
    await expect(ledger.verifyChain(TENANT, from)).resolves.toBeDefined()
    await expect(wallets.getEntries(REF, { from })).resolves.toBeDefined()
    await expect(metering.estimateCost({ ...ESTIMATE, at: from })).resolves.toBeDefined()
    const { service } = makeService()
    const budget = await service.upsertBudget(budgetInput({}))
    await expect(service.reconcileWindow(budget.id, TENANT, from)).resolves.toBeUndefined()
    await expect(pricing.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n, effectiveFrom: from })).resolves.toBeDefined()
  })
})

describe('the dates of a report, a rate lookup and a budget movement', () => {
  const report = (): UsageReportService => new UsageReportService(new InMemoryLedgerStore(), new InMemoryPricingStore(), { currency: 'USD', reporting: { maxExportRows: 1000 } })

  it.each(BAD_DATES)('refuses a report filtered from or to %p', async (value) => {
    await expectRefused(() => report().summarize({ tenantId: TENANT, groupBy: [], from: value } as never), 'from')
    await expectRefused(() => report().summarize({ tenantId: TENANT, groupBy: [], to: value } as never), 'to')
    await expectRefused(() => report().export({ tenantId: TENANT, from: value } as never, 'csv'), 'from')
    await expectRefused(() => report().export({ tenantId: TENANT, to: value } as never, 'csv'), 'to')
  })

  it.each([...BAD_DATES, undefined])('refuses a rate lookup at %p', async (value) => {
    const options = applyDefaults({ store: makeFullStore(), markup: 1, pricing: { seedFromSnapshot: false, strict: false } })
    const pricing = new PricingService(options, new InMemoryPricingStore())
    await expectRefused(() => pricing.resolveRate({ provider: 'openai', model: 'gpt-5', operation: 'chat', at: value } as never), 'at')
  })

  it.each(BAD_DATES)('refuses the instant %p of a budget movement and moves nothing', async (value) => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    const call = { tenantId: TENANT, scope: USER_SCOPE, feature: 'f' }
    const delta = { nanoUsd: 10n, tokens: 0, count: 0 }
    await expectRefused(() => service.consume(call, delta, value as never), 'at')
    await expectRefused(() => service.release(call, delta, value as never), 'at')
    await expectRefused(() => service.adjust(call, delta, value as never), 'at')
    await expectRefused(() => service.commit(call, delta, value as never, 'k', 'a'), 'at')
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.spent.nanoUsd).toBe(0n)
  })
})

