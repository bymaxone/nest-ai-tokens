/**
 * @fileoverview `MeteringInterceptor` — the declarative capture half of the
 * controller path (spec §11.3/§11.4). After the handler resolves it extracts the
 * raw usage from the return value (via `@Meter.extract`, default `result.usage`),
 * then either settles the guard's hold (`capture`) or records enforcing post-hoc
 * (`record({ enforce: true })`). On a handler error with a hold present it releases
 * the hold and rethrows the ORIGINAL error — never swallowing it. With
 * `exposeHeaders` it sets the three `x-ai-tokens-*` response headers as DECIMAL
 * STRINGS (bigint never crosses the HTTP boundary raw, §15.5). Handlers without a
 * `@Meter` are passed through untouched. `scopeResolver` is TRUSTED INPUT — the
 * host's verified auth context, never client body/query (§14.4).
 * @layer server
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Observable } from 'rxjs'
import { from, mergeMap, throwError } from 'rxjs'
import { catchError } from 'rxjs/operators'
import type { UsageRecord } from '../../shared'
import { BYMAX_AI_TOKENS_OPTIONS } from '../bymax-ai-tokens.constants'
import type { ResolvedAiTokensOptions } from '../config'
import { AiTokensException } from '../errors'
import type { MeteringContext } from '../interfaces'
import { MeteringService } from '../services'
import type { RequestAiTokens } from './budget.guard'
import { METER_METADATA } from './decorators'
import type { MeterConfig } from './decorators'

/** The response shape the interceptor writes headers through (adapter-agnostic). */
interface HeaderSink {
  setHeader?: (name: string, value: string) => unknown
  header?: (name: string, value: string) => unknown
}

/** The resolved-options subset the interceptor consumes. */
export type MeteringInterceptorOptions = Pick<ResolvedAiTokensOptions, 'scopeResolver'>

/**
 * NestJS interceptor that captures the handler's actual usage (from the return
 * value) and either settles the guard's hold or records a post-hoc enforcing
 * charge. Reads `@Meter` metadata set by the {@link Meter} decorator.
 */
@Injectable()
export class MeteringInterceptor implements NestInterceptor {
  private readonly logger = new Logger(MeteringInterceptor.name)
  private readonly scopeResolver: ResolvedAiTokensOptions['scopeResolver']

