/**
 * @fileoverview Type-check-only compilation fixture for the `@example` blocks in
 * JSDoc across the library's public API. This file is NEVER executed at runtime;
 * it only needs to compile cleanly via `tsconfig.e2e.json` (which sets up path
 * aliases for all five subpaths).
 *
 * Run:  pnpm docs:check   (runs node scripts/check-jsdoc.mjs + tsc -p tsconfig.e2e.json)
 *
 * Adding a new example: copy the snippet from the JSDoc block and place it in the
 * appropriate section below.  Keep every block compilable — no `// @ts-ignore`.
 */

// — shared: money math —
import {
  perMillion,
  floatUsdToNanoUsd,
  formatNanoUsd,
  resolveMultiplier4dp,
  applyMarkup,
  computeCostNanoUsd,
} from '@bymax-one/nest-ai-tokens/shared'

const _perMillion: bigint = perMillion(1000, 5_000_000_000n) // 5_000_000n
const _floatToNano: bigint = floatUsdToNanoUsd(0.005) // 5_000_000n
const _formatted: string = formatNanoUsd(5_000_000n) // '$0.005000'
const _formatted2: string = formatNanoUsd(5_000_000n, { currency: 'BRL', fxRateNano: 5_000_000_000n })
const _multiplier: number = resolveMultiplier4dp(1.23456) // 1.2346

// applyMarkup: 4× resale on a $0.005 provider cost → $0.020 billed
const _billed: bigint = applyMarkup(5_000_000n, 4.0) // 20_000_000n

// — shared: cost engine —
import type { NormalizedUsage, PriceVersion } from '@bymax-one/nest-ai-tokens/shared'

// computeCostNanoUsd is exercised by unit tests — the type-level shape is verified here.
declare const _usage: NormalizedUsage
declare const _rate: PriceVersion
const _cost = computeCostNanoUsd(_usage, _rate)
const _totalNanoUsd: bigint = _cost.totalNanoUsd
const _tokenNanoUsd: bigint = _cost.tokenNanoUsd
const _surchargeNanoUsd: bigint = _cost.surchargeNanoUsd

// — shared: normalizers —
import {
  normalizeOpenAiChatUsage,
  normalizeOpenAiCompatibleUsage,
  normalizeAnthropicUsage,
  normalizeGeminiUsage,
  normalizeMistralUsage,
  normalizeOpenAiResponsesUsage,
  normalizeOpenRouterUsage,
  normalizeVercelAiSdkUsage,
  normalizeBedrockConverseUsage,
} from '@bymax-one/nest-ai-tokens/shared'

// Each call returns NormalizedUsage — shape validated at compile time.
const _openaiChat: NormalizedUsage = normalizeOpenAiChatUsage({
  model: 'gpt-4o',
  usage: { prompt_tokens: 100, completion_tokens: 40 },
})
const _openaiCompat: NormalizedUsage = normalizeOpenAiCompatibleUsage({
  model: 'some-model',
  usage: { prompt_tokens: 10, completion_tokens: 5 },
})
const _anthropic: NormalizedUsage = normalizeAnthropicUsage({
  model: 'claude-opus-4-5',
  usage: { input_tokens: 200, output_tokens: 80 },
})
const _gemini: NormalizedUsage = normalizeGeminiUsage({
  model: 'gemini-2.5-pro',
  usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
})
const _mistral: NormalizedUsage = normalizeMistralUsage({
  model: 'mistral-large-latest',
  usage: { prompt_tokens: 30, completion_tokens: 15 },
})
const _responses: NormalizedUsage = normalizeOpenAiResponsesUsage({
  model: 'gpt-4o',
  usage: { input_tokens: 100, output_tokens: 40 },
})
const _openrouter: NormalizedUsage = normalizeOpenRouterUsage({
  model: 'openai/gpt-4o',
  usage: { prompt_tokens: 50, completion_tokens: 20 },
})
const _vercel: NormalizedUsage = normalizeVercelAiSdkUsage({
  model: 'gpt-4o',
  usage: { promptTokens: 100, completionTokens: 40 },
})
const _bedrock: NormalizedUsage = normalizeBedrockConverseUsage({
  $metadata: {},
  output: { message: { role: 'assistant', content: [] } },
  usage: { inputTokens: 100, outputTokens: 40 },
})

// — shared: idempotency —
import { deriveIdempotencyKey } from '@bymax-one/nest-ai-tokens/shared'

// deriveIdempotencyKey takes a single payload; equal payloads produce the same key.
const _key: string = deriveIdempotencyKey({
  tenantId: 'tenant-1',
  endpoint: 'POST /ai/chat',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello' }],
})

// — server: error —
import { AiTokensException } from '@bymax-one/nest-ai-tokens'
import type { AiTokensErrorCode } from '@bymax-one/nest-ai-tokens/shared'

const _exCode: AiTokensErrorCode = 'AI_TOKENS_BUDGET_EXCEEDED'
const _ex = new AiTokensException(_exCode)
const _exMsg: string = _ex.message

// — server: toJsonSafe —
import { toJsonSafe } from '@bymax-one/nest-ai-tokens'

const _safeValue = toJsonSafe({ amount: 5_000_000n })
// The result is a plain object with BigInt converted to strings.

// — server: StreamUsageCollector —
import { StreamUsageCollector } from '@bymax-one/nest-ai-tokens'

const _collector = new StreamUsageCollector({ provider: 'openai-chat', model: 'gpt-4o' })
const _collectorUsage: NormalizedUsage = await _collector.finalize()

// — suppress unused-variable warnings for the fixture constants —
void _perMillion
void _floatToNano
void _formatted
void _formatted2
void _multiplier
void _billed
void _totalNanoUsd
void _tokenNanoUsd
void _surchargeNanoUsd
void _openaiChat
void _openaiCompat
void _anthropic
void _gemini
void _mistral
void _responses
void _openrouter
void _vercel
void _bedrock
void _key
void _exCode
void _ex
void _exMsg
void _safeValue
void _collector
void _collectorUsage
