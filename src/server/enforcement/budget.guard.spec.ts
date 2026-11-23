import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AiTokensErrorResponse, MeteringScope } from '../../shared'
import type { MeteringContext } from '../interfaces'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import { BudgetService, type BudgetServiceOptions, MarkupResolver, MeteringService, PricingService } from '../services'
import { LedgerService } from '../services/ledger.service'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { providerPresets } from '../config/provider-presets'
import type { RequestAiTokens } from './budget.guard'
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

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** Assert a promise rejects with a specific `AiTokensException` code. */
async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AiTokensException)
  expect(codeOf(thrown)).toBe(code)
}

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

describe('BudgetGuard', () => {
  /** A missing scopeResolver fails fast at construction. */
  it('rejects construction without a scopeResolver', () => {
    const service = new BudgetService(
      new InMemoryBudgetStore(),
      new LedgerService(new InMemoryLedgerStore()),
      { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true },
    )
    const ledger = new LedgerService(new InMemoryLedgerStore())
    expect(() => new BudgetGuard(service, makeMetering(ledger, service, () => NOW), new Reflector(), {})).toThrow(AiTokensException)
  })

  /** An exhausted hard cost budget blocks with 402 before the handler runs. */
  it('blocks on an exhausted cost budget (402)', async () => {
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, limitNanoUsd: 100n, window: 'month' })
    await service.consume(context(), { nanoUsd: 100n, tokens: 0, count: 0 })
    await expectRejectCode(guard.canActivate(executionContext(fixture.plain)), 'AI_TOKENS_BUDGET_EXCEEDED')
  })

  /** An exhausted token budget blocks with 429. */
  it('blocks on an exhausted token budget (429)', async () => {
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, limitTokens: 100, window: 'month' })
    await service.consume(context(), { nanoUsd: 0n, tokens: 100, count: 0 })
    await expectRejectCode(guard.canActivate(executionContext(fixture.plain)), 'AI_TOKENS_QUOTA_EXCEEDED')
  })

  /** An exhausted count budget blocks with 429. */
  it('blocks on an exhausted count budget (429)', async () => {
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, limitCount: 1, window: 'month' })
    await service.consume(context(), { nanoUsd: 0n, tokens: 0, count: 1 })
    await expectRejectCode(guard.canActivate(executionContext(fixture.plain)), 'AI_TOKENS_QUOTA_EXCEEDED')
  })

  /** With headroom the guard passes and enriches the request with status + context. */
  it('passes and enriches the request', async () => {
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, limitNanoUsd: 100n, window: 'month' })
    await service.consume(context(), { nanoUsd: 40n, tokens: 0, count: 0 })
    const request: Record<string, unknown> = {}
    await expect(guard.canActivate(executionContext(fixture.plain, request))).resolves.toBe(true)
    const enriched = request.aiTokens as { status: unknown[]; context: MeteringContext }
    expect(enriched.status).toHaveLength(1)
    expect(enriched.context.feature).toBe('default.feat')
  })

  /** A soft (allow) budget over its limit does not block. */
  it('does not block a soft budget', async () => {
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, policy: 'allow', limitNanoUsd: 100n, window: 'month' })
    await service.consume(context(), { nanoUsd: 150n, tokens: 0, count: 0 })
    await expect(guard.canActivate(executionContext(fixture.plain))).resolves.toBe(true)
  })

  /**
   * A hard budget with an EMPTY features array applies to every feature (empty = all).
   * Kills CE→false on the `features.length === 0` operand of `featureMatches`: with it
   * forced false, an empty-features budget would be treated as non-matching and ignored
   * instead of blocking, so the guard would wrongly allow the exhausted call.
   */
  it('blocks on an exhausted budget with an empty features filter', async () => {
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, features: [], limitNanoUsd: 100n, window: 'month' })
    await service.consume(context(), { nanoUsd: 100n, tokens: 0, count: 0 })
    await expectRejectCode(guard.canActivate(executionContext(fixture.plain)), 'AI_TOKENS_BUDGET_EXCEEDED')
  })

  /** A budget whose feature filter excludes the request feature is ignored. */
  it('ignores a budget for another feature', async () => {
    const { guard, service } = makeGuard(context({ feature: 'other.feat' }))
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, features: ['workout.generate'], limitNanoUsd: 100n, window: 'month' })
    await service.consume(context({ feature: 'workout.generate' }), { nanoUsd: 100n, tokens: 0, count: 0 })
    await expect(guard.canActivate(executionContext(fixture.plain))).resolves.toBe(true)
  })

  /** @Meter.feature wins over @AiFeature: the guard checks the meter feature's budget. */
  it('applies @Meter.feature over @AiFeature', async () => {
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, features: ['meter.feat'], limitNanoUsd: 100n, window: 'month' })
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, features: ['ai.feat'], limitNanoUsd: 100n, window: 'month' })
    await service.consume(context({ feature: 'meter.feat' }), { nanoUsd: 100n, tokens: 0, count: 0 })
    await expectRejectCode(guard.canActivate(executionContext(fixture.metered)), 'AI_TOKENS_BUDGET_EXCEEDED')
  })

  /** @RequireBudget.feature wins over @Meter.feature. */
  it('applies @RequireBudget.feature over @Meter.feature', async () => {
    const { guard, service } = makeGuard()
    await service.upsertBudget({ tenantId: TENANT, scope: USER_SCOPE, features: ['req.feat'], limitNanoUsd: 100n, window: 'month' })
    await service.consume(context({ feature: 'req.feat' }), { nanoUsd: 100n, tokens: 0, count: 0 })
    await expectRejectCode(guard.canActivate(executionContext(fixture.required)), 'AI_TOKENS_BUDGET_EXCEEDED')
  })

  /** A bare @RequireBudget() with no config falls back to the context feature and passes. */
  it('falls back to the context feature for a bare @RequireBudget', async () => {
    const { guard } = makeGuard()
    await expect(guard.canActivate(executionContext(fixture.bare))).resolves.toBe(true)
  })

  /** A @RequireBudget with an estimate places a hold and attaches it to the request. */
  it('places a hold for a @RequireBudget estimate', async () => {
    const { guard, ledgerStore } = makeGuard()
    const request: { aiTokens?: RequestAiTokens } = {}
    await guard.canActivate(executionContext(fixture.withEstimate, request))
    expect(request.aiTokens?.hold?.estimatedCostNanoUsd).toBe(5_000_000n)
    expect(ledgerStore.all().filter((r) => r.status === 'pending')).toHaveLength(1)
  })

  /** A @Meter preset flows into the hold context for a { tokens } estimate. */
  it('carries the @Meter preset into the placed hold', async () => {
    const { guard } = makeGuard()
    const request: { aiTokens?: RequestAiTokens } = {}
    await guard.canActivate(executionContext(fixture.withPresetEstimate, request))
    expect(request.aiTokens?.hold).toBeDefined()
    expect(request.aiTokens?.context.preset?.provider).toBe('openai')
  })
})

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it, whatever `run` does. */
async function planted<T>(key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('BudgetGuard reads the decorators of a handler as the handler\'s own', () => {
  /** A key on Object.prototype named like an option of @RequireBudget is not one: it places no hold and re-attributes nothing. */
  it('places no hold for a handler without an estimate when estimate is planted on Object.prototype', async () => {
    const { guard, ledgerStore } = makeGuard()
    const request: { aiTokens?: RequestAiTokens } = {}
    await planted('estimate', { amountNanoUsd: 5_000_000n }, () => guard.canActivate(executionContext(fixture.bare, request)))
    expect(request.aiTokens?.hold).toBeUndefined()
    expect(await ledgerStore.query({ tenantId: TENANT })).toEqual([])
  })

  it('keeps the feature of the context for a handler that names none when feature is planted', async () => {
    const { guard } = makeGuard()
    const request: { aiTokens?: RequestAiTokens } = {}
    await planted('feature', 'planted.feat', () => guard.canActivate(executionContext(fixture.bare, request)))
    expect(request.aiTokens?.context.feature).toBe('default.feat')
  })

  it('carries no preset into the context of a handler that declares none when preset is planted', async () => {
    const { guard } = makeGuard()
    const request: { aiTokens?: RequestAiTokens } = {}
    await planted('preset', providerPresets.openaiChat, () => guard.canActivate(executionContext(fixture.required, request)))
    expect(request.aiTokens?.context.preset).toBeUndefined()
  })

  /** What the handler declared still wins over a planted key. */
  it('still places the hold a handler declares when a different estimate is planted', async () => {
    const { guard } = makeGuard()
    const request: { aiTokens?: RequestAiTokens } = {}
    await planted('estimate', { amountNanoUsd: 1n }, () => guard.canActivate(executionContext(fixture.withEstimate, request)))
    expect(request.aiTokens?.hold?.estimatedCostNanoUsd).toBe(5_000_000n)
  })
})