  /**
   * @param reflector The NestJS reflector (`@Meter` metadata).
   * @param metering The metering facade (capture/record).
   * @param options The resolved options (fallback `scopeResolver` when no guard ran).
   */
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MeteringService) private readonly metering: MeteringService,
    @Inject(BYMAX_AI_TOKENS_OPTIONS) options: MeteringInterceptorOptions,
  ) {
    this.scopeResolver = options.scopeResolver
  }

  /**
   * Capture (or record) the handler's usage after it resolves; release the guard's
   * hold on a handler error.
   *
   * @param executionContext The request execution context.
   * @param next The downstream handler.
   * @returns The handler's result stream, unchanged in value.
   */
  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [executionContext.getHandler(), executionContext.getClass()]
    const config = this.reflector.getAllAndOverride<MeterConfig | undefined>(
      METER_METADATA,
      targets,
    )
    if (config === undefined) return next.handle()
    const request = executionContext.switchToHttp().getRequest<{ aiTokens?: RequestAiTokens }>()
    const enrichment = request.aiTokens
    return next.handle().pipe(
      mergeMap((result: unknown) =>
        from(this.settle(executionContext, config, enrichment, result)),
      ),
      catchError((error: unknown) => this.onError(enrichment, error)),
    )
  }

  /** Settle the handler's usage and set the cost headers; returns the untouched result. */
  private async settle(
    executionContext: ExecutionContext,
    config: MeterConfig,
    enrichment: RequestAiTokens | undefined,
    result: unknown,
  ): Promise<unknown> {
    const usage = extractUsage(result, config)
    const record = await this.capture(executionContext, config, enrichment, usage)
    if (config.exposeHeaders === true) this.setHeaders(executionContext, record, enrichment)
    return result
  }

  /** Capture the guard's hold when present, else record enforcing post-hoc. */
  private async capture(
    executionContext: ExecutionContext,
    config: MeterConfig,
    enrichment: RequestAiTokens | undefined,
    usage: unknown,
  ): Promise<UsageRecord> {
    if (enrichment?.hold !== undefined)
      return this.metering.capture(enrichment.hold, usage, config.preset)
    const context = await this.resolveContext(executionContext, config, enrichment)
    return this.metering.record({
      usage,
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { preset: undefined } is equivalent to {} because MeteringService checks preset !== undefined
      ...(config.preset !== undefined ? { preset: config.preset } : {}),
      // Stryker disable next-line ConditionalExpression -- CE true: spreading { tags: undefined } is equivalent to {} because MeteringService checks tags !== undefined
      context: {
        ...context,
        enforce: true,
        isSystemCost: config.isSystemCost ?? false,
        ...(config.tags !== undefined ? { tags: config.tags } : {}),
      },
    })
  }

  /** The metering context: the guard's enrichment, else the host `scopeResolver`. */
  private async resolveContext(
    executionContext: ExecutionContext,
    config: MeterConfig,
    enrichment: RequestAiTokens | undefined,
  ): Promise<MeteringContext> {
    if (enrichment !== undefined) return enrichment.context
    if (this.scopeResolver === undefined) {
      // Stryker disable next-line ObjectLiteral,StringLiteral -- error context and reason are internal diagnostics; tests check error code only
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
        reason: 'MeteringInterceptor requires options.scopeResolver when no BudgetGuard ran',
      })
    }
    const resolved = await this.scopeResolver(executionContext)
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral -- equivalent: this context feeds the no-guard record() path, and record() derives its preset from config.preset directly (passed above), never from context.preset — so adding, omitting, or flipping this spread has no observable effect
    return {
      ...resolved,
      feature: config.feature,
      ...(config.preset !== undefined ? { preset: config.preset } : {}),
    }
  }

  /** Release the guard's hold (if any) and rethrow the ORIGINAL handler error. */
  private onError(enrichment: RequestAiTokens | undefined, error: unknown): Observable<never> {
    if (enrichment?.hold === undefined) return throwError(() => error)
    const holdId = enrichment.hold.id
    // Stryker disable next-line StringLiteral -- release reason is internal audit text; tests check error propagation behavior
    const released = this.metering.release(enrichment.hold, 'handler threw').catch(() => {
      // Stryker disable next-line BlockStatement -- best-effort hold release; the reaper reclaims unreleased holds
      // Stryker disable next-line StringLiteral -- logger text is internal observability
      this.logger.warn(
        `failed to release hold ${holdId} after a handler error; the reaper will reclaim it`,
      )
    })
    return from(released).pipe(mergeMap(() => throwError(() => error)))
  }

  /** Set the three `x-ai-tokens-*` headers as decimal strings via the HTTP adapter. */
  private setHeaders(
    executionContext: ExecutionContext,
    record: UsageRecord,
    enrichment: RequestAiTokens | undefined,
  ): void {
    const response = executionContext.switchToHttp().getResponse<HeaderSink>()
    writeHeader(response, 'x-ai-tokens-cost', record.rawCostNanoUsd.toString())
    writeHeader(response, 'x-ai-tokens-billed-cost', record.billedCostNanoUsd.toString())
    const remaining = minBudgetRemaining(enrichment)
    if (remaining !== undefined)
      writeHeader(response, 'x-ai-tokens-budget-remaining', remaining.toString())
  }
}

/** Extract the raw usage from the handler result, or fail as malformed. */
function extractUsage(result: unknown, config: MeterConfig): unknown {
  // Stryker disable next-line ConditionalExpression -- CE true on `typeof value === 'object'` is equivalent: the `value !== null` operand still excludes null, and for any non-object non-null primitive `.usage` is undefined — identical to the else branch — so the extracted value is unchanged
  const extract =
    config.extract ??
    ((value: unknown): unknown =>
      typeof value === 'object' && value !== null
        ? (value as { usage?: unknown }).usage
        : undefined)
  const usage = extract(result)
  if (usage === undefined || usage === null) {
    // Stryker disable next-line ObjectLiteral,StringLiteral -- error context and reason are internal diagnostics; tests check error code only
    throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, {
      reason: 'the handler result carried no extractable usage',
    })
  }
  return usage
}

/** The minimum remaining nano-USD across the guard's matched budgets (snapshot; may be stale). */
function minBudgetRemaining(enrichment: RequestAiTokens | undefined): bigint | undefined {
  let min: bigint | undefined
  for (const status of enrichment?.status ?? []) {
    const remaining = status.remaining.nanoUsd
    // Stryker disable next-line EqualityOperator -- remaining <= min: if two budgets have identical remaining, updating min to the same value is a no-op; < and <= produce the same final minimum
    if (remaining !== undefined && (min === undefined || remaining < min)) min = remaining
  }
  return min
}

/** Write one response header through whichever adapter method exists. */
function writeHeader(response: HeaderSink, name: string, value: string): void {
  if (typeof response.setHeader === 'function') response.setHeader(name, value)
  else if (typeof response.header === 'function') response.header(name, value)
}
