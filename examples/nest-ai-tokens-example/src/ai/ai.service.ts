/**
 * @fileoverview AiService — demonstrates the core metering patterns from spec §21.
 *
 * Covers:
 * - §21.1: Post-hoc metering via `metering.record()`
 * - §21.2: Enforced hold → capture via `metering.meter()`
 * - §21.7: Trainer-pays-for-client via `beneficiary`
 *
 * @layer application
 */
import { Injectable } from '@nestjs/common'
import {
  MeteringService,
  WalletService,
  BudgetService,
  UsageReportService,
  toJsonSafe,
  providerPresets,
} from '@bymax-one/nest-ai-tokens'
import { deriveIdempotencyKey } from '@bymax-one/nest-ai-tokens/shared'
import { FakeLlmService } from '../fake-llm/fake-llm.service.js'

/**
 * Application service wrapping AI calls with token metering and budget enforcement.
 * All monetary values are bigint nano-USD (1 USD = 1_000_000_000n).
 */
@Injectable()
export class AiService {
  constructor(
    private readonly metering: MeteringService,
    private readonly wallets: WalletService,
    private readonly budgets: BudgetService,
    private readonly reports: UsageReportService,
    private readonly llm: FakeLlmService,
  ) {}

  /**
   * Post-hoc metering — calls the LLM then records usage (spec §21.1).
   * Safe to retry: idempotencyKey derived from requestId prevents double-billing.
   *
   * @param tenantId - Tenant identifier.
   * @param userId - User identifier (scope).
   * @param prompt - User's message.
   * @param requestId - Stable request ID for idempotent metering.
   * @returns LLM reply and the billed cost in nano-USD.
   */
  async chat(
    tenantId: string,
    userId: string,
    prompt: string,
    requestId: string,
  ): Promise<{ reply: string; billedCostNanoUsd: string }> {
    const completion = this.llm.chatCompletion('gpt-4o', prompt)

    const record = await this.metering.record({
      usage: completion.usage,
      preset: providerPresets.openaiChat,
      context: {
        tenantId,
        scope: { type: 'user', id: userId },
        feature: 'chat.reply',
        idempotencyKey: deriveIdempotencyKey({ requestId }),
      },
    })

    return {
      reply: completion.choices[0]?.message.content ?? '',
      billedCostNanoUsd: record.billedCostNanoUsd.toString(),
    }
  }

  /**
   * Enforced metering — hold → capture with budget check (spec §21.2).
   * The `meter()` helper does hold + call + capture atomically.
   *
   * @param tenantId - Tenant identifier.
   * @param userId - User identifier.
   * @param text - Document text to summarize.
   * @param requestId - Stable request ID.
   * @returns Summary and settled billed cost.
   */
  async summarize(
    tenantId: string,
    userId: string,
    text: string,
    requestId: string,
  ): Promise<{ summary: string; billedCostNanoUsd: string }> {
    const { result, usage } = await this.metering.meter(
      () => Promise.resolve(this.llm.summarize('claude-opus-4-5', text)),
      {
        tenantId,
        scope: { type: 'user', id: userId },
        feature: 'doc.summarize',
        preset: providerPresets.anthropic,
        idempotencyKey: deriveIdempotencyKey({ requestId }),
      },
      (res) => res.usage,
      { provider: 'anthropic', model: 'claude-opus-4-5', operation: 'chat', inputTokens: 2_000, maxOutputTokens: 512 },
    )

    return {
      summary: result.choices[0]?.message.content ?? '',
      billedCostNanoUsd: usage.billedCostNanoUsd.toString(),
    }
  }

  /**
   * Returns the current usage and budget status for a user (spec §21.3).
   * Uses `toJsonSafe()` to convert bigints to decimal strings for JSON serialization.
   *
   * @param tenantId - Tenant identifier.
   * @param userId - User identifier.
   * @returns JSON-safe status object with bigints as strings.
   */
  async getUsageStatus(
    tenantId: string,
    userId: string,
  ): Promise<unknown> {
    const status = await this.metering.getStatus(tenantId, { type: 'user', id: userId })
    return toJsonSafe(status)
  }

  /**
   * Trainer-pays-for-client pattern (spec §21.7).
   * The trainer's quota and wallet are charged; the client appears as beneficiary.
   *
   * @param tenantId - Tenant identifier.
   * @param trainerId - Trainer user ID (payer — budget and wallet debited here).
   * @param clientId - Client user ID (beneficiary — reporting dimension only).
   * @param prompt - Prompt for the AI call.
   * @param requestId - Stable request ID.
   * @returns Reply and billed cost.
   */
  async generateForClient(
    tenantId: string,
    trainerId: string,
    clientId: string,
    prompt: string,
    requestId: string,
  ): Promise<{ reply: string; billedCostNanoUsd: string }> {
    const completion = this.llm.chatCompletion('gpt-4o', prompt)

    const record = await this.metering.record({
      usage: completion.usage,
      preset: providerPresets.openaiChat,
      context: {
        tenantId,
        scope: { type: 'user', id: trainerId },       // payer
        beneficiary: { type: 'user', id: clientId },  // reporting dimension
        requestedBy: trainerId,
        feature: 'workout.generate',
        idempotencyKey: deriveIdempotencyKey({ requestId }),
      },
    })

    return {
      reply: completion.choices[0]?.message.content ?? '',
      billedCostNanoUsd: record.billedCostNanoUsd.toString(),
    }
  }

  /**
   * Returns aggregated usage report for a user over a time range.
   *
   * @param tenantId - Tenant identifier.
   * @param userId - User identifier.
   * @param from - Start of the reporting window.
   * @param to - End of the reporting window.
   * @returns JSON-safe summary with model-level breakdown.
   */
  async getUsageSummary(
    tenantId: string,
    userId: string,
    from: Date,
    to: Date,
  ): Promise<unknown> {
    const summary = await this.reports.summarize({
      tenantId,
      scope: { type: 'user', id: userId },
      from,
      to,
      groupBy: ['model'],
    })
    return toJsonSafe(summary)
  }
}
