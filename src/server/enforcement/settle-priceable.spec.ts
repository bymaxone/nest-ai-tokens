/**
 * @fileoverview The settle preflight on its own: the identity it asks the price list about (tier, model chain) and the guard built by hand without a pricing service.
 * @layer server
 */
import { Reflector } from '@nestjs/core'
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host'
import type { ResolvedAiTokensOptions } from '../config'
import { providerPresets } from '../config/provider-presets'
import { AiTokensException } from '../errors'
import type { MeteringContext } from '../interfaces'
import { BudgetService, LedgerService, MarkupResolver, MeteringService, PricingService } from '../services'
import { InMemoryBudgetStore } from '../../../test/fakes/in-memory-budget-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { BudgetGuard } from './budget.guard'
import { Meter, RequireBudget } from './decorators'
import { assertSettlePriceable } from './settle-priceable'

const context: MeteringContext & { preset: typeof providerPresets.openaiChat } = {
  tenantId: 't1',
  scope: { type: 'user', id: 'u1' },
  feature: 'f',
  preset: providerPresets.openaiChat,
}

function world(
  aliases: Record<string, string> = {},
  strict = true,
  extra: readonly { provider: string; model: string }[] = [],
): { pricing: PricingService; options: ResolvedAiTokensOptions; prices: InMemoryPricingStore } {
  const options = { ratingMode: 'rate-table', markup: 1, holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 }, wallets: { enabled: false }, pricing: { strict, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: aliases } } as ResolvedAiTokensOptions
  const prices = new InMemoryPricingStore()
  void prices.seedPrice({ provider: 'openai', model: 'gpt-4o', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 2_500_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  for (const row of extra) void prices.seedPrice({ ...row, operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 1n, outputNanoUsdPerMillion: 1n, effectiveFrom: new Date(0) })
  return { pricing: new PricingService(options, prices), options, prices }
}

async function codeOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run
  } catch (error) {
    return error instanceof AiTokensException ? (error.getResponse() as { error: { code: string } }).error.code : 'other'
  }
  return undefined
}

describe('the settle preflight asks the price list the question capture() asks', () => {
  /** The settle rates the hold's tier, so a tier the price list has no row for is refused although the standard row exists. */
  it('refuses a baseModel whose service tier has no price', async () => {
    const { pricing, options } = world()
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'gpt-4o', serviceTier: 'priority' }, context.preset, pricing, options))).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** The same model on the standard tier is priced, so the tier is what decides the row above. */
  it('passes a baseModel on the standard tier', async () => {
    const { pricing, options } = world()
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'gpt-4o' }, context.preset, pricing, options))).toBeUndefined()
  })

  /** With no preset the provider is `unspecified`, which lists no model: a baseModel listed for another provider does not help. */
  it('refuses a baseModel when the context carries no preset', async () => {
    const { pricing, options } = world()
    const { preset: _preset, ...withoutPreset } = context
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...withoutPreset, baseModel: 'gpt-4o' }, undefined, pricing, options))).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A dated snapshot id resolves through the longest-prefix step of the chain, as the settle's rate lookup does. */
  it('passes a baseModel that only the prefix step of the model chain resolves', async () => {
    const { pricing, options } = world()
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'gpt-4o-2024-08-06' }, context.preset, pricing, options))).toBeUndefined()
  })

  /** A configured alias is a step of the same chain. */
  it('passes a baseModel that only the alias map resolves', async () => {
    const { pricing, options } = world({ 'my-gpt': 'gpt-4o' })
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'my-gpt' }, context.preset, pricing, options))).toBeUndefined()
  })
})

