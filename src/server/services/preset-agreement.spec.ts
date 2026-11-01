/**
 * @fileoverview Pins that every provider preset names the provider its normalizer stamps, and that
 * `record()` and a hold followed by `capture()` store the same provider and model and rate the same
 * call. A hold reads `preset.provider` while a record reads the normalizer's, so the two must be
 * the same id for both paths to select the same price rows.
 * @layer server
 */
import { Test } from '@nestjs/testing'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import type { AiTokensErrorResponse, ProviderPreset, UsageRecord } from '../../shared'
import { BymaxAiTokensModule } from '../bymax-ai-tokens.module'
import { providerPresets } from '../config/provider-presets'
import { AiTokensException } from '../errors'
import type { IAiTokensStore, MeteringContext } from '../interfaces'
import type { LedgerAppendInput } from './ledger.service'
import { LedgerService } from './ledger.service'
import { MeteringService } from './metering.service'

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

/** A raw provider response and the seeded model id it carries. */
interface Sample {
  raw: unknown
  model: string
}

const OPENAI_CHAT = { model: 'gpt-5-mini', usage: { prompt_tokens: 1000, completion_tokens: 500 } }

/** One priced sample per preset whose seeded provider matches the provider its normalizer stamps. */
const PRICED: [string, ProviderPreset, Sample][] = [
  ['openaiChat', providerPresets.openaiChat, { raw: OPENAI_CHAT, model: 'gpt-5-mini' }],
  ['openaiResponses', providerPresets.openaiResponses, { raw: { model: 'gpt-5-mini', usage: { input_tokens: 1000, output_tokens: 500 } }, model: 'gpt-5-mini' }],
  ['azureOpenai', providerPresets.azureOpenai, { raw: OPENAI_CHAT, model: 'gpt-5-mini' }],
  ['anthropic', providerPresets.anthropic, { raw: { model: 'claude-sonnet-4', usage: { input_tokens: 1000, output_tokens: 500 } }, model: 'claude-sonnet-4' }],
  ['gemini', providerPresets.gemini, { raw: { modelVersion: 'gemini-2.5-flash', usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 } }, model: 'gemini-2.5-flash' }],
  ['vertex', providerPresets.vertex, { raw: { modelVersion: 'gemini-2.5-flash', usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 } }, model: 'gemini-2.5-flash' }],
  ['mistral', providerPresets.mistral, { raw: { model: 'mistral-large-latest', usage: { prompt_tokens: 1000, completion_tokens: 500 } }, model: 'mistral-large-latest' }],
  ['openaiCompatible("deepseek")', providerPresets.openaiCompatible('deepseek'), { raw: { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 500 } }, model: 'deepseek-chat' }],
]

const CONTEXT: MeteringContext = { tenantId: 'tenant-1', scope: { type: 'user', id: 'user-1' }, feature: 'agreement' }

/** Boot a module over a fresh store and return its metering service. */
async function boot(strict: boolean, store: IAiTokensStore = makeStore()): Promise<{ metering: MeteringService; ledger: LedgerService; store: IAiTokensStore }> {
  const moduleRef = await Test.createTestingModule({ imports: [BymaxAiTokensModule.forRoot({ store, pricing: { strict } })] }).compile()
  await moduleRef.init()
  return { metering: moduleRef.get(MeteringService), ledger: moduleRef.get(LedgerService), store }
}

/** Settle a call through hold then capture, sized by a bare token count. */
async function holdCapture(metering: MeteringService, context: MeteringContext, preset: ProviderPreset, raw: unknown): Promise<UsageRecord> {
  const hold = await metering.hold({ ...context, preset }, { tokens: 1500 })
  return metering.capture(hold, raw, preset)
}

describe('every preset names the provider its normalizer stamps', () => {
  /**
   * Guards the hold path, which reads `preset.provider`, against the record path, which reads the
   * provider the normalizer stamped. Any preset where the two differ prices one path from rows the
   * other never reads.
   */
  it.each(PRICED)('%s', (_name, preset, sample) => {
    expect(preset.normalizer(sample.raw).provider).toBe(preset.provider)
  })

  /**
   * `vercelAiSdk` is the one deliberate exception: its normalizer cannot know which vendor ran the
   * call, and a fixed `openai` filled into an Anthropic or Google call would price it from the wrong
   * rows, so the record's provider stays empty and the call fails loudly instead.
   */
  it('leaves the vercelAiSdk record provider empty on purpose', () => {
    const usage = providerPresets.vercelAiSdk.normalizer({ usage: { inputTokens: 1, outputTokens: 1 }, model: 'claude-sonnet-4' })
    expect(usage.provider).toBe('')
  })
})

