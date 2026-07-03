/**
 * @fileoverview The eleven `Symbol()` dependency-injection tokens (spec §4.5).
 * `forRoot()` registers the resolved options plus each store port and optional
 * collaborator under these tokens; a host may override any individual port by
 * binding its token directly (§4.6).
 * @layer server
 */

/** The fully-resolved {@link ResolvedAiTokensOptions} object. */
export const BYMAX_AI_TOKENS_OPTIONS = Symbol('BYMAX_AI_TOKENS_OPTIONS')
/** The ledger store port. */
export const BYMAX_AI_TOKENS_LEDGER_STORE = Symbol('BYMAX_AI_TOKENS_LEDGER_STORE')
/** The pricing store port. */
export const BYMAX_AI_TOKENS_PRICING_STORE = Symbol('BYMAX_AI_TOKENS_PRICING_STORE')
/** The wallet store port (only bound when wallets are enabled). */
export const BYMAX_AI_TOKENS_WALLET_STORE = Symbol('BYMAX_AI_TOKENS_WALLET_STORE')
/** The budget store port (only bound when budgets are enabled). */
export const BYMAX_AI_TOKENS_BUDGET_STORE = Symbol('BYMAX_AI_TOKENS_BUDGET_STORE')
/** The optional live budget counter port. */
export const BYMAX_AI_TOKENS_BUDGET_COUNTER = Symbol('BYMAX_AI_TOKENS_BUDGET_COUNTER')
/** The optional tokenizer port. */
export const BYMAX_AI_TOKENS_TOKENIZER = Symbol('BYMAX_AI_TOKENS_TOKENIZER')
/** The optional telemetry sink port. */
export const BYMAX_AI_TOKENS_TELEMETRY = Symbol('BYMAX_AI_TOKENS_TELEMETRY')
/** The optional event sink port. */
export const BYMAX_AI_TOKENS_EVENT_SINK = Symbol('BYMAX_AI_TOKENS_EVENT_SINK')
/** The optional content sidecar port. */
export const BYMAX_AI_TOKENS_CONTENT_STORE = Symbol('BYMAX_AI_TOKENS_CONTENT_STORE')
/** The optional logger. */
export const BYMAX_AI_TOKENS_LOGGER = Symbol('BYMAX_AI_TOKENS_LOGGER')
