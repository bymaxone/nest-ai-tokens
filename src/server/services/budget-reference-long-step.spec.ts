/**
 * @fileoverview A call whose wallet debit or ledger append outlives the sweep's grace, with the budget-reference sweep
 * running in the middle and the call committing afterwards: the window counts the call exactly once and its references end
 * as the one `row`, as in a run in which nothing was slow. Also a crash between the budget take and the append, a price
 * change, the sweep, and a retry that succeeds once.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { NormalizedUsage } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import { BudgetReferenceSweeper } from '../enforcement/budget-reference-sweeper'
import type { HoldEstimate, MeteringContext } from '../interfaces'
import { BudgetService } from './budget.service'
import { LedgerService } from './ledger.service'
import { MarkupResolver } from './markup.resolver'
import { MeteringService } from './metering.service'
import { PricingService } from './pricing.service'
import { WalletService } from './wallet.service'

const GRACE = 300
const ESTIMATE: HoldEstimate = { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 }
const USAGE: NormalizedUsage = {
  provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
  reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0,
}

function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', ...over }
}

/** A clock that moves only when told to, plus a distinct instant per read so two attempts never share one. */
function clock(): { now: () => Date; advance: (seconds: number) => void } {
  const state = { at: Date.now(), reads: 0 }
  return { now: (): Date => new Date(state.at + (state.reads += 1)), advance: (seconds): void => void (state.at += seconds * 1000) }
}

/** A step held open until the test releases it, and a signal that the step was reached. */
function gate(): { wait: Promise<void>; open: () => void; reached: Promise<void>; reach: () => void } {
  let open = (): void => undefined
  let reach = (): void => undefined
  const wait = new Promise<void>((resolve) => void (open = resolve))
  const reached = new Promise<void>((resolve) => void (reach = resolve))
  return { wait, open, reached, reach }
}

interface Rig {
  service: MeteringService
  /** Another instance over the same stores: a retry after the first one's process died reaches it. */
  other: MeteringService
  ledgerStore: InMemoryLedgerStore
  pricingStore: InMemoryPricingStore
  walletStore: InMemoryWalletStore
  budgetStore: InMemoryBudgetStore
  budgets: BudgetService
  sweeper: BudgetReferenceSweeper
  advance: (seconds: number) => void
}

async function rig(withWallet = true): Promise<Rig> {
  const { now, advance } = clock()
  const ledgerStore = new InMemoryLedgerStore()
  const pricingStore = new InMemoryPricingStore()
  const walletStore = new InMemoryWalletStore({ now })
  const budgetStore = new InMemoryBudgetStore({ now })
  const options = {
    ratingMode: 'rate-table', markup: 1, ledger: { hashChain: false },
    pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    wallets: { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    budgets: { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true },
  } as unknown as ResolvedAiTokensOptions
  const ledger = new LedgerService(ledgerStore, options)
  const wallets = new WalletService(walletStore, options.wallets as never)
  const budgets = new BudgetService(budgetStore, ledger, options.budgets as never, now)
  const instance = (): MeteringService => new MeteringService(ledger, new PricingService(options, pricingStore), new MarkupResolver(options), options, undefined, withWallet ? wallets : undefined, budgets, now)
  const service = instance()
  await pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  await wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 10_000_000_000n, idempotencyKey: 'grant', reason: 'seed' })
  await budgets.upsertBudget({ tenantId: 'tenant-1', scope: { type: 'tenant', id: 'tenant-1' }, window: 'month', limitNanoUsd: 1_000_000_000n })
  const sweeper = new BudgetReferenceSweeper(budgetStore, ledger, { graceSeconds: GRACE, holdTtlSeconds: 3_600, retentionSeconds: 604_800 }, now)
  return { service, other: instance(), ledgerStore, pricingStore, walletStore, budgetStore, budgets, sweeper, advance }
}

/** What the window holds and which references stand, the two things a run is compared by. */
async function outcome(r: Rig): Promise<{ spent: bigint; tokens: number; count: number; references: string[] }> {
  const [status] = await r.budgets.status('tenant-1', { type: 'user', id: 'u1' })
  return { spent: status!.spent.nanoUsd, tokens: status!.spent.tokens, count: status!.spent.count, references: r.budgetStore.heldReferences() }
}

type Call = 'hold' | 'record'
type Stall = 'append' | 'wallet debit'

