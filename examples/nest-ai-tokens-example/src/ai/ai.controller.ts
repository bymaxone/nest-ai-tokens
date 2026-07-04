/**
 * @fileoverview AiController — HTTP layer demonstrating declarative metering (spec §21.3).
 *
 * Routes:
 * - POST /ai/chat             — post-hoc metering via AiService.chat()
 * - POST /ai/summarize        — declarative guard + interceptor (BudgetGuard + MeteringInterceptor)
 * - GET  /ai/me/usage         — current usage + budget status
 * - GET  /ai/me/summary       — aggregated usage report
 * - POST /ai/trainer/generate — trainer-pays-for-client pattern
 *
 * @layer presentation
 */
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import type { Request } from 'express'
import {
  BudgetGuard,
  MeteringInterceptor,
  Meter,
  RequireBudget,
  providerPresets,
} from '@bymax-one/nest-ai-tokens'
import { CurrentUser, AuthedUser } from '../auth/auth.decorator.js'
import { AiService } from './ai.service.js'

/** DTO for the /ai/chat endpoint. */
interface ChatDto {
  readonly prompt: string
  readonly requestId: string
}

/** DTO for the /ai/summarize endpoint. */
interface SummarizeDto {
  readonly text: string
  readonly requestId: string
  /** Provider usage populated by the controller after the LLM call. */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/** DTO for the trainer-pays-for-client endpoint. */
interface TrainerGenerateDto {
  readonly clientId: string
  readonly prompt: string
  readonly requestId: string
}

/**
 * HTTP controller for all AI metering demonstration endpoints.
 * See spec §21 for the patterns implemented here.
 */
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /**
   * Post-hoc metering — LLM call then record() (spec §21.1).
   * The request ID is used to derive the idempotency key, making retries safe.
   *
   * ```bash
   * curl -X POST http://localhost:3000/ai/chat \
   *   -H "Content-Type: application/json" \
   *   -H "x-tenant-id: tenant-demo" \
   *   -H "x-user-id: user-demo" \
   *   -d '{"prompt":"What is TypeScript?","requestId":"req-1"}'
   * ```
   */
  @Post('chat')
  async chat(
    @Body() dto: ChatDto,
    @CurrentUser() user: AuthedUser,
  ): Promise<{ reply: string; billedCostNanoUsd: string }> {
    return this.ai.chat(user.tenantId, user.userId, dto.prompt, dto.requestId)
  }

  /**
   * Declarative guard + interceptor metering (spec §21.3).
   *
   * BudgetGuard runs BEFORE the handler:
   * - Checks monthly token budget for 'doc.summarize'
   * - Pre-reserves an estimate (3,000 tokens) as a hold
   *
   * MeteringInterceptor runs AFTER the handler:
   * - Captures the hold with actual usage from the response
   * - Adds X-AI-Tokens-Cost and X-AI-Tokens-Remaining headers
   *
   * The handler must return an object with a `usage` field (or configure
   * MeteringInterceptor with a custom extractor) for the interceptor to capture.
   *
   * ```bash
   * curl -X POST http://localhost:3000/ai/summarize \
   *   -H "Content-Type: application/json" \
   *   -H "x-tenant-id: tenant-demo" \
   *   -H "x-user-id: user-demo" \
   *   -d '{"text":"Long document text here...","requestId":"req-2"}'
   * ```
   */
  @Post('summarize')
  @UseGuards(BudgetGuard)
  @RequireBudget({ scope: 'user', estimate: { tokens: 3_000 } })
  @Meter({
    feature: 'doc.summarize',
    scope: 'user',
    preset: providerPresets.anthropic,
    exposeHeaders: true,
  })
  @UseInterceptors(MeteringInterceptor)
  async summarize(
    @Body() dto: SummarizeDto,
    @CurrentUser() user: AuthedUser,
    @Req() _req: Request,
  ): Promise<{ summary: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
    const result = await this.ai.summarize(user.tenantId, user.userId, dto.text, dto.requestId)
    // Return usage alongside the result so MeteringInterceptor can extract it.
    return {
      summary: result.summary,
      usage: {
        prompt_tokens: Math.ceil(dto.text.length / 4),
        completion_tokens: 64,
        total_tokens: Math.ceil(dto.text.length / 4) + 64,
      },
    }
  }

  /**
   * Current usage and budget status for the authenticated user (spec §21.3).
   *
   * Returns bigints as decimal strings (toJsonSafe — spec §15.5).
   *
   * ```bash
   * curl http://localhost:3000/ai/me/usage \
   *   -H "x-tenant-id: tenant-demo" \
   *   -H "x-user-id: user-demo"
   * ```
   */
  @Get('me/usage')
  async myUsage(@CurrentUser() user: AuthedUser): Promise<unknown> {
    return this.ai.getUsageStatus(user.tenantId, user.userId)
  }

  /**
   * Aggregated usage summary for a date range.
   *
   * ```bash
   * curl "http://localhost:3000/ai/me/summary?from=2026-07-01&to=2026-07-31" \
   *   -H "x-tenant-id: tenant-demo" \
   *   -H "x-user-id: user-demo"
   * ```
   */
  @Get('me/summary')
  async mySummary(
    @CurrentUser() user: AuthedUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<unknown> {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const toDate = to ? new Date(to) : new Date()
    return this.ai.getUsageSummary(user.tenantId, user.userId, fromDate, toDate)
  }

  /**
   * Trainer-pays-for-client pattern (spec §21.7).
   * The trainer's budget and wallet are charged; the client is the beneficiary.
   *
   * ```bash
   * curl -X POST http://localhost:3000/ai/trainer/generate \
   *   -H "Content-Type: application/json" \
   *   -H "x-tenant-id: tenant-demo" \
   *   -H "x-user-id: trainer-1" \
   *   -d '{"clientId":"client-1","prompt":"Generate a workout plan","requestId":"req-3"}'
   * ```
   */
  @Post('trainer/generate')
  async trainerGenerate(
    @Body() dto: TrainerGenerateDto,
    @CurrentUser() user: AuthedUser,
  ): Promise<{ reply: string; billedCostNanoUsd: string }> {
    return this.ai.generateForClient(user.tenantId, user.userId, dto.clientId, dto.prompt, dto.requestId)
  }
}
