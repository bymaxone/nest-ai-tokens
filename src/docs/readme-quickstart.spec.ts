/**
 * @fileoverview Runs the README "Record usage (post-hoc, observe-only)" Quick Start flow. The
 * published-surface gate only type-checks the snippet, and `usage` is typed `unknown`, so a wrong
 * argument shape or an unpriced model in the example compiles and fails at run time.
 * @layer docs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Inject, Injectable, Module } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { makeFullStore } from '../../test/fakes/full-store'
import { InMemoryLedgerStore } from '../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../test/fakes/in-memory-pricing-store'
import { deriveIdempotencyKey } from '../shared'
import { BymaxAiTokensModule } from '../server/bymax-ai-tokens.module'
import { providerPresets } from '../server/config/provider-presets'
import type { IAiTokensStore, MeteringContext } from '../server/interfaces'
import { LedgerService, MeteringService, PricingService, WalletService } from '../server/services'
import type { AiTokensException } from '../server/errors'

/** A store with working ledger and pricing halves; the wallet and budget halves are unused here. */
function makeStore(): IAiTokensStore {
  const ledger = new InMemoryLedgerStore()
  const pricing = new InMemoryPricingStore()
  const reject = (): Promise<never> => Promise.reject(new Error('feature not enabled'))
  return {
    append: ledger.append.bind(ledger),
    transition: ledger.transition.bind(ledger),
    findByIdempotencyKey: ledger.findByIdempotencyKey.bind(ledger),
    findById: ledger.findById.bind(ledger),
    findExpiredHolds: ledger.findExpiredHolds.bind(ledger),
    query: ledger.query.bind(ledger),
    sumCost: ledger.sumCost.bind(ledger),
    lastHash: ledger.lastHash.bind(ledger),
    resolveRate: pricing.resolveRate.bind(pricing),
    upsertPrice: pricing.upsertPrice.bind(pricing),
    seedPrice: pricing.seedPrice.bind(pricing),
    getPriceHistory: pricing.getPriceHistory.bind(pricing),
    listModels: pricing.listModels.bind(pricing),
    getWallet: reject,
    appendEntry: reject,
    conditionalDebit: reject,
    openGrants: reject,
    listEntries: reject,
    reconcile: reject,
    upsert: reject,
    remove: reject,
    findBudgetById: reject,
    findMatching: reject,
    conditionalConsume: reject,
    adjustWindow: reject,
    getWindow: reject,
    setWindowStart: reject,
  }
}

/** The shape of an OpenAI chat completion response, as the provider SDK returns it. */
const OPENAI_RESPONSE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-5-mini',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Squat 3x5.' } }],
  usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
}

/** The Quick Start service, with the provider client replaced by a stub that returns {@link OPENAI_RESPONSE}. */
@Injectable()
class WorkoutAiService {
  readonly openai = { chat: { completions: { create: (): Promise<typeof OPENAI_RESPONSE> => Promise.resolve(OPENAI_RESPONSE) } } }

  constructor(@Inject(MeteringService) private readonly metering: MeteringService) {}

  async generate(tenantId: string, userId: string, jobId: string): Promise<string | undefined> {
    const res = await this.openai.chat.completions.create()
    await this.metering.record({
      usage: res,
      preset: providerPresets.openaiChat,
      context: {
        tenantId,
        scope: { type: 'user', id: userId },
        feature: 'workout.generate',
        idempotencyKey: deriveIdempotencyKey({ jobId }),
      },
    })
    return res.choices[0]?.message.content
  }
}

/** Boot the Quick Start module over a fresh in-memory store. */
async function bootQuickStart(): Promise<{ workout: WorkoutAiService; ledger: LedgerService; pricing: PricingService }> {
  const moduleRef = await Test.createTestingModule({
    imports: [BymaxAiTokensModule.forRoot({ store: makeStore() })],
    providers: [WorkoutAiService],
  }).compile()
  await moduleRef.init()
  return { workout: moduleRef.get(WorkoutAiService), ledger: moduleRef.get(LedgerService), pricing: moduleRef.get(PricingService) }
}

