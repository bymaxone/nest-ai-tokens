/**
 * @fileoverview `MeteringInterceptor` — the declarative capture half of the
 * controller path (spec §11.3/§11.4). After the handler resolves it extracts the
 * raw usage from the return value (via `@Meter.extract`, default `result.usage`),
 * then either settles the guard's hold (`capture`) or records enforcing post-hoc
 * (`record({ enforce: true })`). On a handler error with a hold present it releases
 * the hold; when settling fails after the handler returned it leaves a hold pending,
 * and announces `ai_tokens.settle.failed` when the usage was not recorded. The handler's error and the settle's each reach the
 * caller as the ORIGINAL error. With
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
import type { Hold, MeteringContext } from '../interfaces'
import { absorbHostCall } from '../utils/absorb-host-call'
import { appendWatch } from '../utils/append-watch'
import { fieldOf, fieldsOf } from '../utils/field-names'
import { settled } from '../utils/host-settled'
import { MeteringService } from '../services'
import type { RequestAiTokens } from './budget.guard'
import { METER_METADATA, meterConfigOf } from './decorators'
import type { MeterConfig } from './decorators'

/** The log key of a failure to write the line about a hold that could not be released. */
const RELEASE_FAILED_LOG_KEY = 'ai_tokens.hold.release_failed'

/** Every field of the guard's enrichment, mapped to `true` so that the compiler keeps the list complete. */
const ENRICHMENT_FIELDS: { readonly [K in keyof Required<RequestAiTokens>]: true } = { status: true, context: true, hold: true }

/** What a settle threw, marked so that the one catch of the pipeline can tell it from the handler's own error. */
class SettleFailure {
  constructor(readonly thrown: unknown) {}
}

/** What one intercepted call knows about its handler. */
interface CallState {
  handlerFailed: boolean
}

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
   * hold on a handler error, and leave it pending when settling fails.
   *
   * @param executionContext The request execution context.
   * @param next The downstream handler.
   * @returns The handler's result stream, unchanged in value.
   */
  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [executionContext.getHandler(), executionContext.getClass()]
    const config = meterConfigOf(this.reflector.getAllAndOverride<MeterConfig | undefined>(METER_METADATA, targets))
    if (config === undefined) return next.handle()
    const request = executionContext.switchToHttp().getRequest<object>()
    // The guard's enrichment is a field of the request and its three fields are read as fields: a key planted on Object.prototype is neither
    // an enrichment nor the hold the guard did not place.
    const given = fieldOf(request, 'aiTokens')
    const enrichment = typeof given === 'object' && given !== null ? fieldsOf(given as RequestAiTokens, ENRICHMENT_FIELDS) : undefined
    const call: CallState = { handlerFailed: false }
    return next.handle().pipe(
      mergeMap((result: unknown) => from(this.settle(executionContext, config, enrichment, result, call)).pipe(catchError((error: unknown) => throwError(() => new SettleFailure(error))))),
      // One catch, after the settle: a handler that fails while a settle is in flight ends the stream with its own error.
      catchError((error: unknown) => {
        if (error instanceof SettleFailure) return throwError(() => error.thrown)
        call.handlerFailed = true
        return this.onError(enrichment, error)
      }),
    )
  }

  /** Settle the handler's usage and set the cost headers; returns the untouched result. */
  private async settle(executionContext: ExecutionContext, config: MeterConfig, enrichment: RequestAiTokens | undefined, result: unknown, call: CallState): Promise<unknown> {
    const record = enrichment?.hold !== undefined ? await this.captureHeld(enrichment.hold, enrichment.context, config, result, call) : await this.recordServed(executionContext, config, enrichment, result)
    if (config.exposeHeaders === true) this.setHeaders(executionContext, record, enrichment)
    return result
  }

  /**
   * Settle the guard's hold. A failure leaves the hold pending for the reaper and is announced from here, so that a caller that
   * stops waiting takes nothing with it. A handler that failed meanwhile releases the hold itself, and a capture that loses to that
   * release is no settle failure.
   */
  private async captureHeld(hold: Hold, context: MeteringContext, config: MeterConfig, result: unknown, call: CallState): Promise<UsageRecord> {
    try {
      return await this.metering.capture(hold, context, extractUsage(result, config), config.preset)
    } catch (error) {
      if (!call.handlerFailed) await this.announce(hold, context, error)
      throw error
    }
  }

  /** Announce a failed settle. A substitute metering service without the method, or one whose method fails, leaves the settle error as it is. */
  private async announce(hold: Hold | undefined, context: MeteringContext, error: unknown): Promise<void> {
    try {
      await this.metering.reportSettleFailure(hold, context, error)
    } catch {
      // The settle error is the one that reaches the caller.
    }
  }

  /**
   * Record a served call that has no hold. A failure that wrote no row is announced, since nothing else keeps the usage; it needs
   * the caller's context, so a context that does not resolve announces nothing.
   */
  private async recordServed(executionContext: ExecutionContext, config: MeterConfig, enrichment: RequestAiTokens | undefined, result: unknown): Promise<UsageRecord> {
    const context = await this.resolveContext(executionContext, config, enrichment)
    const watch = appendWatch()
    try {
      return await this.metering.record(
        {
          usage: extractUsage(result, config),
          // Stryker disable next-line ConditionalExpression: CE true: spreading { preset: undefined } is equivalent to {} because MeteringService checks preset !== undefined
          ...(config.preset !== undefined ? { preset: config.preset } : {}),
          // Stryker disable next-line ConditionalExpression: CE true: spreading { tags: undefined } is equivalent to {} because MeteringService checks tags !== undefined
          context: { ...context, enforce: true, isSystemCost: config.isSystemCost ?? false, ...(config.tags !== undefined ? { tags: config.tags } : {}) },
        },
        watch,
      )
    } catch (error) {
      if (!watch.appended) await this.announce(undefined, context, error)
      throw error
    }
  }

  /** The metering context: the guard's enrichment, else the host `scopeResolver`. */
  private async resolveContext(executionContext: ExecutionContext, config: MeterConfig, enrichment: RequestAiTokens | undefined): Promise<MeteringContext> {
    if (enrichment !== undefined) return enrichment.context
    if (this.scopeResolver === undefined) {
      // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check error code only
      throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: 'MeteringInterceptor requires options.scopeResolver when no BudgetGuard ran' })
    }
    const resolved = await settled(this.scopeResolver(executionContext))
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: equivalent: this context feeds the no-guard record() path, and record() derives its preset from config.preset directly (passed above), never from context.preset — so adding, omitting, or flipping this spread has no observable effect
    return { ...resolved, feature: config.feature, ...(config.preset !== undefined ? { preset: config.preset } : {}) }
  }

  /** Release the guard's hold (if any) and rethrow the ORIGINAL handler error. */
  private onError(enrichment: RequestAiTokens | undefined, error: unknown): Observable<never> {
    if (enrichment?.hold === undefined) return throwError(() => error)
    const holdId = enrichment.hold.id
    const released = this.metering.release(enrichment.hold, enrichment.context, 'handler threw').catch(() => {
      // The logger is the host's, and a line it cannot write must not replace the handler's error.
      absorbHostCall(this.logger, RELEASE_FAILED_LOG_KEY, () => {
        this.logger.warn(`failed to release hold ${holdId} after a handler error; the reaper will reclaim it`)
      })
    })
    return from(released).pipe(mergeMap(() => throwError(() => error)))
  }

  /** Set the three `x-ai-tokens-*` headers as decimal strings via the HTTP adapter. */
  private setHeaders(executionContext: ExecutionContext, record: UsageRecord, enrichment: RequestAiTokens | undefined): void {
    const response = executionContext.switchToHttp().getResponse<HeaderSink>()
    writeHeader(response, 'x-ai-tokens-cost', record.rawCostNanoUsd.toString())
    writeHeader(response, 'x-ai-tokens-billed-cost', record.billedCostNanoUsd.toString())
    const remaining = minBudgetRemaining(enrichment)
    if (remaining !== undefined) writeHeader(response, 'x-ai-tokens-budget-remaining', remaining.toString())
  }
}

