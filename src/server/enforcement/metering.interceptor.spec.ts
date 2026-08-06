import { Logger } from '@nestjs/common'
import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { lastValueFrom, of, throwError } from 'rxjs'
import type { AiTokensErrorResponse, BudgetStatus, NormalizedUsage } from '../../shared'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import type { ResolvedAiTokensOptions } from '../config'
import type { MeteringContext } from '../interfaces'
import type { AiTokensException } from '../errors'
import { BudgetService, LedgerService, MarkupResolver, MeteringService, PricingService, WalletService } from '../services'
import type { RequestAiTokens } from './budget.guard'
import { providerPresets } from '../config/provider-presets'
import { Meter } from './decorators'
import { MeteringInterceptor } from './metering.interceptor'

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** A complete normalized usage (1000-in / 500-out gpt-5 chat). */
function normalized(): NormalizedUsage {
  return { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0 }
}

const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply' }

/** A controller carrying `@Meter` variants. */
class Fixture {
  @Meter({ feature: 'chat.reply', exposeHeaders: true })
  withHeaders(): unknown {
    return { usage: normalized() }
  }

  @Meter({ feature: 'chat.reply' })
  metered(): unknown {
    return { usage: normalized() }
  }

  @Meter({ feature: 'chat.reply', extract: (r) => (r as { u: unknown }).u })
  customExtract(): unknown {
    return { u: normalized() }
  }

  @Meter({ feature: 'chat.reply' })
  noUsage(): unknown {
    return { nothing: true }
  }

  @Meter({ feature: 'chat.reply', isSystemCost: true, tags: ['audit'] })
  systemCost(): unknown {
    return { usage: normalized() }
  }

  @Meter({ feature: 'chat.reply', preset: providerPresets.openaiChat, extract: (r) => r })
  presetMetered(): unknown {
    return { model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 500 } }
  }

  plain(): unknown {
    return 'raw'
  }
}

const fixture = new Fixture()

