/**
 * @fileoverview The calls of the argument specs: every public method of the services over in-memory stores, each as a function of
 * its arguments and the arguments that make it succeed. `argument-matrix.spec.ts` puts hostile values into them and
 * `argument-names.spec.ts` asserts what each refusal names.
 * @layer test
 */

import { TENANT, USER_SCOPE, makeService } from './budget-fixtures'
import { makeFullStore } from './full-store'
import { InMemoryLedgerStore } from './in-memory-ledger-store'
import { InMemoryPricingStore } from './in-memory-pricing-store'
import { InMemoryWalletStore } from './in-memory-wallet-store'
import { applyDefaults } from '../../src/server/config'
import { providerPresets } from '../../src/server/config/provider-presets'
import type { BudgetService } from '../../src/server/services/budget.service'
import { LedgerService } from '../../src/server/services/ledger.service'
import { MarkupResolver } from '../../src/server/services/markup.resolver'
import { MeteringService } from '../../src/server/services/metering.service'
import { PricingService } from '../../src/server/services/pricing.service'
import { UsageReportService } from '../../src/server/services/usage-report.service'
import { WalletService } from '../../src/server/services/wallet.service'

/** The arguments of a call as the call reads them; each is cast to the type the method takes, which is the point of the matrix. */
type Args = [never, never, never, never]

/** The calls of the argument specs, by the name of the method: each runs the method with the arguments it is given and builds, fresh each time, the arguments that make it succeed. */
export interface Rig {
  readonly calls: Record<string, { run: (args: unknown[]) => unknown; base: () => unknown[] | Promise<unknown[]> }>
}

let counter = 0
const next = (): string => String((counter += 1))
const key = (): string => `k${next()}`

/** Fresh objects for every call, because a call may keep what it is given and the matrix writes hostile values into them. */
const ref = (): { tenantId: string; ownerType: 'user'; ownerId: string } => ({ tenantId: TENANT, ownerType: 'user', ownerId: 'u' })
const scope = (): typeof USER_SCOPE => ({ ...USER_SCOPE })
const context = (): Record<string, unknown> => ({ tenantId: TENANT, scope: scope(), feature: 'f', idempotencyKey: key(), baseModel: 'gpt-4o' })
const caller = (): Record<string, unknown> => ({ tenantId: TENANT, scope: scope() })
const estimate = (): Record<string, unknown> => ({ provider: 'openai', model: 'gpt-4o', operation: 'chat', inputTokens: 10, maxOutputTokens: 10 })
const usage = (): Record<string, unknown> => ({ model: 'gpt-4o', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })
const entry = (): Record<string, unknown> => ({ amountNanoUsd: 5n, idempotencyKey: key(), reason: 'r' })
const preset = providerPresets.openaiChat

/** The services the matrix calls, and the budget and the record it works on. */
interface World {
  readonly pricing: PricingService
  readonly ledger: LedgerService
  readonly metering: MeteringService
  readonly wallets: WalletService
  readonly budgets: BudgetService
  readonly reports: UsageReportService
  readonly budget: Awaited<ReturnType<BudgetService['upsertBudget']>>
  readonly seeded: Awaited<ReturnType<MeteringService['record']>>
}

