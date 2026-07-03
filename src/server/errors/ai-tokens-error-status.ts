/**
 * @fileoverview Internal, exhaustive code→HTTP-status map. Typed as
 * `Record<keyof typeof AI_TOKENS_ERROR_CODES, HttpStatus>` so the compiler
 * enforces a status for every error code. Not exported from the server barrel;
 * statuses match the spec §16.2 HTTP column exactly.
 * @layer server
 */

import { HttpStatus } from '@nestjs/common'
import type { AiTokensErrorCode } from '../../shared'

/** The HTTP status each error code maps to (spec §16.2). */
export const AI_TOKENS_ERROR_STATUS: Record<AiTokensErrorCode, HttpStatus> = {
  AI_TOKENS_NOT_CONFIGURED: HttpStatus.SERVICE_UNAVAILABLE,
  AI_TOKENS_INVALID_CONFIG: HttpStatus.INTERNAL_SERVER_ERROR,
  AI_TOKENS_UNKNOWN_PROVIDER: HttpStatus.BAD_REQUEST,
  AI_TOKENS_USAGE_MALFORMED: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_TOKENS_PRICE_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_TOKENS_FX_REQUIRED: HttpStatus.INTERNAL_SERVER_ERROR,
  AI_TOKENS_BUDGET_EXCEEDED: HttpStatus.PAYMENT_REQUIRED,
  AI_TOKENS_QUOTA_EXCEEDED: HttpStatus.TOO_MANY_REQUESTS,
  AI_TOKENS_INSUFFICIENT_CREDITS: HttpStatus.PAYMENT_REQUIRED,
  AI_TOKENS_HOLD_NOT_FOUND: HttpStatus.NOT_FOUND,
  AI_TOKENS_HOLD_EXPIRED: HttpStatus.GONE,
  AI_TOKENS_HOLD_ALREADY_SETTLED: HttpStatus.CONFLICT,
  AI_TOKENS_IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  AI_TOKENS_STREAM_USAGE_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_TOKENS_STORE_ERROR: HttpStatus.BAD_GATEWAY,
}
