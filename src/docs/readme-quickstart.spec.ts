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
import { LedgerService, MeteringService } from '../server/services'

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

describe('README Quick Start: record usage', () => {
  /**
   * Guards README section "3 — Record usage (post-hoc, observe-only)". The service above mirrors that
   * snippet argument for argument (the `usage` value, the preset, the context, the model id), so when
   * the README example changes, change this test with it. The model must be one the default price seed
   * covers, because `pricing.strict` is on by default and an unpriced model throws.
   */
  it('rates the response the Quick Start passes to record()', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRoot({ store: makeStore() })],
      providers: [WorkoutAiService],
    }).compile()
    await moduleRef.init()

    const content = await moduleRef.get(WorkoutAiService).generate('tenant-1', 'user-1', 'job-1')
    const records = await moduleRef.get(LedgerService).query({ tenantId: 'tenant-1' })

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
})
