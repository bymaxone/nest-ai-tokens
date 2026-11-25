/**
 * @fileoverview The settle preflight on its own: the identity it asks the price list about (tier, model chain) and the guard built by hand without a pricing service.
 * @layer server
 */
import { Reflector } from '@nestjs/core'
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

function world(aliases: Record<string, string> = {}): { pricing: PricingService; options: ResolvedAiTokensOptions } {
  const options = { ratingMode: 'rate-table', markup: 1, holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 }, wallets: { enabled: false }, pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: aliases } } as ResolvedAiTokensOptions
  const prices = new InMemoryPricingStore()
  void prices.seedPrice({ provider: 'openai', model: 'gpt-4o', operation: 'chat', serviceTier: 'standard', inputNanoUsdPerMillion: 2_500_000_000n, outputNanoUsdPerMillion: 10_000_000_000n, effectiveFrom: new Date(0) })
  return { pricing: new PricingService(options, prices), options }
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
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'gpt-4o', serviceTier: 'priority' }, pricing, options))).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** The same model on the standard tier is priced, so the tier is what decides the row above. */
  it('passes a baseModel on the standard tier', async () => {
    const { pricing, options } = world()
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'gpt-4o' }, pricing, options))).toBeUndefined()
  })

  /** With no preset the provider is `unspecified`, which lists no model: a baseModel listed for another provider does not help. */
  it('refuses a baseModel when the context carries no preset', async () => {
    const { pricing, options } = world()
    const { preset: _preset, ...withoutPreset } = context
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...withoutPreset, baseModel: 'gpt-4o' }, pricing, options))).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A dated snapshot id resolves through the longest-prefix step of the chain, as the settle's rate lookup does. */
  it('passes a baseModel that only the prefix step of the model chain resolves', async () => {
    const { pricing, options } = world()
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'gpt-4o-2024-08-06' }, pricing, options))).toBeUndefined()
  })

  /** A configured alias is a step of the same chain. */
  it('passes a baseModel that only the alias map resolves', async () => {
    const { pricing, options } = world({ 'my-gpt': 'gpt-4o' })
    expect(await codeOf(assertSettlePriceable({ tokens: 10 }, { ...context, baseModel: 'my-gpt' }, pricing, options))).toBeUndefined()
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
    const executionContext = { getHandler: () => Handler.prototype.run, getClass: () => Handler, switchToHttp: () => ({ getRequest: () => request }) }
    await expect(guard.canActivate(executionContext as never)).resolves.toBe(true)
    expect(request.aiTokens?.hold).toBeDefined()
  })
})
