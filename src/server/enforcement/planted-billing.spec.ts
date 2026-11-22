/**
 * A key planted on `Object.prototype` is not what the host supplied, on the paths that decide a charge: the usage a handler returns, the
 * hold the guard put on the request, the budgets a store returned, and the context a hold is placed for. Each row plants the key, runs
 * the call and asserts what was billed or whether the call was blocked.
 * @layer server
 */
import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { lastValueFrom, of } from 'rxjs'
import type { AiTokensErrorResponse, Budget, NormalizedUsage } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { AiTokensException } from '../errors'
import type { MeteringContext } from '../interfaces'
import { BudgetService, LedgerService, MarkupResolver, MeteringService, PricingService, WalletService } from '../services'
import { BudgetGuard } from './budget.guard'
import { Meter, RequireBudget } from './decorators'
import { MeteringInterceptor } from './metering.interceptor'

const WALLET = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' } as const
const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }

/** A complete normalized usage (1000-in / 500-out gpt-5 chat): 6,250,000 nano-USD. */
function normalized(): NormalizedUsage {
  return { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
}

/** Handlers carrying the decorators. */
class Fixture {
  @Meter({ feature: 'chat.reply' })
  metered(): unknown {
    return { usage: normalized() }
  }

  @RequireBudget({ estimate: { amountNanoUsd: 5_000_000n } })
  @Meter({ feature: 'chat.reply' })
  held(): unknown {
    return { usage: normalized() }
  }
}
const fixture = new Fixture()

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it, whatever `run` does. */
async function planted<T>(key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

/** The typed code of a refusal. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** A mock execution context for a handler and request. */
function executionContext(handler: () => unknown, request: Record<string, unknown> = {}): ExecutionContext {
  return { getHandler: () => handler, getClass: () => Fixture, switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) } as unknown as ExecutionContext
}

/** A CallHandler resolving to `value`. */
function handlerOf(value: unknown): CallHandler {
  return { handle: () => of(value) }
}

/** A world: a funded wallet, a priced model, the guard, the interceptor and the services. */
async function world(): Promise<{ metering: MeteringService; wallets: WalletService; budgets: BudgetService; budgetStore: InMemoryBudgetStore; guard: BudgetGuard; interceptor: MeteringInterceptor }> {
  const now = (): Date => new Date()
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    wallets: { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    budgets: { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true },
    scopeResolver: () => CONTEXT,
  } as unknown as ResolvedAiTokensOptions
  const ledger = new LedgerService(new InMemoryLedgerStore(), options)
  const pricingStore = new InMemoryPricingStore()
  await pricingStore.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  const wallets = new WalletService(new InMemoryWalletStore({ now }), options.wallets as never)
  await wallets.grant(WALLET, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
  const budgetStore = new InMemoryBudgetStore({ now })
  const budgets = new BudgetService(budgetStore, ledger, options.budgets as never, now)
  const metering = new MeteringService(ledger, new PricingService(options, pricingStore), new MarkupResolver(options), options, undefined, wallets, budgets, now)
  const guard = new BudgetGuard(budgets, metering, new Reflector(), { scopeResolver: () => CONTEXT })
  return { metering, wallets, budgets, budgetStore, guard, interceptor: new MeteringInterceptor(new Reflector(), metering, { scopeResolver: () => CONTEXT }) }
}

describe('what a handler returned', () => {
  /** A result with no usage is refused; a `usage` found on `Object.prototype` is not the handler's. */
  it('refuses a result with no usage when a usage is planted, and bills nothing', async () => {
    const { wallets, interceptor } = await world()
    const call = planted('usage', normalized(), () => lastValueFrom(interceptor.intercept(executionContext(fixture.metered), handlerOf({}))))
    await expect(call).rejects.toMatchObject({})
    await planted('usage', normalized(), () => lastValueFrom(interceptor.intercept(executionContext(fixture.metered), handlerOf({})))).catch((error: unknown) => expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED'))
    expect((await wallets.getBalance(WALLET)).nanoUsd).toBe(100_000_000n)
  })
})

describe('the hold the guard put on the request', () => {
  /** A request the guard enriched without a hold is settled post-hoc, whatever `hold` is planted. */
  it('records and bills 6,250,000 when a hold is planted and the guard placed none', async () => {
    const { wallets, interceptor } = await world()
    const request = { aiTokens: { status: [], context: CONTEXT } }
    await planted('hold', { id: 'planted', tenantId: 'tenant-1', scope: CONTEXT.scope, estimatedTokens: 1, estimatedCostNanoUsd: 1n, expiresAt: new Date() }, () => lastValueFrom(interceptor.intercept(executionContext(fixture.metered, request), handlerOf({ usage: normalized() }))))
    expect((await wallets.getBalance(WALLET)).nanoUsd).toBe(93_750_000n)
  })
})

describe('the budgets a store returned', () => {
  /** A budget row with no `features` applies to every feature: a planted `features` does not exempt the call. */
  it('still blocks an exhausted all-features budget when features is planted', async () => {
    const { budgets, guard } = await world()
    await budgets.upsertBudget({ tenantId: 'tenant-1', scope: CONTEXT.scope, limitNanoUsd: 100n, window: 'month' })
    await budgets.consume(CONTEXT, { nanoUsd: 100n, tokens: 0, count: 0 })
    await planted('features', ['other.feature'], () => guard.canActivate(executionContext(fixture.metered))).then(
      () => {
        throw new Error('the call was not blocked')
      },
      (error: unknown) => expect(codeOf(error)).toBe('AI_TOKENS_BUDGET_EXCEEDED'),
    )
  })

  /** A budget with no tokens limit has none: a planted `limitTokens` of 0 is not a hard block. */
  it.each([['limitTokens', 0], ['limitCount', 0], ['limitNanoUsd', 0n]])('does not block a budget that sets no limit when %s is planted', async (key, value) => {
    const { budgets, guard } = await world()
    await budgets.upsertBudget({ tenantId: 'tenant-1', scope: CONTEXT.scope, ...(key === 'limitNanoUsd' ? { limitTokens: 1_000_000 } : { limitNanoUsd: 100_000_000n }), window: 'month' })
    await expect(planted(key, value, () => guard.canActivate(executionContext(fixture.metered)))).resolves.toBe(true)
  })

  /** The status of a budget with no tokens limit has none: a planted `tokens` is not a limit of 0. */
  it('does not block when tokens is planted on the status of a budget without a tokens limit', async () => {
    const { budgets, guard } = await world()
    await budgets.upsertBudget({ tenantId: 'tenant-1', scope: CONTEXT.scope, limitNanoUsd: 100_000_000n, window: 'month' })
    await expect(planted('tokens', 0, () => guard.canActivate(executionContext(fixture.metered)))).resolves.toBe(true)
  })
})

describe('the tenant of a budget a store returned', () => {
  /** A row that names no tenant is not the tenant's, whatever tenant is planted on `Object.prototype`. */
  it('does not match a budget row that has no tenantId when the caller\'s tenant is planted', async () => {
    const { budgets, budgetStore } = await world()
    await budgets.upsertBudget({ tenantId: 'tenant-1', scope: CONTEXT.scope, limitNanoUsd: 100n, window: 'month' })
    const find = budgetStore.findMatching.bind(budgetStore)
    jest.spyOn(budgetStore, 'findMatching').mockImplementation(async (...args) => (await find(...args)).map(({ tenantId: _tenant, ...rest }) => rest as Budget))
    await expect(planted('tenantId', 'tenant-1', () => budgets.status('tenant-1', CONTEXT.scope))).resolves.toEqual([])
  })
})

describe('the request the guard enriched', () => {
  /** An `aiTokens` of null is no enrichment: the call is settled as one with no guard. */
  it('records and bills 6,250,000 when the request carries a null aiTokens', async () => {
    const { wallets, interceptor } = await world()
    await lastValueFrom(interceptor.intercept(executionContext(fixture.metered, { aiTokens: null }), handlerOf({ usage: normalized() })))
    expect((await wallets.getBalance(WALLET)).nanoUsd).toBe(93_750_000n)
  })
})

describe('the context a hold is placed for', () => {
  /** A planted `isSystemCost` does not make a hold free: the wallet is reserved. */
  it('reserves the wallet for a hold when isSystemCost is planted', async () => {
    const { guard, wallets } = await world()
    const before = await wallets.getBalance(WALLET)
    await planted('isSystemCost', true, () => guard.canActivate(executionContext(fixture.held)))
    expect(await wallets.getBalance(WALLET)).not.toEqual(before)
  })

  /** A planted `idempotencyKey` does not make two holds one. */
  it('places two holds when an idempotencyKey is planted', async () => {
    const { metering } = await world()
    const first = await planted('idempotencyKey', 'planted-key', () => metering.hold({ ...CONTEXT, feature: 'a' }, { amountNanoUsd: 1_000_000n }))
    const second = await planted('idempotencyKey', 'planted-key', () => metering.hold({ ...CONTEXT, feature: 'b' }, { amountNanoUsd: 1_000_000n }))
    expect(second.id).not.toBe(first.id)
  })
})