/** Start a call, stall it at one step, run `during` while it is stuck, then let it finish. */
async function run(r: Rig, call: Call, key: string, stall: Stall | null, during: () => Promise<void>): Promise<void> {
  const g = gate()
  if (stall === 'append') {
    const original = r.ledgerStore.append.bind(r.ledgerStore)
    jest.spyOn(r.ledgerStore, 'append').mockImplementationOnce(async (...args) => {
      g.reach()
      await g.wait
      return original(...args)
    })
  } else if (stall === 'wallet debit') {
    const original = r.walletStore.conditionalDebit.bind(r.walletStore)
    jest.spyOn(r.walletStore, 'conditionalDebit').mockImplementationOnce(async (...args) => {
      g.reach()
      await g.wait
      return original(...args)
    })
  }
  const started = call === 'hold' ? r.service.hold(context({ idempotencyKey: key }), ESTIMATE) : r.service.record({ usage: USAGE, context: context({ enforce: true, idempotencyKey: key }) })
  if (stall !== null) await g.reached
  await during()
  g.open()
  await started
}

describe('a call that outlives the grace of the budget-reference sweep', () => {
  beforeEach(() => void jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined))
  afterEach(() => void jest.restoreAllMocks())

  /*
   * Invariant: the sweep gives back the reference of an attempt that is slow, not dead, and the call's commit takes the
   * movement again under the committed name, so the window counts the call once and the references end as one `row`. The
   * expected state is the one of a control run with no stall and no sweep.
   */
  it.each([
    ['hold', 'append'],
    ['hold', 'wallet debit'],
    ['record', 'append'],
    ['record', 'wallet debit'],
  ] as [Call, Stall][])('counts a %s once and ends with one committed reference when its %s outlives the grace', async (call, stall) => {
    const control = await rig()
    await run(control, call, 'k1', null, () => Promise.resolve())
    const expected = await outcome(control)
    expect(expected.references).toHaveLength(1)
    expect(expected.spent > 0n).toBe(true)

    const slow = await rig()
    let midway = { spent: -1n, references: [] as string[] }
    await run(slow, call, 'k1', stall, async () => {
      slow.advance(GRACE + 1)
      await slow.sweeper.sweep()
      const seen = await outcome(slow)
      midway = { spent: seen.spent, references: seen.references }
    })
    // While the call was stuck the sweep gave the movement back: the window did not count it.
    expect(midway).toEqual({ spent: 0n, references: [] })
    expect(await outcome(slow)).toEqual(expected)
    // A further sweep, and a replay of the call, change nothing.
    slow.advance(GRACE + 1)
    await slow.sweeper.sweep()
    expect(await outcome(slow)).toEqual(expected)
  })

  /**
   * The PM's condition: an attempt that dies after the take and before the append holds its movement, and a retry at another
   * price is refused until the sweep gives the movement back; then the retry succeeds once and counts once.
   */
  it('lets a retry at another price succeed once after the sweep freed the movement a dead attempt held', async () => {
    // No wallet: a debit the dead attempt made under the key is the orphan-debit give-back, not the budget sweep.
    const r = await rig(false)
    const never = gate()
    jest.spyOn(r.ledgerStore, 'append').mockImplementationOnce(async () => {
      never.reach()
      await never.wait
      throw new Error('process died')
    })
    const dead = r.service.hold(context({ idempotencyKey: 'k9' }), ESTIMATE)
    dead.catch(() => undefined)
    await never.reached
    // The price changes: the same key now estimates a different amount.
    await r.pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 2_500_000_000n, outputNanoUsdPerMillion: 20_000_000_000n, effectiveFrom: new Date(Date.now()) })
    // The pricing cache holds a rate for its TTL; once past it, the retry rates at the new price.
    r.advance(GRACE + 1)
    await expect(r.other.hold(context({ idempotencyKey: 'k9' }), ESTIMATE)).rejects.toThrow()
    await r.sweeper.sweep()
    expect((await outcome(r)).references).toEqual([])
    const retried = await r.other.hold(context({ idempotencyKey: 'k9' }), ESTIMATE)
    const after = await outcome(r)
    expect(after.spent).toBe(retried.estimatedCostNanoUsd)
    expect(after.references).toHaveLength(1)
    const again = await r.other.hold(context({ idempotencyKey: 'k9' }), ESTIMATE)
    expect(again.id).toBe(retried.id)
    expect((await outcome(r)).spent).toBe(retried.estimatedCostNanoUsd)
    never.open()
  })
})