describe('record() and hold + capture agree per preset', () => {
  /**
   * Both paths must store the same provider and model and price the call from the same row, with the
   * model resolved by `baseModel` on the hold side exactly as `record()` resolves it from the response.
   */
  it.each(PRICED)('%s', async (_name, preset, sample) => {
    const recorded = await (await boot(true)).metering.record({ usage: sample.raw, preset, context: CONTEXT })
    const settled = await holdCapture((await boot(true)).metering, { ...CONTEXT, baseModel: sample.model }, preset, sample.raw)

    expect(recorded.priceMissing).toBe(false)
    expect(settled.priceMissing).toBe(false)
    expect({ provider: settled.provider, model: settled.model, raw: settled.rawCostNanoUsd }).toEqual({
      provider: recorded.provider,
      model: recorded.model,
      raw: recorded.rawCostNanoUsd,
    })
  })

  /** A Converse response has no model id, so the caller's `baseModel` names it on both paths. */
  it('bedrock: record() stamps baseModel as the model, as hold + capture does', async () => {
    const raw = { usage: { inputTokens: 1000, outputTokens: 500 } }
    const context: MeteringContext = { ...CONTEXT, baseModel: 'claude-sonnet-4-5' }
    const recorded = await (await boot(false)).metering.record({ usage: raw, preset: providerPresets.bedrock, context })
    const settled = await holdCapture((await boot(false)).metering, context, providerPresets.bedrock, raw)

    expect(recorded.model).toBe('claude-sonnet-4-5')
    expect(recorded.requestedModel).toBe('claude-sonnet-4-5')
    expect(settled.model).toBe(recorded.model)
    expect(settled.provider).toBe(recorded.provider)
  })

  /** Without a `baseModel` there is nothing to name the model after, so it stays empty. */
  it('bedrock: leaves the model empty when there is no baseModel', async () => {
    const { metering } = await boot(false)
    const record = await metering.record({ usage: { usage: { inputTokens: 1, outputTokens: 1 } }, preset: providerPresets.bedrock, context: CONTEXT })
    expect(record.model).toBe('')
    expect(record.requestedModel).toBeUndefined()
  })

  /** A response model, when the provider returns one, is never replaced by `baseModel`. */
  it('keeps the response model when the normalizer found one', async () => {
    const { metering } = await boot(false)
    const record = await metering.record({
      usage: { model: 'my-deployment', usage: { prompt_tokens: 10, completion_tokens: 5 } },
      preset: providerPresets.azureOpenai,
      context: { ...CONTEXT, baseModel: 'gpt-5-mini' },
    })
    expect(record.model).toBe('my-deployment')
    expect(record.requestedModel).toBe('gpt-5-mini')
  })
})

describe('openaiCompatible(id) records its own id', () => {
  /** The caller chose the id, so the record carries it and the seeded rows for that id price the call. */
  it('records provider deepseek and prices it from the seeded deepseek row', async () => {
    const { metering } = await boot(true)
    const record = await metering.record({
      usage: { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 500 } },
      preset: providerPresets.openaiCompatible('deepseek'),
      context: CONTEXT,
    })
    expect(record.provider).toBe('deepseek')
    expect(record.priceMissing).toBe(false)
    expect(record.rawCostNanoUsd).toBeGreaterThan(0n)
  })
})

