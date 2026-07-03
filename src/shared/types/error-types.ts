/**
 * @fileoverview The canonical error response body. `AiTokensException` (server
 * layer) serializes to this shape so hosts get a stable `{ error: {...} }`
 * envelope (see spec §16).
 * @layer shared
 */

import type { AI_TOKENS_ERROR_CODES } from '../constants/error-codes.constants'

/** The JSON body every {@link AI_TOKENS_ERROR_CODES} failure serializes to. */
export interface AiTokensErrorResponse {
  error: {
    code: keyof typeof AI_TOKENS_ERROR_CODES
    message: string
    details?: Record<string, unknown>
  }
}