/** Extract the raw usage from the handler result, or fail as malformed. */
function extractUsage(result: unknown, config: MeterConfig): unknown {
  // Stryker disable next-line ConditionalExpression: CE true on `typeof value === 'object'` is equivalent: the `value !== null` operand still excludes null, and for any non-object non-null primitive `.usage` is undefined — identical to the else branch — so the extracted value is unchanged
  const extract = config.extract ?? ((value: unknown): unknown => (typeof value === 'object' && value !== null ? fieldOf(value, 'usage') : undefined))
  const usage = extract(result)
  if (usage === undefined || usage === null) {
    // Stryker disable next-line ObjectLiteral,StringLiteral: error context and reason are internal diagnostics; tests check error code only
    throw new AiTokensException('AI_TOKENS_USAGE_MALFORMED', undefined, { reason: 'the handler result carried no extractable usage' })
  }
  return usage
}

/** The minimum remaining nano-USD across the guard's matched budgets (snapshot; may be stale). */
function minBudgetRemaining(enrichment: RequestAiTokens | undefined): bigint | undefined {
  let min: bigint | undefined
  for (const status of enrichment?.status ?? []) {
    const remaining = fieldOf(status.remaining, 'nanoUsd') as bigint | undefined
    // Stryker disable next-line EqualityOperator: remaining <= min: if two budgets have identical remaining, updating min to the same value is a no-op; < and <= produce the same final minimum
    if (remaining !== undefined && (min === undefined || remaining < min)) min = remaining
  }
  return min
}

/** Write one response header through whichever adapter method exists. */
function writeHeader(response: HeaderSink, name: string, value: string): void {
  if (typeof response.setHeader === 'function') response.setHeader(name, value)
  else if (typeof response.header === 'function') response.header(name, value)
}
