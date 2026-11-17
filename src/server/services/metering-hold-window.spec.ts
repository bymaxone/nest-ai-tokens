/**
 * @fileoverview The window a hold charges is the window of the instant stamped on its ledger row, even when a window boundary
 * falls between that stamp and the moment the budget is consumed. The reservation, its rollback and its release then act
 * on one window, in the budget store and in the live counter, so nothing stays counted in a window nobody gives back.
 * @layer server
 */

import { TENANT, USER_SCOPE } from '../../../test/fakes/budget-fixtures'
import { makeFullStore } from '../../../test/fakes/full-store'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { applyDefaults } from '../config'
import type { ResolvedAiTokensOptions } from '../config'
import type { HoldEstimate, IBudgetCounterStore } from '../interfaces'
import { BudgetService } from './budget.service'
import { counterKey } from './budget.keys'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService } from './metering.service'
import { PricingService } from './pricing.service'
import { WalletService } from './wallet.service'

/** The instant stamped on the row, a hundred milliseconds before the day ends. */
const STAMPED = new Date('2026-06-10T23:59:59.900Z')
/** The instant the budget is consumed, after the boundary. */
const CONSUMED = new Date('2026-06-11T00:00:00.100Z')
const DAY_ONE = new Date('2026-06-10T00:00:00.000Z')
const DAY_TWO = new Date('2026-06-11T00:00:00.000Z')
const ESTIMATE: HoldEstimate = {
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
  inputTokens: 1000,
  maxOutputTokens: 500,
}

/** A live counter that keeps its values, so the test reads what the fast path counted. */
class Counter implements IBudgetCounterStore {
  readonly values = new Map<string, bigint>()
  incrIfBelow(key: string, amount: bigint, limit: bigint): Promise<boolean> {
    const next = (this.values.get(key) ?? 0n) + amount
    if (next > limit) return Promise.resolve(false)
    this.values.set(key, next)
    return Promise.resolve(true)
  }
  decr(key: string, amount: bigint): Promise<void> {
    this.values.set(key, (this.values.get(key) ?? 0n) - amount)
    return Promise.resolve()
  }
  reset(key: string): Promise<void> {
    this.values.delete(key)
    return Promise.resolve()
  }
}

interface Rig {
  metering: MeteringService
  budgets: InMemoryBudgetStore
  ledgerStore: InMemoryLedgerStore
  counter: Counter
  budgetId: string
}

/** The resolved options of the rig: budgets with the live counter, and a wallet that holds nothing when asked for. */
function rigOptions(counter: Counter, wallet: boolean): ResolvedAiTokensOptions {
  return applyDefaults({
    store: makeFullStore(),
    markup: 1,
    pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    ...(wallet
      ? {
          wallets: {
            creditRateNanoUsd: 1_000_000_000n,
            overdraftNanoUsd: 0n,
            burnOrder: 'expiry' as const,
          },
        }
      : {}),
    budgets: { counter },
  })
}

/** The price and the day budget every rig starts from. */
async function seedRig(
  pricingStore: InMemoryPricingStore,
  budgets: InMemoryBudgetStore,
): Promise<string> {
  await pricingStore.upsertPrice({
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_250_000_000n,
    outputNanoUsdPerMillion: 10_000_000_000n,
    effectiveFrom: new Date(0),
  })
  const budget = await budgets.upsert({
    id: 'b-day',
    tenantId: TENANT,
    scope: { type: 'tenant', id: TENANT },
    window: 'day',
    limitNanoUsd: 1_000_000_000n,
    softThresholds: [],
    policy: 'block',
  })
  return budget.id
}