describe('README Quick Start: record usage', () => {
  /**
   * Guards README section "3 — Record usage (post-hoc, observe-only)". The service above mirrors that
   * snippet argument for argument (the `usage` value, the preset, the context, the model id), so when
   * the README example changes, change this test with it. The model must be one the default price seed
   * covers, because `pricing.strict` is on by default and an unpriced model throws.
   */
  it('rates the response the Quick Start passes to record()', async () => {
    const { workout, ledger } = await bootQuickStart()

    const content = await workout.generate('tenant-1', 'user-1', 'job-1')
    const records = await ledger.query({ tenantId: 'tenant-1' })

    expect(content).toBe('Squat 3x5.')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5-mini',
      feature: 'workout.generate',
      inputTokens: 1000,
      outputTokens: 500,
      rawCostNanoUsd: 1_250_000n,
      priceMissing: false,
    })
  })

  /** The README calls this call retry-safe: a retry made later, with a different defaulted `occurredAt`, stores nothing new. */
  it('stores one record when the Quick Start call is retried', async () => {
    const { workout, ledger } = await bootQuickStart()

    await workout.generate('tenant-1', 'user-1', 'job-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(workout.generate('tenant-1', 'user-1', 'job-1')).resolves.toBe('Squat 3x5.')

    expect(await ledger.query({ tenantId: 'tenant-1' })).toHaveLength(1)
  })

  /** The README says a retry after a price change returns the original record at its original cost. */
  it('returns the original record when the price changed before the retry', async () => {
    const { workout, ledger, pricing } = await bootQuickStart()
    await workout.generate('tenant-1', 'user-1', 'job-1')
    await pricing.upsertPrice({
      provider: 'openai',
      model: 'gpt-5-mini',
      operation: 'chat',
      serviceTier: 'standard',
      inputNanoUsdPerMillion: 2_000_000_000n,
      outputNanoUsdPerMillion: 10_000_000_000n,
      effectiveFrom: new Date('2026-02-01T00:00:00.000Z'),
    })

    await expect(workout.generate('tenant-1', 'user-1', 'job-1')).resolves.toBe('Squat 3x5.')

    const records = await ledger.query({ tenantId: 'tenant-1' })
    expect(records).toHaveLength(1)
    expect(records[0]?.rawCostNanoUsd).toBe(1_250_000n)
  })
})

/** Stands in for the host's database module and service that section 2 injects. */
@Injectable()
class PrismaService {}

/** Stands in for the host's `PrismaModule`. */
@Module({ providers: [PrismaService], exports: [PrismaService] })
class PrismaModule {}

/** Boot the Quick Start module with wallets, budgets and the seeded prices, over the full in-memory store. */
async function bootRegistered(strict = true): Promise<{ metering: MeteringService; wallets: WalletService }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      BymaxAiTokensModule.forRoot({
        store: makeFullStore(),
        wallets: { creditRateNanoUsd: 5_000_000_000n },
        budgets: { defaultPolicy: 'block' },
        scopeResolver: () => ({ tenantId: 'tenant-1', scope: { type: 'user', id: 'user-1' }, feature: 'workout.generate' }),
        pricing: { seedFromSnapshot: true, strict },
      }),
    ],
  }).compile()
  await moduleRef.init()
  return { metering: moduleRef.get(MeteringService), wallets: moduleRef.get(WalletService) }
}

/** A request context for the default tenant and user; `over` replaces any field. */
function requestContext(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: 'tenant-1', scope: { type: 'user', id: 'user-1' }, feature: 'workout.generate', idempotencyKey: 'key-1', ...over }
}

