/**
 * @fileoverview Internal, exhaustive code→message map. Typed as
 * `Record<keyof typeof AI_TOKENS_ERROR_CODES, string>` so the compiler enforces a
 * message for every error code. Not exported from the server barrel (spec §16).
 * @layer server
 */

import type { AiTokensErrorCode } from '../../shared'

/** One actionable message per error code (derived from the spec §16.2 "when it occurs" column). */
export const AI_TOKENS_ERROR_MESSAGES: Record<AiTokensErrorCode, string> = {
  AI_TOKENS_NOT_CONFIGURED:
    'The AI tokens module was invoked before its asynchronous configuration finished initializing.',
  AI_TOKENS_INVALID_CONFIG:
    'The AI tokens module configuration is invalid; check markup, limits, currency/fx, and store port methods.',
  AI_TOKENS_UNKNOWN_PROVIDER:
    'Raw usage was provided without a preset or normalizer and is not already a NormalizedUsage.',
  AI_TOKENS_USAGE_MALFORMED: 'The provider usage payload is missing required token fields.',
  AI_TOKENS_PRICE_NOT_FOUND:
    'No effective-dated price was found for the requested model, operation, and service tier.',
  AI_TOKENS_FX_REQUIRED: 'A non-USD presentation currency requires an fx resolver, which is not configured.',
  AI_TOKENS_BUDGET_EXCEEDED: 'A hard spend budget blocks this call.',
  AI_TOKENS_QUOTA_EXCEEDED: 'A hard token or operation-count quota blocks this call.',
  AI_TOKENS_INSUFFICIENT_CREDITS:
    'The wallet balance, including any overdraft, is below the required amount.',
  AI_TOKENS_HOLD_NOT_FOUND: 'The referenced hold does not exist for this tenant and scope.',
  AI_TOKENS_HOLD_EXPIRED: 'The referenced hold expired and was swept; retry via record().',
  AI_TOKENS_HOLD_ALREADY_SETTLED: 'The referenced hold was already released and cannot be captured.',
  AI_TOKENS_IDEMPOTENCY_CONFLICT:
    'The idempotency key was reused with a different payload, or the record was already reversed.',
  AI_TOKENS_STREAM_USAGE_MISSING:
    'The stream ended without provider usage and no tokenizer fallback was available.',
  AI_TOKENS_STORE_ERROR: 'The persistence adapter raised an unexpected error.',
}