/** A metering service stamping rows at STAMPED over a budget service that reads CONSUMED: the boundary falls between them. */
async function rig(wallet = false): Promise<Rig> {
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  const budgets = new InMemoryBudgetStore({ now: () => CONSUMED })
  const counter = new Counter()
  const options = rigOptions(counter, wallet)
  if (!options.budgets.enabled) throw new Error('the fixture enables budgets')
  const ledger = new LedgerService(ledgerStore, options)
  const budgetService = new BudgetService(budgets, ledger, options.budgets, () => CONSUMED)
  const walletService =
    wallet && options.wallets.enabled
      ? new WalletService(new InMemoryWalletStore({ now: () => STAMPED }), options.wallets)
      : undefined
  const metering = new MeteringService(
    ledger,
    new PricingService(options, pricingStore),
    new MarkupResolver(options),
    options,
    undefined,
    walletService,
    budgetService,
    () => STAMPED,
  )
  return { metering, budgets, ledgerStore, counter, budgetId: await seedRig(pricingStore, budgets) }
}

async function spent(r: Rig, windowStart: Date): Promise<bigint> {
  return (await r.budgets.getWindow(r.budgetId, windowStart))?.spentNanoUsd ?? 0n
}

const context = (
  key?: string,
): { tenantId: string; scope: typeof USER_SCOPE; feature: string; idempotencyKey?: string } => ({
  tenantId: TENANT,
  scope: USER_SCOPE,
  feature: 'chat.reply',
  ...(key === undefined ? {} : { idempotencyKey: key }),
})

describe('the window a hold charges', () => {
  /**
   * Invariant: the reservation lands in the window of the row's instant, in the store and in the counter, and nothing is
   * charged to the window the consume happened to run in; a release gives it back from that same window.
   */
  it('charges the window of the row and gives it back from that window', async () => {
    const r = await rig()
    const hold = await r.metering.hold(context('w-1'), ESTIMATE)
    expect(await spent(r, DAY_ONE)).toBe(hold.estimatedCostNanoUsd)
    expect(await spent(r, DAY_TWO)).toBe(0n)
    expect(r.counter.values.get(counterKey(r.budgetId, DAY_ONE, 'cost'))).toBe(
      hold.estimatedCostNanoUsd,
    )
    expect(r.counter.values.get(counterKey(r.budgetId, DAY_TWO, 'cost'))).toBeUndefined()
    await r.metering.release(hold, context('w-1'), 'done')
    expect(await spent(r, DAY_ONE)).toBe(0n)
    expect(await spent(r, DAY_TWO)).toBe(0n)
    expect(r.counter.values.get(counterKey(r.budgetId, DAY_ONE, 'cost'))).toBe(0n)
  })

  /** Invariant: a hold whose ledger append failed gives its reservation back from the window it charged. */
  it('gives the reservation back from the window it charged when the append fails', async () => {
    const r = await rig()
    jest.spyOn(r.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    await expect(r.metering.hold(context('w-2'), ESTIMATE)).rejects.toThrow('connection reset')
    expect(await spent(r, DAY_ONE)).toBe(0n)
    expect(await spent(r, DAY_TWO)).toBe(0n)
    expect(r.counter.values.get(counterKey(r.budgetId, DAY_ONE, 'cost')) ?? 0n).toBe(0n)
    expect(r.counter.values.get(counterKey(r.budgetId, DAY_TWO, 'cost')) ?? 0n).toBe(0n)
  })

  /** Invariant: a hold refused by the wallet gives its reservation back from the window it charged. */
  it('gives the reservation back from the window it charged when the wallet refuses the hold', async () => {
    const r = await rig(true)
    await expect(r.metering.hold(context('w-3'), ESTIMATE)).rejects.toThrow()
    expect(await spent(r, DAY_ONE)).toBe(0n)
    expect(await spent(r, DAY_TWO)).toBe(0n)
    expect(r.counter.values.get(counterKey(r.budgetId, DAY_ONE, 'cost')) ?? 0n).toBe(0n)
    expect(r.counter.values.get(counterKey(r.budgetId, DAY_TWO, 'cost')) ?? 0n).toBe(0n)
  })

  /** Invariant: a keyed retry after the boundary charges the window once. */
  it('charges the window once when a keyed hold is retried', async () => {
    const r = await rig()
    const first = await r.metering.hold(context('w-4'), ESTIMATE)
    await r.metering.hold(context('w-4'), ESTIMATE)
    expect(await spent(r, DAY_ONE)).toBe(first.estimatedCostNanoUsd)
    expect(await spent(r, DAY_TWO)).toBe(0n)
  })
})