describe('a guard built by hand without a pricing service', () => {
  /** `new BudgetGuard(...)` with no fifth argument has no price list to ask: it places the hold and the settle's own rule applies. */
  it('skips the preflight under strict pricing and places the hold', async () => {
    const { pricing, options } = world()
    const ledger = new LedgerService(new InMemoryLedgerStore())
    const budgets = new BudgetService(new InMemoryBudgetStore(), ledger, { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true })
    const metering = new MeteringService(ledger, pricing, new MarkupResolver(options), options, undefined, undefined, budgets)
    const guard = new BudgetGuard(budgets, metering, new Reflector(), { ...options, scopeResolver: () => context })
    class Handler {
      run(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Handler.prototype, 'run')!
    RequireBudget({ estimate: { tokens: 10 } })(Handler.prototype, 'run', descriptor)
    Meter({ feature: 'f', preset: providerPresets.openaiChat })(Handler.prototype, 'run', descriptor)
    const request: { aiTokens?: { hold?: unknown } } = {}
    await expect(guard.canActivate(new ExecutionContextHost([request], Handler, Handler.prototype.run))).resolves.toBe(true)
    expect(request.aiTokens?.hold).toBeDefined()
  })
})

describe('what the preflight asks for when the context names less', () => {
  const { preset: _preset, ...bare } = context
  const none = (extra: readonly { provider: string; model: string }[]): ReturnType<typeof world> => world({}, true, extra)

  /** With no preset the hold's provider is `unspecified`, so a price list that names that provider prices the baseModel. */
  it('looks a baseModel up under the provider `unspecified` when there is no preset', async () => {
    const { pricing, options } = none([{ provider: 'unspecified', model: 'gpt-4o' }])
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...bare, baseModel: 'gpt-4o' }, undefined, pricing, options))).toBeUndefined()
  })

  /** With neither a preset nor a baseModel the hold's model is `unspecified`; a price list that names it prices the hold. */
  it('looks the model `unspecified` up when there is no baseModel', async () => {
    const { pricing, options } = none([{ provider: 'unspecified', model: 'unspecified' }])
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, bare, undefined, pricing, options))).toBeUndefined()
  })

  /** The same context against a list that lacks that row is refused, so the row above is what decides it. */
  it('refuses the model `unspecified` when the price list does not name it', async () => {
    const { pricing, options } = none([])
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, bare, undefined, pricing, options))).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** The refusal carries the reason that names the setting to change, as the whole of its details. */
  it('refuses with a reason that names baseModel and the way out', async () => {
    const { pricing, options } = none([])
    const error = await assertSettlePriceable({ tokens: 10 }, bare, undefined, pricing, options).catch((e: unknown) => e)
    expect((error as AiTokensException).getResponse()).toMatchObject({
      error: {
        details: {
          reason:
            'the settle of a { tokens } or { amountNanoUsd } estimate prices the model context.baseModel for the preset provider, and the price list has none for it; set baseModel to a model listed for it, or give the estimate its provider and model',
        },
      },
    })
  })

  /** Without strict pricing a miss is not an error, so the preflight asks the price list nothing. */
  it('does not ask the price list under non-strict pricing', async () => {
    const { pricing, options } = world({}, false)
    const asked = jest.spyOn(pricing, 'resolveRate')
    await assertSettlePriceable({ tokens: 10 }, { ...bare, baseModel: 'unlisted' }, undefined, pricing, options)
    expect(asked).not.toHaveBeenCalled()
  })

  /** An estimate that names its provider is rated from its own model, so the preflight does not ask either. */
  it('does not ask the price list for an estimate that names its provider', async () => {
    const { pricing, options } = world()
    const asked = jest.spyOn(pricing, 'resolveRate')
    await assertSettlePriceable({ provider: 'openai', model: 'unlisted', operation: 'chat', inputTokens: 1, maxOutputTokens: 1 }, bare, undefined, pricing, options)
    expect(asked).not.toHaveBeenCalled()
  })

  /** The preflight asks the question the hold asks, so the hold reads the price from the cache and the store is read once. */
  it('costs the store one read for a listed baseModel across the preflight and the hold', async () => {
    const { pricing, options, prices } = world()
    const reads = jest.spyOn(prices, 'resolveRate')
    await assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'gpt-4o' }, context.preset, pricing, options)
    await pricing.resolveRate({ provider: 'openai', model: 'gpt-4o', operation: 'chat', serviceTier: 'standard', at: new Date() })
    expect(reads).toHaveBeenCalledTimes(1)
  })
})

/** The guard as the interceptor's settle sees it: the rating mode comes from what `@Meter` names, the row's identity from the context the hold records. */
function guardOf(
  moduleMode: 'rate-table' | 'provider-reported',
  resolverPreset: typeof providerPresets.openaiChat,
  meterPreset?: typeof providerPresets.openaiChat,
): {
  metering: MeteringService
  request: { aiTokens?: { hold?: Parameters<MeteringService['capture']>[0] } }
  run: () => Promise<boolean>
} {
  const { pricing, options: base } = world()
  const options = { ...base, ratingMode: moduleMode }
  const ledger = new LedgerService(new InMemoryLedgerStore())
  const budgets = new BudgetService(new InMemoryBudgetStore(), ledger, { enabled: true, defaultPolicy: 'block', alertThresholds: [0.8, 1], failClosed: true })
  const metering = new MeteringService(ledger, pricing, new MarkupResolver(options), options, undefined, undefined, budgets)
  const guard = new BudgetGuard(budgets, metering, new Reflector(), { ...options, scopeResolver: () => ({ ...context, preset: resolverPreset }) }, pricing)
  class Handler {
    run(): void {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(Handler.prototype, 'run')!
  RequireBudget({ estimate: { amountNanoUsd: 5_000_000n } })(Handler.prototype, 'run', descriptor)
  Meter({ feature: 'f', ...(meterPreset !== undefined ? { preset: meterPreset } : {}) })(Handler.prototype, 'run', descriptor)
  const request: { aiTokens?: { hold?: Parameters<MeteringService['capture']>[0] } } = {}
  return { metering, request, run: () => guard.canActivate(new ExecutionContextHost([request], Handler, Handler.prototype.run)) }
}

describe('the guard decides from the preset the interceptor settles with', () => {
  /** The module is provider-reported and `@Meter` names no preset, so the settle bills the reported cost whatever preset the scope resolver supplied. */
  it('passes, and the settle posts, when only the scope resolver supplies a rate-table preset', async () => {
    const { metering, request, run } = guardOf('provider-reported', providerPresets.openaiChat)
    await expect(run()).resolves.toBe(true)
    const usage = { provider: 'x', model: 'x', operation: 'chat', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0, imageInTokens: 0, imageOutTokens: 0, providerReportedCostNanoUsd: 12_345n }
    const posted = await metering.capture(request.aiTokens!.hold!, context, usage, undefined)
    expect(posted.status).toBe('posted')
  })

  /** The module is rate-table and `@Meter` names no preset, so the settle rates from the table whatever mode the scope resolver's preset carries. */
  it('refuses when only the scope resolver supplies a provider-reported preset', async () => {
    const { run } = guardOf('rate-table', providerPresets.openrouter)
    expect(await codeOf(run())).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A preset `@Meter` names is the one the settle uses, so it decides the mode. */
  it('refuses when @Meter names a rate-table preset on a provider-reported module', async () => {
    const { run } = guardOf('provider-reported', providerPresets.openrouter, providerPresets.openaiChat)
    expect(await codeOf(run())).toBe('AI_TOKENS_INVALID_CONFIG')
  })
})