/** The services over in-memory stores, with a price, a funded wallet, a budget and one posted record to work on. */
async function world(): Promise<World> {
  const options = applyDefaults({ store: makeFullStore(), markup: 1, pricing: { seedFromSnapshot: false, strict: true } })
  const pricingStore = new InMemoryPricingStore()
  const pricing = new PricingService(options, pricingStore)
  const ledgerStore = new InMemoryLedgerStore()
  const ledger = new LedgerService(ledgerStore, options)
  const metering = new MeteringService(ledger, pricing, new MarkupResolver(options), options)
  const wallets = new WalletService(new InMemoryWalletStore(), { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' })
  const { service: budgets } = makeService()
  const reports = new UsageReportService(ledgerStore, pricingStore, { currency: 'USD', reporting: { maxExportRows: 1000 } })
  await pricing.upsertPrice({ provider: 'openai', model: 'gpt-4o', operation: 'chat', inputNanoUsdPerMillion: 2_500_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  await wallets.grant(ref(), { amountNanoUsd: 900_000_000_000n, effectiveAt: new Date('2020-01-01'), idempotencyKey: 'seed', reason: 'r' })
  const budget = await budgets.upsertBudget({ tenantId: TENANT, scope: scope(), window: 'day', limitCount: 1_000_000 })
  const seeded = await metering.record({ usage: usage(), preset: { ...preset }, context: context() } as never)
  return { pricing, ledger, metering, wallets, budgets, reports, budget, seeded }
}

/** Every public method as a call, with the arguments that make it succeed. */
function callsOf({ pricing, ledger, metering, wallets, budgets, reports, budget, seeded }: World): Rig['calls'] {
  const heldHold = (): Promise<unknown> => metering.hold(context() as never, estimate() as never)
  const call = (fn: (a: Args) => unknown, base: () => unknown[] | Promise<unknown[]>): Rig['calls'][string] => ({ run: (args) => fn(args as Args), base })
  return {
    'metering.hold': call((a) => metering.hold(a[0], a[1]), () => [context(), estimate()]),
    'metering.hold(amount)': call((a) => metering.hold(a[0], a[1]), () => [context(), { amountNanoUsd: 5n }]),
    'metering.record': call((a) => metering.record(a[0]), () => [{ usage: usage(), preset: { ...preset }, context: context() }]),
    'metering.estimateCost': call((a) => metering.estimateCost(a[0]), () => [{ ...estimate(), feature: 'f' }]),
    'metering.getStatus': call((a) => metering.getStatus(a[0], a[1]), () => [TENANT, scope()]),
    'metering.reverse': call((a) => metering.reverse(a[0], a[1]), () => [seeded.id, 'why']),
    'metering.capture': call((a) => metering.capture(a[0], a[1], a[2], a[3]), async () => [await heldHold(), caller(), usage(), { ...preset }]),
    'metering.release': call((a) => metering.release(a[0], a[1], a[2]), async () => [await heldHold(), caller(), 'why']),
    'wallets.getBalance': call((a) => wallets.getBalance(a[0]), () => [ref()]),
    'wallets.grant': call((a) => wallets.grant(a[0], a[1]), () => [ref(), entry()]),
    'wallets.debit': call((a) => wallets.debit(a[0], a[1]), () => [ref(), entry()]),
    'wallets.refund': call((a) => wallets.refund(a[0], a[1]), () => [ref(), entry()]),
    'wallets.adjust': call((a) => wallets.adjust(a[0], a[1]), () => [ref(), entry()]),
    'wallets.settleAdjustment': call((a) => wallets.settleAdjustment(a[0], a[1]), () => [ref(), entry()]),
    'wallets.getEntries': call((a) => wallets.getEntries(a[0], a[1]), () => [ref(), { limit: 5 }]),
    'wallets.reconcile': call((a) => wallets.reconcile(a[0]), () => [ref()]),
    'budgets.upsertBudget': call((a) => budgets.upsertBudget(a[0]), () => [{ tenantId: TENANT, scope: { type: 'user', id: `b${next()}` }, window: 'day', limitCount: 5, limitNanoUsd: 100n, limitTokens: 10 }]),
    'budgets.rotateWindow': call((a) => budgets.rotateWindow(a[0], a[1], a[2]), () => [budget.id, TENANT, new Date()]),
    'budgets.reconcileWindow': call((a) => budgets.reconcileWindow(a[0], a[1], a[2]), () => [budget.id, TENANT, new Date()]),
    'budgets.list': call((a) => budgets.list(a[0], a[1]), () => [TENANT, scope()]),
    'budgets.status': call((a) => budgets.status(a[0], a[1]), () => [TENANT, scope()]),
    'budgets.removeBudget': call((a) => budgets.removeBudget(a[0], a[1]), () => [`${budget.id}x`, TENANT]),
    'ledger.findById': call((a) => ledger.findById(a[0]), () => ['abc']),
    'ledger.findByIdempotencyKey': call((a) => ledger.findByIdempotencyKey(a[0], a[1]), () => [TENANT, 'abc']),
    'ledger.query': call((a) => ledger.query(a[0]), () => [{ tenantId: TENANT, limit: 5 }]),
    'ledger.sumCost': call((a) => ledger.sumCost(a[0]), () => [{ tenantId: TENANT }]),
    'ledger.verifyChain': call((a) => ledger.verifyChain(a[0]), () => [TENANT]),
    'reports.summarize': call((a) => reports.summarize(a[0]), () => [{ tenantId: TENANT, from: new Date(0), to: new Date(), groupBy: ['feature'] }]),
    'pricing.resolveRate': call((a) => pricing.resolveRate(a[0]), () => [{ provider: 'openai', model: 'gpt-4o', operation: 'chat', at: new Date() }]),
    'pricing.upsertPrice': call((a) => pricing.upsertPrice(a[0]), () => [{ provider: 'openai', model: `m${next()}`, operation: 'chat', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n }]),
    'pricing.getPriceHistory': call((a) => pricing.getPriceHistory(a[0], a[1], a[2], a[3]), () => ['openai', 'gpt-4o', 'chat']),
  }
}

/** The services and the calls over them. */
export async function rig(): Promise<Rig> {
  return { calls: callsOf(await world()) }
}