describe('vercelAiSdk fails loudly instead of mispricing', () => {
  const usage = { model: 'claude-sonnet-4', usage: { inputTokens: 1000, outputTokens: 500 } }

  /** With `pricing.strict` on, a non-OpenAI model held through the preset is refused, never priced from an openai row. */
  it('refuses a {tokens} hold for a non-OpenAI model in strict mode', async () => {
    const { metering } = await boot(true)
    const error = await metering.hold({ ...CONTEXT, baseModel: 'claude-sonnet-4', preset: providerPresets.vercelAiSdk }, { tokens: 1500 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AiTokensException)
    expect(((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code).toBe('AI_TOKENS_PRICE_NOT_FOUND')
  })

  /** With strict off the same call captures as `priceMissing` at zero cost, never against an openai row. */
  it('captures it as priceMissing, not priced, when strict is off', async () => {
    const { metering } = await boot(false)
    const settled = await holdCapture(metering, { ...CONTEXT, baseModel: 'claude-sonnet-4' }, providerPresets.vercelAiSdk, usage)
    expect(settled.priceMissing).toBe(true)
    expect(settled.rawCostNanoUsd).toBe(0n)
  })

  /** The record path stamps no provider at all, so it can never match an openai row. */
  it('records an empty provider and prices nothing', async () => {
    const { metering } = await boot(false)
    const record = await metering.record({ usage, preset: providerPresets.vercelAiSdk, context: CONTEXT })
    expect(record.provider).toBe('')
    expect(record.priceMissing).toBe(true)
  })
})

describe('a Bedrock retry keeps the idempotency key of the row it repeats', () => {
  const raw = { usage: { inputTokens: 1000, outputTokens: 500 } }
  const occurredAt = new Date('2026-11-01T00:00:00.000Z')
  const context: MeteringContext = { ...CONTEXT, baseModel: 'claude-sonnet-4-5', idempotencyKey: 'bedrock-retry' }
  /** Fields a store assigns or a later transition changes; the rest is what a caller appends. */
  const STORE_FIELDS = new Set(['id', 'hash', 'prevHash', 'createdAt', 'updatedAt', 'idempotencyKey', 'totalTokens', 'reversedByRecordId'])

  /** The append input of a record, with the model the response carried (none for Converse). */
  function appendInputOf(record: UsageRecord, model: string): LedgerAppendInput {
    const fields = Object.fromEntries(Object.entries(record).filter(([key]) => !STORE_FIELDS.has(key)))
    return { ...fields, model } as LedgerAppendInput
  }

  /**
   * The payload hash covers the model the response carried, not the model filled in from `baseModel`,
   * so replaying the same call against an existing empty-model row finds that row instead of
   * conflicting with it.
   */
  it('returns the stored row when the same call is retried against an empty-model row', async () => {
    const filled = await (await boot(false)).metering.record({ usage: raw, preset: providerPresets.bedrock, context, occurredAt })
    const target = await boot(false)
    const stored = await target.ledger.append(appendInputOf(filled, ''), context.idempotencyKey)

    const replay = await target.metering.record({ usage: raw, preset: providerPresets.bedrock, context, occurredAt })

    expect(replay.id).toBe(stored.id)
    expect(replay.model).toBe('')
  })

  /** Two retries made by the same version find the row the first one stored. */
  it('returns the stored row when the same call is retried against a filled row', async () => {
    const { metering } = await boot(false)
    const first = await metering.record({ usage: raw, preset: providerPresets.bedrock, context, occurredAt })
    const replay = await metering.record({ usage: raw, preset: providerPresets.bedrock, context, occurredAt })
    expect(replay.id).toBe(first.id)
    expect(replay.model).toBe('claude-sonnet-4-5')
  })

  /** Hashing the response model instead of the stored one must not let a different call reuse the key. */
  it.each([
    ['other token counts', { usage: { inputTokens: 1001, outputTokens: 500 } }, context],
    ['another baseModel', raw, { ...context, baseModel: 'claude-haiku-4-5' }],
  ])('still conflicts when the same key carries %s', async (_name, otherRaw, otherContext) => {
    const { metering } = await boot(false)
    await metering.record({ usage: raw, preset: providerPresets.bedrock, context, occurredAt })
    const error = await metering.record({ usage: otherRaw, preset: providerPresets.bedrock, context: otherContext, occurredAt }).catch((e: unknown) => e)
    expect(((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
  })

  /** A response that carried a model hashes that model, so an empty-model row is a different request. */
  it('conflicts when an empty-model row is retried with a response that names a model', async () => {
    const filled = await (await boot(false)).metering.record({ usage: raw, preset: providerPresets.bedrock, context, occurredAt })
    const target = await boot(false)
    await target.ledger.append(appendInputOf(filled, ''), context.idempotencyKey)
    const named = { model: 'claude-sonnet-4-5', ...raw }
    const error = await target.metering.record({ usage: named, preset: providerPresets.bedrock, context, occurredAt }).catch((e: unknown) => e)
    expect(((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code).toBe('AI_TOKENS_IDEMPOTENCY_CONFLICT')
  })
})