describe('README Quick Start: register the module', () => {
  /**
   * Guards README section "2 — Register the module": the module the snippet declares must boot. The
   * factory below mirrors that snippet option for option, with the store replaced by an in-memory one.
   */
  it('boots the module the Quick Start registers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxAiTokensModule.forRootAsync({
          imports: [PrismaModule],
          inject: [PrismaService],
          useFactory: () => ({
            store: makeFullStore(),
            markup: 4.0,
            wallets: { creditRateNanoUsd: 5_000_000_000n },
            budgets: { defaultPolicy: 'block', alertThresholds: [0.8, 1.0] },
            scopeResolver: (ctx: ExecutionContext) => {
              const { user } = ctx.switchToHttp().getRequest<{ user: { tenantId: string; id: string } }>()
              return { tenantId: user.tenantId, scope: { type: 'user' as const, id: user.id }, feature: 'workout.generate' }
            },
            pricing: { seedFromSnapshot: true },
          }),
        }),
      ],
    }).compile()

    await expect(moduleRef.init()).resolves.toBeDefined()
    await moduleRef.close()
  })

  /** The factory above only stays the README's if the README still declares each option it uses. */
  it('declares in the README every option the booted module uses', () => {
    const readme = readFileSync(join(__dirname, '../../README.md'), 'utf8')
    const section = readme.slice(readme.indexOf('### 2 — Register the module'), readme.indexOf('### 3 — Record usage'))

    for (const option of ['markup:', 'wallets:', 'budgets:', 'scopeResolver:', 'pricing:']) expect(section).toContain(option)
  })
})

describe('README behaviours around record(), holds and prices', () => {
  const RESPONSE = { id: 'chatcmpl-1', model: 'gpt-5-mini', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }
  const VERCEL_RESULT = { text: 'hi', usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }, response: { modelId: 'gpt-5-mini' } }

  /** README section 3: a retry has to repeat `enforce`, and an omitted one counts as false. */
  it('replays a retry with the same enforce and refuses one with another', async () => {
    const { metering } = await bootRegistered()
    const first = await metering.record({ usage: RESPONSE, preset: providerPresets.openaiChat, context: requestContext({ enforce: false }) })

    const omitted = await metering.record({ usage: RESPONSE, preset: providerPresets.openaiChat, context: requestContext() })
    const flipped = await metering
      .record({ usage: RESPONSE, preset: providerPresets.openaiChat, context: requestContext({ enforce: true }) })
      .catch((error: unknown) => error)

    expect(omitted.id).toBe(first.id)
    expect((flipped as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_IDEMPOTENCY_CONFLICT' } })
  })

  /** README Providers Matrix: record() with vercelAiSdk has no provider, a hold sized with it is `openai`. */
  it('prices a vercelAiSdk token-sized hold and its capture as openai, and refuses a vercelAiSdk record', async () => {
    const { metering, wallets } = await bootRegistered()
    await wallets.grant(
      { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'user-1' },
      { amountNanoUsd: 50_000_000n, idempotencyKey: 'grant-1', reason: 'seed', effectiveAt: new Date(0) },
    )

    const hold = await metering.hold(requestContext({ idempotencyKey: 'hold-1', preset: providerPresets.vercelAiSdk, baseModel: 'gpt-5-mini' }), { tokens: 1500 })
    const captured = await metering.capture(hold, requestContext(), VERCEL_RESULT, providerPresets.vercelAiSdk)
    const recorded = await metering
      .record({ usage: VERCEL_RESULT, preset: providerPresets.vercelAiSdk, context: requestContext({ idempotencyKey: 'record-1' }) })
      .catch((error: unknown) => error)

    expect(captured).toMatchObject({ provider: 'openai', model: 'gpt-5-mini', status: 'posted' })
    expect((recorded as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_PRICE_NOT_FOUND' } })
  })

  /** README Providers Matrix: a price row belongs to one provider id, so the same model id under another provider has none. */
  it('does not price a model id from another provider\'s row', async () => {
    const { metering } = await bootRegistered()

    const refused = await metering
      .record({ usage: RESPONSE, preset: providerPresets.openaiCompatible('together'), context: requestContext() })
      .catch((error: unknown) => error)

    expect((refused as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_PRICE_NOT_FOUND', details: { provider: 'together', model: 'gpt-5-mini' } } })
  })
})
