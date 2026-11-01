/**
 * @fileoverview Runs the README "Record usage (post-hoc, observe-only)" Quick Start flow. The
 * published-surface gate only type-checks the snippet, and `usage` is typed `unknown`, so a wrong
 * argument shape or an unpriced model in the example compiles and fails at run time.
 * @layer docs
 */
import { Inject, Injectable } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { InMemoryLedgerStore } from '../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../test/fakes/in-memory-pricing-store'
import { deriveIdempotencyKey } from '../shared'
import { BymaxAiTokensModule } from '../server/bymax-ai-tokens.module'
import { providerPresets } from '../server/config/provider-presets'
import type { IAiTokensStore } from '../server/interfaces'
import { AiTokensException } from '../server/errors'
import { LedgerService, MeteringService, PricingService } from '../server/services'

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

  async generate(tenantId: string, userId: string, jobId: string, startedAt: Date): Promise<string | undefined> {
    const res = await this.openai.chat.completions.create()
    await this.metering.record({
      usage: res,
      preset: providerPresets.openaiChat,
      occurredAt: startedAt,
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

const STARTED_AT = new Date('2026-06-01T12:00:00.000Z')

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

    const content = await workout.generate('tenant-1', 'user-1', 'job-1', STARTED_AT)
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

  /** The README calls this call retry-safe: repeating it, `occurredAt` included, stores nothing new. */
  it('stores one record when the Quick Start call is retried', async () => {
    const { workout, ledger } = await bootQuickStart()

    await workout.generate('tenant-1', 'user-1', 'job-1', STARTED_AT)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(workout.generate('tenant-1', 'user-1', 'job-1', STARTED_AT)).resolves.toBe('Squat 3x5.')

    expect(await ledger.query({ tenantId: 'tenant-1' })).toHaveLength(1)
  })

  /** The README says a retry that leaves out the repeated `occurredAt`, or follows a price change, conflicts. */
  it.each([
    ['a different occurredAt', async (_pricing: PricingService): Promise<Date> => Promise.resolve(new Date(STARTED_AT.getTime() + 5))],
    [
      'a price change',
      async (pricing: PricingService): Promise<Date> => {
        await pricing.upsertPrice({
          provider: 'openai',
          model: 'gpt-5-mini',
          operation: 'chat',
          serviceTier: 'standard',
          inputNanoUsdPerMillion: 2_000_000_000n,
          outputNanoUsdPerMillion: 10_000_000_000n,
          effectiveFrom: new Date('2026-02-01T00:00:00.000Z'),
        })
        return STARTED_AT
      },
    ],
  ])('rejects a retry after %s with a conflict instead of a second charge', async (_name, change) => {
    const { workout, ledger, pricing } = await bootQuickStart()
    await workout.generate('tenant-1', 'user-1', 'job-1', STARTED_AT)

    const retryAt = await change(pricing)
    const error = await workout.generate('tenant-1', 'user-1', 'job-1', retryAt).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AiTokensException)
    expect(await ledger.query({ tenantId: 'tenant-1' })).toHaveLength(1)
  })
})
