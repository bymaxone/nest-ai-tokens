/**
 * @fileoverview What `BudgetGuard` puts on the request and the hold.
 * @layer test
 */

import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AiTokensErrorResponse, MeteringScope } from '../../shared'
import type { MeteringContext } from '../interfaces'
import type { ResolvedAiTokensOptions } from '../config'
import type { AiTokensException } from '../errors'
import { BudgetService, type BudgetServiceOptions, MarkupResolver, MeteringService, PricingService } from '../services'
import { LedgerService } from '../services/ledger.service'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { providerPresets } from '../config/provider-presets'
import { BudgetGuard } from './budget.guard'
import { AiFeature, Meter, RequireBudget } from './decorators'
import { setRealmGuard } from '../utils/prototype-guard'

// These rows plant keys on Object.prototype to prove what the library reads beneath the realm guard, which would refuse them; the guard is proven in prototype-guard.spec.ts.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))

/** A MeteringService over the shared ledger + the budget service (no wallets). */
function makeMetering(ledger: LedgerService, budgets: BudgetService, now: () => Date): MeteringService {
  const options = { ratingMode: 'rate-table', markup: 1, holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 }, wallets: { enabled: false }, pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} } } as ResolvedAiTokensOptions
  return new MeteringService(ledger, new PricingService(options, new InMemoryPricingStore()), new MarkupResolver(options), options, undefined, undefined, budgets, now)
}

const TENANT = 't1'
const USER_SCOPE: MeteringScope = { type: 'user', id: 'u1' }
const NOW = new Date('2026-06-15T00:00:00.000Z')

/** A controller whose methods carry the enforcement decorators. */
class FixtureController {
  @Meter({ feature: 'meter.feat' })
  @AiFeature('ai.feat')
  metered(): string {
    return 'metered'
  }

  @RequireBudget({ feature: 'req.feat' })
  @Meter({ feature: 'meter.feat' })
  required(): string {
    return 'required'
  }

  @RequireBudget()
  bare(): string {
    return 'bare'
  }

  @RequireBudget({ estimate: { amountNanoUsd: 5_000_000n } })
  withEstimate(): string {
    return 'estimate'
  }

  @RequireBudget({ estimate: { tokens: 2_000 } })
  @Meter({ feature: 'meter.feat', preset: providerPresets.openaiChat })
  withPresetEstimate(): string {
    return 'preset-estimate'
  }

  plain(): string {
    return 'plain'
  }
}

const fixture = new FixtureController()

/** A metering context (trusted input). */
function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: TENANT, scope: USER_SCOPE, feature: 'default.feat', ...over }
}

/** A mock execution context bound to a handler and request. */
function executionContext(handler: () => unknown, request: Record<string, unknown> = {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => FixtureController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
}

/** A guard + budget service over in-memory fakes; the scope resolver returns `ctx`. */
function makeGuard(ctx: MeteringContext = context()): { guard: BudgetGuard; service: BudgetService; ledgerStore: InMemoryLedgerStore } {
  const store = new InMemoryBudgetStore({ now: () => NOW })
  const ledgerStore = new InMemoryLedgerStore()
  const ledger = new LedgerService(ledgerStore)
  const options: BudgetServiceOptions = { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true }
  const service = new BudgetService(store, ledger, options, () => NOW)
  const guard = new BudgetGuard(service, makeMetering(ledger, service, () => NOW), new Reflector(), { scopeResolver: () => ctx })
  return { guard, service, ledgerStore }
}


/** The details a refusal carries. */
function detailsOf(error: unknown): Record<string, unknown> {
  return (((error as AiTokensException).getResponse() as AiTokensErrorResponse).error as { details: Record<string, unknown> }).details
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('accepted')
}

describe('BudgetGuard — what a refusal carries', () => {
  it('names the missing scopeResolver', () => {
    // Scenario: a host builds the guard without a resolver; the reason says which option to set.
    const service = new BudgetService(new InMemoryBudgetStore(), new LedgerService(new InMemoryLedgerStore()), { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true })
    const ledger = new LedgerService(new InMemoryLedgerStore())
    let thrown: unknown
    try {
      new BudgetGuard(service, makeMetering(ledger, service, () => NOW), new Reflector(), {})
    } catch (error) {
      thrown = error
    }
    expect(detailsOf(thrown)).toEqual({ reason: 'BudgetGuard requires options.scopeResolver to resolve the caller scope' })
  })

  it.each([
    ['cost', { limitNanoUsd: 100n }, { nanoUsd: 100n, tokens: 0, count: 0 }],
    ['tokens', { limitTokens: 100 }, { nanoUsd: 0n, tokens: 100, count: 0 }],
    ['count', { limitCount: 1 }, { nanoUsd: 0n, tokens: 0, count: 1 }]
  ])('names the budget and the %s dimension that is exhausted', async (dimension, limit, spend) => {
    // Scenario: the refusal tells the caller which budget and which dimension ran out.
    const { guard, service } = makeGuard()
    const budget = await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, window: 'month', ...limit })
    await service.consume(context(), spend)
    const error = await refusal(guard.canActivate(executionContext(fixture.plain)))
    expect(detailsOf(error)).toEqual({ budgetId: budget.id, dimension })
  })

  it('admits a call while the spent count is below the count limit', async () => {
    // Scenario: a count limit refuses when it is reached, not merely by being set.
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, window: 'month', limitCount: 2 })
    await service.consume(context(), { nanoUsd: 0n, tokens: 0, count: 1 })
    await expect(guard.canActivate(executionContext(fixture.plain))).resolves.toBe(true)
  })
})