/** Build a MeteringService over in-memory stores (wallets + budgets on). */
function makeMetering(scopeResolver?: ResolvedAiTokensOptions['scopeResolver']): { metering: MeteringService; wallets: WalletService; options: ResolvedAiTokensOptions; pricingStore: InMemoryPricingStore } {
  const now = (): Date => new Date()
  const options = {
    ratingMode: 'rate-table',
    markup: 1,
    ledger: { hashChain: false },
    pricing: { strict: false, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    wallets: { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    budgets: { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true },
    scopeResolver,
  } as unknown as ResolvedAiTokensOptions
  const ledger = new LedgerService(new InMemoryLedgerStore(), options)
  const pricingStore = new InMemoryPricingStore()
  const wallets = new WalletService(new InMemoryWalletStore({ now }), options.wallets as never)
  const budgets = new BudgetService(new InMemoryBudgetStore({ now }), ledger, options.budgets as never, now)
  const metering = new MeteringService(ledger, new PricingService(options, pricingStore), new MarkupResolver(options), options, undefined, wallets, budgets, now)
  return { metering, wallets, options, pricingStore }
}

/** Seed the gpt-5 price so rating is non-zero. */
async function seed(store: InMemoryPricingStore): Promise<void> {
  await store.upsertPrice({ provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1_250_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
}

/** A mock execution context bound to a handler, request, and response. */
function executionContext(handler: () => unknown, request: Record<string, unknown> = {}, response: unknown = {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Fixture,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext
}

/** A CallHandler resolving to `value`. */
function handlerOf(value: unknown): CallHandler {
  return { handle: () => of(value) }
}

/** A budget status with the given nano-USD remaining (undefined = a token-only budget). */
function status(remainingNanoUsd?: bigint): BudgetStatus {
  return { budgetId: 'b1', window: 'month', windowStart: new Date(), resetsAt: null, policy: 'block', limit: { nanoUsd: 100_000_000n }, spent: { nanoUsd: 0n, tokens: 0, count: 0 }, remaining: remainingNanoUsd === undefined ? { tokens: 5 } : { nanoUsd: remainingNanoUsd }, usedFraction: 0 }
}

describe('MeteringInterceptor', () => {
  /** A handler with no @Meter is passed through untouched. */
  it('passes through a handler without @Meter', async () => {
    const { metering } = makeMetering()
    const interceptor = new MeteringInterceptor(new Reflector(), metering, {})
    const result = await lastValueFrom(interceptor.intercept(executionContext(fixture.plain), handlerOf('raw')))
    expect(result).toBe('raw')
  })

  /** The guard's hold is captured with the handler's usage; all three headers are set. */
  it('captures the guard hold and exposes headers', async () => {
    const built = makeMetering()
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const hold = await built.metering.hold(CONTEXT, { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 })
    const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [status(42n), status(100n), status()], context: CONTEXT, hold } }
    const headers = new Map<string, string>()
    const response = { setHeader: (name: string, value: string): void => void headers.set(name, value) }
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, {})
    const result = await lastValueFrom(interceptor.intercept(executionContext(fixture.withHeaders, request, response), handlerOf({ usage: normalized() })))
    expect((result as { usage: NormalizedUsage }).usage.provider).toBe('openai')
    expect(headers.get('x-ai-tokens-cost')).toBe('6250000')
    expect(headers.get('x-ai-tokens-billed-cost')).toBe('6250000')
    expect(headers.get('x-ai-tokens-budget-remaining')).toBe('42')
  })

  /** Without a guard hold, the interceptor records enforcing post-hoc via scopeResolver. */
  it('records enforcing when no guard ran', async () => {
    const built = makeMetering(() => CONTEXT)
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    await lastValueFrom(interceptor.intercept(executionContext(fixture.metered), handlerOf({ usage: normalized() })))
    expect((await built.wallets.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
  })

  /** A custom extract pulls usage from a non-default field. */
  it('uses a custom extract', async () => {
    const built = makeMetering(() => CONTEXT)
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    const result = await lastValueFrom(interceptor.intercept(executionContext(fixture.customExtract), handlerOf({ u: normalized() })))
    expect(result).toEqual({ u: normalized() })
  })

  /** A handler returning no extractable usage fails as USAGE_MALFORMED. */
  it('rejects a result with no extractable usage', async () => {
    const built = makeMetering(() => CONTEXT)
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.noUsage), handlerOf({ nothing: true }))).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** A handler error with a hold releases it and rethrows the ORIGINAL error. */
  it('releases the hold and rethrows on a handler error', async () => {
    const built = makeMetering()
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const hold = await built.metering.hold(CONTEXT, { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 })
    const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [], context: CONTEXT, hold } }
    const boom = new Error('handler exploded')
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, {})
    const handler: CallHandler = { handle: () => throwError(() => boom) }
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.metered, request), handler)).catch((e: unknown) => e)
    expect(error).toBe(boom)
    expect((await built.wallets.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** A failing release during error handling is swallowed; the original error still propagates. */
  it('rethrows the original error even when release fails', async () => {
    const built = makeMetering()
    const hold = { id: 'h', tenantId: 'tenant-1', scope: { type: 'user' as const, id: 'u1' }, estimatedTokens: 1, estimatedCostNanoUsd: 1n, expiresAt: new Date() }
    jest.spyOn(built.metering, 'release').mockRejectedValue(new Error('release down'))
    const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [], context: CONTEXT, hold } }
    const boom = new Error('handler exploded')
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, {})
    const handler: CallHandler = { handle: () => throwError(() => boom) }
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.metered, request), handler)).catch((e: unknown) => e)
    expect(error).toBe(boom)
  })

  /** A handler error with no hold rethrows unchanged. */
  it('rethrows a handler error without a hold', async () => {
    const built = makeMetering(() => CONTEXT)
    const boom = new Error('no hold error')
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    const handler: CallHandler = { handle: () => throwError(() => boom) }
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.metered), handler)).catch((e: unknown) => e)
    expect(error).toBe(boom)
  })

  /** An isSystemCost @Meter records without touching the wallet. */
  it('records an isSystemCost handler without wallet movement', async () => {
    const built = makeMetering(() => CONTEXT)
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    await lastValueFrom(interceptor.intercept(executionContext(fixture.systemCost), handlerOf({ usage: normalized() })))
    expect((await built.wallets.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(100_000_000n)
  })

  /** Headers fall back to a Fastify-style `header()` method; no budget → no remaining header. */
  it('writes headers via header() and omits an absent budget remaining', async () => {
    const built = makeMetering(() => CONTEXT)
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const headers = new Map<string, string>()
    const response = { header: (name: string, value: string): void => void headers.set(name, value) }
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    await lastValueFrom(interceptor.intercept(executionContext(fixture.withHeaders, {}, response), handlerOf({ usage: normalized() })))
    expect(headers.get('x-ai-tokens-cost')).toBe('6250000')
    expect(headers.has('x-ai-tokens-budget-remaining')).toBe(false)
  })

  /** Without a guard AND without a scopeResolver, the interceptor fails with INVALID_CONFIG. */
  it('fails without a guard or a scopeResolver', async () => {
    const built = makeMetering()
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, {})
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.metered), handlerOf({ usage: normalized() }))).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A guard that ran WITHOUT placing a hold falls through to a post-hoc record with its context. */
  it('records via the guard context when no hold was placed', async () => {
    const built = makeMetering()
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [], context: CONTEXT } }
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, {})
    await lastValueFrom(interceptor.intercept(executionContext(fixture.metered, request), handlerOf({ usage: normalized() })))
    expect((await built.wallets.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
  })

  /** The @Meter preset normalizes the raw handler result on the no-guard record path. */
  it('applies the @Meter preset on the record path', async () => {
    const built = makeMetering(() => CONTEXT)
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    await lastValueFrom(interceptor.intercept(executionContext(fixture.presetMetered), handlerOf({ model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 500 } })))
    expect((await built.wallets.getBalance({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' })).nanoUsd).toBe(93_750_000n)
  })

  /** A non-object handler result carries no default-extractable usage. */
  it('rejects a non-object result', async () => {
    const built = makeMetering(() => CONTEXT)
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.metered), handlerOf('a string'))).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /**
   * A null handler result (the extract function returns undefined for null, which then throws USAGE_MALFORMED).
   * With the LogicalOperator mutation (&&→||): `null.usage` throws a TypeError instead; test distinguishes this.
   * With CE→true on `value !== null`: `typeof null === 'object' && true` extracts `null.usage` → TypeError, not USAGE_MALFORMED.
   */
  it('rejects a null result with USAGE_MALFORMED (not a TypeError)', async () => {
    const built = makeMetering(() => CONTEXT)
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.metered), handlerOf(null))).catch((e: unknown) => e)
    // Must be an AiTokensException with code USAGE_MALFORMED, not a raw TypeError
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /**
   * A handler result whose extracted usage is EXPLICITLY null (`{ usage: null }`, not
   * merely absent) must fail as USAGE_MALFORMED at the extract guard. This kills the L144
   * ConditionalExpression `usage === null → false`: with that mutant the null slips past
   * the guard into `record()`, which (no preset) throws AI_TOKENS_UNKNOWN_PROVIDER instead
   * — a different code. The existing null-result test only reaches this via an undefined
   * extraction, so the `usage === null` operand is never the deciding branch there.
   */
  it('rejects an explicitly null extracted usage with USAGE_MALFORMED', async () => {
    const built = makeMetering(() => CONTEXT)
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    // The default extractor returns `.usage` (= null) for this object, so `usage` is null at the guard.
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.metered), handlerOf({ usage: null }))).catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_USAGE_MALFORMED')
  })

  /** minBudgetRemaining picks the SMALLEST remaining — the first status is NOT always the minimum. */
  it('uses the MINIMUM remaining across statuses when the minimum is not first', async () => {
    // statuses ordered DESCENDING so CE→false (only-update-when-min-undefined) gives 100 instead of 42.
    const built = makeMetering()
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const hold = await built.metering.hold(CONTEXT, { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 })
    // Largest first, smallest second — kills CE→false on `remaining < min`
    const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [status(100n), status(42n), status()], context: CONTEXT, hold } }
    const headers = new Map<string, string>()
    const response = { setHeader: (name: string, value: string): void => void headers.set(name, value) }
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, {})
    await lastValueFrom(interceptor.intercept(executionContext(fixture.withHeaders, request, response), handlerOf({ usage: normalized() })))
    expect(headers.get('x-ai-tokens-budget-remaining')).toBe('42')
  })

  /** minBudgetRemaining with no statuses having nanoUsd emits no header. */
  it('omits the budget-remaining header when no status has a nanoUsd remaining', async () => {
    const built = makeMetering()
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const hold = await built.metering.hold(CONTEXT, { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 })
    // All statuses have token-only remaining (no nanoUsd) — kills CE→true on remaining !== undefined
    const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [status(), status()], context: CONTEXT, hold } }
    const headers = new Map<string, string>()
    const response = { setHeader: (name: string, value: string): void => void headers.set(name, value) }
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, {})
    await lastValueFrom(interceptor.intercept(executionContext(fixture.withHeaders, request, response), handlerOf({ usage: normalized() })))
    expect(headers.has('x-ai-tokens-budget-remaining')).toBe(false)
  })

  /** A response exposing no header method silently drops the headers (never throws). */
  it('tolerates a response with no header method', async () => {
    const built = makeMetering(() => CONTEXT)
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    await expect(lastValueFrom(interceptor.intercept(executionContext(fixture.withHeaders, {}, {}), handlerOf({ usage: normalized() })))).resolves.toBeDefined()
  })

  /**
   * `exposeHeaders: true` must be EXPLICITLY set — absent or false must NOT write cost headers.
   * Kills CE→true mutation on `config.exposeHeaders === true` (always writes headers).
   */
  it('does not write cost headers when exposeHeaders is not set', async () => {
    const built = makeMetering(() => CONTEXT)
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    const headers = new Map<string, string>()
    const response = { setHeader: (name: string, value: string): void => void headers.set(name, value) }
    // fixture.metered has no exposeHeaders — cost headers must be absent
    await lastValueFrom(interceptor.intercept(executionContext(fixture.metered, {}, response), handlerOf({ usage: normalized() })))
    expect(headers.has('x-ai-tokens-cost')).toBe(false)
    expect(headers.has('x-ai-tokens-billed-cost')).toBe(false)
  })

  /**
   * `@Meter.tags` must reach the recorded context on the no-guard record path.
   * Kills the EqualityOperator (`config.tags !== undefined` → `=== undefined`) and
   * ObjectLiteral (`{ tags: config.tags }` → `{}`) mutants: either drops the tags,
   * so `record()` would be called with a context carrying no `tags`.
   */
  it('carries @Meter tags into the recorded context', async () => {
    const built = makeMetering(() => CONTEXT)
    await seed(built.pricingStore)
    await built.wallets.grant({ tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }, { amountNanoUsd: 100_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const recordSpy = jest.spyOn(built.metering, 'record')
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, { scopeResolver: () => CONTEXT })
    // fixture.systemCost carries tags: ['audit']
    await lastValueFrom(interceptor.intercept(executionContext(fixture.systemCost), handlerOf({ usage: normalized() })))
    expect(recordSpy).toHaveBeenCalledTimes(1)
    const [firstCall] = recordSpy.mock.calls
    expect(firstCall?.[0].context.tags).toEqual(['audit'])
    recordSpy.mockRestore()
  })

  /**
   * When the hold release fails after a handler error, the interceptor logs a
   * best-effort warning naming the hold. Kills the BlockStatement mutant that empties
   * the `.catch()` body: with an empty body no warning is emitted, yet the original
   * error still propagates (so the error assertion alone cannot observe the mutation).
   */
  it('logs a warning when the hold release fails after a handler error', async () => {
    const built = makeMetering()
    const hold = { id: 'h', tenantId: 'tenant-1', scope: { type: 'user' as const, id: 'u1' }, estimatedTokens: 1, estimatedCostNanoUsd: 1n, expiresAt: new Date() }
    jest.spyOn(built.metering, 'release').mockRejectedValue(new Error('release down'))
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const request: { aiTokens?: RequestAiTokens } = { aiTokens: { status: [], context: CONTEXT, hold } }
    const boom = new Error('handler exploded')
    const interceptor = new MeteringInterceptor(new Reflector(), built.metering, {})
    const handler: CallHandler = { handle: () => throwError(() => boom) }
    const error = await lastValueFrom(interceptor.intercept(executionContext(fixture.metered, request), handler)).catch((e: unknown) => e)
    expect(error).toBe(boom)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to release hold h'))
    warnSpy.mockRestore()
  })
})
