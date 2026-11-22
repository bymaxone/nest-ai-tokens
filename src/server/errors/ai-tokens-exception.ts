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
import { descriptor } from '../utils/descriptor'

/** The body of an exception: the canonical `AiTokensErrorResponse` shape. */
interface AiTokensErrorBody {
  error: { code: AiTokensErrorCode; message: string; details?: Record<string, unknown> | undefined }
}

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
    // The body has no prototype: NestJS reads `message` off the body when it names the exception, and a literal would answer a `message` planted
    // on `Object.prototype`.
    const message = AI_TOKENS_ERROR_MESSAGES[code]
    const body = Object.assign(Object.create(null) as AiTokensErrorBody, { error: Object.assign(Object.create(null) as AiTokensErrorBody['error'], { code, message, details }) })
    super(body, statusCode)
    // NestJS assigns these on the new instance, and an accessor planted on `Object.prototype` under their names would swallow the write: the
    // exception is defined with them as its own, so its code, status and text are the library's.
    const own = { writable: true, configurable: true, enumerable: false }
    Object.defineProperty(this, 'response', descriptor({ value: body, ...own }))
    Object.defineProperty(this, 'status', descriptor({ value: statusCode, ...own }))
    Object.defineProperty(this, 'message', descriptor({ value: message, ...own }))
    Object.defineProperty(this, 'name', descriptor({ value: 'AiTokensException', ...own }))
  }
}
