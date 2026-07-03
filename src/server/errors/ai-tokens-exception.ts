/**
 * @fileoverview The typed exception the library throws. Extends NestJS
 * `HttpException` so hosts get a stable `{ error: { code, message, details? } }`
 * body and the right HTTP status by default (spec §16.1). The public surface is
 * this class plus `AI_TOKENS_ERROR_CODES` and `AiTokensErrorResponse` (both from
 * `./shared`); the message/status maps are internal.
 * @layer server
 */

import { HttpException } from '@nestjs/common'
import type { HttpStatus } from '@nestjs/common'
import type { AiTokensErrorCode } from '../../shared'
import { AI_TOKENS_ERROR_MESSAGES } from './ai-tokens-error-messages'
import { AI_TOKENS_ERROR_STATUS } from './ai-tokens-error-status'

/**
 * A typed library error. The status defaults to the code's mapped HTTP status
 * (spec §16.2) and the body is the canonical `AiTokensErrorResponse` shape.
 *
 * @example
 * throw new AiTokensException('AI_TOKENS_BUDGET_EXCEEDED', undefined, { budgetId })
 */
export class AiTokensException extends HttpException {
  /**
   * @param code The error code.
   * @param statusCode The HTTP status; defaults to the code's mapped status.
   * @param details Optional structured context (never includes prompt/response text).
   */
  constructor(
    code: AiTokensErrorCode,
    statusCode: HttpStatus = AI_TOKENS_ERROR_STATUS[code],
    details?: Record<string, unknown>,
  ) {
    super({ error: { code, message: AI_TOKENS_ERROR_MESSAGES[code], details } }, statusCode)
  }
}
