<div align="center">

# @bymax-one/nest-ai-tokens

[![npm](https://img.shields.io/npm/v/@bymax-one/nest-ai-tokens.svg)](https://www.npmjs.com/package/@bymax-one/nest-ai-tokens)
[![npm downloads](https://img.shields.io/npm/dm/@bymax-one/nest-ai-tokens.svg)](https://www.npmjs.com/package/@bymax-one/nest-ai-tokens)
[![CI](https://github.com/bymaxone/nest-ai-tokens/actions/workflows/ci.yml/badge.svg)](https://github.com/bymaxone/nest-ai-tokens/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/bymaxone/nest-ai-tokens/branch/main/graph/badge.svg)](https://codecov.io/gh/bymaxone/nest-ai-tokens)
[![Mutation tested](https://img.shields.io/badge/mutation%20tested-%E2%89%A595%25-brightgreen)](https://github.com/bymaxone/nest-ai-tokens)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/bymaxone/nest-ai-tokens/badge)](https://securityscorecards.dev/viewer/?uri=github.com/bymaxone/nest-ai-tokens)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript 5.x](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![Node >= 24](https://img.shields.io/badge/Node-%3E%3D24-green)](https://nodejs.org/)

**AI token metering & usage-based billing for NestJS 11.**

_Normalizer-first across 9+ providers · exact bigint nano-USD accounting · immutable append-only ledger · prepaid wallets · multi-dimension budgets · **first-class markup/margin for reselling AI.**_

</div>

---

## Overview

`@bymax-one/nest-ai-tokens` eliminates the multi-tool assembly required to meter and bill AI usage in a NestJS application. A team that wants token accounting today must stitch together a tokenizer, a price dataset, a billing engine, a proxy for enforcement, and an observability tool — every one either a separate process, an external SaaS, or a stateless calculator with no ledger, no budgets, and no markup.

This library provides all of it in-process:

- **In-request enforcement** as a NestJS guard + interceptor — no proxy/sidecar/external hop.
- **Exact token accounting** across every billing dimension providers report: cached tokens (up to 10× error if mishandled), reasoning tokens (double-billing trap on OpenAI/OpenRouter), service tiers (batch at standard = 2× wrong), server-side surcharges (Anthropic web search is $10/1k calls inside `usage`).
- **Point-in-time pricing** — a ledger entry is rated at the price in effect at the call timestamp, never re-rated at today's price.
- **First-class markup** — the difference between provider cost and customer price is configuration, not application code (`markup: 4.0` → end-users pay 4× the provider cost). This is the SaaS profit lever, and it is the library's differentiator.
- **Prepaid wallets + count/token/spend budgets** — race-safe, Redis-accelerated optional.
- **Zero runtime dependencies** — `"dependencies": {}`. NestJS, Prisma, ioredis, and OpenTelemetry are all peer dependencies.

---

## Features

| Capability | Detail |
|---|---|
| **9 provider normalizers** | OpenAI Chat, OpenAI Responses, OpenAI-compatible (DeepSeek/xAI/Groq/Azure), Anthropic, Google Gemini (+ Vertex), AWS Bedrock Converse, Mistral, OpenRouter, Vercel AI SDK v5/v6 |
| **Provider-agnostic** | No provider SDK peer dep. Normalizers consume plain objects — the library never makes the LLM call. |
| **Exact money math** | All persisted amounts are `bigint` nano-USD. No float arithmetic on money paths. |
| **Append-only ledger** | Immutable entries; corrections are compensating records. Exactly-once accounting via content-derived idempotency keys. |
| **Hash-chain integrity** | Optional per-entry hash chain so tampering with any ledger row is detectable. |
| **Hold → capture lifecycle** | Pre-flight spend hold before the handler runs; settled to actuals after. Streaming-safe via `StreamUsageCollector`. |
| **Markup / resale** | Fixed multiplier or per-call `IMarkupPolicy`. Applied in both rating modes. Billed amount = `rawCostNanoUsd × markup`. |
| **Prepaid wallets** | Append-only grant/debit/refund/adjust entries; configurable burn order (expiry/priority/FIFO); overdraft support. |
| **Multi-dimension budgets** | Cap spend, token count, and operation count per scope per window (daily/weekly/monthly/total). Hard block or soft alert. |
| **Budget counter (Redis)** | Optional `RedisBudgetCounterStore` — single atomic Lua script (`incrIfBelow`) for sub-ms cross-replica enforcement. |
| **Streaming capture** | `StreamUsageCollector` accumulates chunks; prefers provider final usage; falls back to tokenizer on abort. |
| **Usage reports** | Summarize by scope/feature/model/date; currency conversion; CSV and JSON export; per-model analytics. |
| **Events** | Typed events (record/hold/capture/release/budget threshold/wallet) via `@nestjs/event-emitter` (optional peer). |
| **OpenTelemetry** | Optional `@opentelemetry/api` sink — traces every metering call. |
| **Five subpaths** | `"."` server · `"./shared"` zero-dep · `"./prices"` seed data · `"./prisma"` adapter · `"./redis"` counter |

---

## Subpath Exports

| Subpath | What it contains | Runtime deps |
|---|---|---|
| `@bymax-one/nest-ai-tokens` | Dynamic module, services, guard, interceptor, decorators, collector, ports, errors | NestJS (peer) |
| `@bymax-one/nest-ai-tokens/shared` | Normalizers, pure cost math, types, catalogs, error codes | Zero |
| `@bymax-one/nest-ai-tokens/prices` | `MODEL_PRICES_SEED` — pinned price snapshot (data-only, large; imported lazily) | Zero |
| `@bymax-one/nest-ai-tokens/prisma` | `PrismaAiTokensStore` — the official PostgreSQL adapter | `@prisma/client` (peer) |
| `@bymax-one/nest-ai-tokens/redis` | `RedisBudgetCounterStore` — optional fast budget counter | `ioredis` (peer) |

> The `./shared` subpath is framework-free and edge-safe — use it in frontends, workers, and edge functions that must not pull NestJS.
> The `./prices` subpath exists so `./shared` stays within the family's tiny-bundle budget.

### Artifact sizes (brotli)

| Artifact | Brotli size | Budget |
|---|---|---|
| server (`@bymax-one/nest-ai-tokens`) | 37 KB | < 40 KB |
| shared (`@bymax-one/nest-ai-tokens/shared`) | 5 KB | < 10 KB |
| prisma (`@bymax-one/nest-ai-tokens/prisma`) | 10 KB | < 15 KB |
| redis (`@bymax-one/nest-ai-tokens/redis`) | 1.1 KB | < 5 KB |
| prices (data-only, exempt from budget) | 1.3 KB | exempt |

---

## Quick Start (60 seconds)

### 1 — Install

```bash
npm i @bymax-one/nest-ai-tokens
```

Required peers (if not already present):

```bash
npm i @nestjs/common @nestjs/core reflect-metadata rxjs
# Persistence:
npm i @prisma/client
```

### 2 — Register the module

```typescript
import { Module } from '@nestjs/common'
import { BymaxAiTokensModule } from '@bymax-one/nest-ai-tokens'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'

@Module({
  imports: [
    BymaxAiTokensModule.forRootAsync({
      imports: [PrismaModule],
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        store: new PrismaAiTokensStore(prisma),
        // The resale lever — end-users pay 4× provider cost:
        markup: 4.0,
        wallets: { creditRateNanoUsd: 5_000_000_000n }, // 1 credit = $5
        budgets: { defaultPolicy: 'block', alertThresholds: [0.8, 1.0] },
        pricing: { seedFromSnapshot: true },             // seed price table on first boot
      }),
    }),
  ],
})
export class AppModule {}
```

### 3 — Record usage (post-hoc, observe-only)

```typescript
import { Injectable } from '@nestjs/common'
import { MeteringService, providerPresets } from '@bymax-one/nest-ai-tokens'
import { deriveIdempotencyKey } from '@bymax-one/nest-ai-tokens/shared'

@Injectable()
export class WorkoutAiService {
  constructor(private readonly metering: MeteringService) {}

  async generate(tenantId: string, userId: string, jobId: string) {
    const res = await this.openai.chat.completions.create({ model: 'gpt-4o', messages: [] })
    await this.metering.record({
      usage: res.usage,
      preset: providerPresets.openaiChat,
      context: {
        tenantId,
        scope: { type: 'user', id: userId },
        feature: 'workout.generate',
        idempotencyKey: deriveIdempotencyKey({ jobId }), // retry-safe
      },
    })
    return res.choices[0]?.message.content
  }
}
```

### 4 — Enforced metering via guard + interceptor

```typescript
import { Controller, Post, Get, Body, UseGuards, UseInterceptors, Req } from '@nestjs/common'
import {
  BudgetGuard, MeteringInterceptor, Meter, RequireBudget,
  MeteringService, toJsonSafe, providerPresets,
} from '@bymax-one/nest-ai-tokens'

@Controller('ai')
@UseGuards(BudgetGuard)
@UseInterceptors(MeteringInterceptor)
export class AiController {
  constructor(private readonly metering: MeteringService) {}

  @Post('summarize')
  @RequireBudget({ scope: 'tenant', estimate: { tokens: 3_000 } })
  @Meter({ feature: 'doc.summarize', scope: 'tenant', preset: providerPresets.anthropic, exposeHeaders: true })
  async summarize(@Body() dto: { content: string }) {
    // Guard checks budget and places a hold; interceptor settles it with the handler's actual usage.
    return this.ai.summarize(dto.content) // returns { summary, usage }
  }

  @Get('me/usage')
  async myUsage(@Req() req: { user: { tenantId: string; id: string } }) {
    const status = await this.metering.getStatus(req.user.tenantId, { type: 'user', id: req.user.id })
    return toJsonSafe(status) // bigint → decimal strings for JSON serialization
  }
}
```

---

## Configuration

`BymaxAiTokensModule.forRoot(options)` / `.forRootAsync({ useFactory })` accept `BymaxAiTokensModuleOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `store` | `IAiTokensStore` | — (required) | Persistence adapter (use `PrismaAiTokensStore`) |
| `scopeResolver` | `(ctx) => MeteringContext` | — | Resolves the caller's scope from the request (required for guard/interceptor) |
| `ratingMode` | `'rate-table' \| 'provider-reported'` | `'rate-table'` | Default cost rating mode |
| `markup` | `number \| IMarkupPolicy` | `1.0` | The resale multiplier (e.g. `4.0` = 4× provider cost) |
| `pricing.seedFromSnapshot` | `boolean` | `false` | Seed `MODEL_PRICES_SEED` into the registry on first boot |
| `wallets.creditRateNanoUsd` | `bigint` | — | Exchange rate: 1 credit = this many nano-USD |
| `wallets.burnOrder` | `'expiry' \| 'priority' \| 'fifo'` | `'expiry'` | Order in which grants are consumed |
| `budgets.defaultPolicy` | `'block' \| 'alert'` | `'alert'` | Default enforcement when a budget is exhausted |
| `budgets.alertThresholds` | `number[]` | `[0.8, 1.0]` | Soft-threshold events at these fractions |
| `holds.ttlSeconds` | `number` | `300` | Spend-hold TTL; the reaper voids expired holds |
| `telemetry` | `ITelemetrySink` | no-op | OpenTelemetry sink (pass `OtelTelemetrySink`) |

---

## Providers Matrix

| Provider | API | Normalizer |
|---|---|---|
| OpenAI | Chat Completions | `normalizeOpenAiChatUsage` / `providerPresets.openaiChat` |
| OpenAI | Responses API | `normalizeOpenAiResponsesUsage` / `providerPresets.openaiResponses` |
| OpenAI-compatible | DeepSeek, xAI, Groq, Azure OpenAI | `normalizeOpenAiCompatibleUsage` / `providerPresets.openaiCompatible` |
| Anthropic | Messages API | `normalizeAnthropicUsage` / `providerPresets.anthropic` |
| Google | Gemini / Vertex AI | `normalizeGeminiUsage` / `providerPresets.gemini` |
| AWS | Bedrock Converse | `normalizeBedrockConverseUsage` / `providerPresets.bedrockConverse` |
| Mistral | Chat API | `normalizeMistralUsage` / `providerPresets.mistral` |
| OpenRouter | Chat | `normalizeOpenRouterUsage` / `providerPresets.openrouter` (provider-reported cost) |
| Vercel | AI SDK v5/v6 | `normalizeVercelAiSdkUsage` / `providerPresets.vercelAiSdk` |

All normalizers are pure functions over plain objects — no provider SDK peer dependency. Pass the raw response object and get back a `NormalizedUsage`.

---

## Pricing & Markup — The Resale Lever

The fundamental difference between "what the provider charged you" and "what you charge your users" is the **markup multiplier**. This library makes that multiplier a first-class configuration option.

```typescript
// Configure at module level:
BymaxAiTokensModule.forRootAsync({
  useFactory: (prisma) => ({
    store: new PrismaAiTokensStore(prisma),
    markup: 4.0,                                      // 4× resale margin
    wallets: { creditRateNanoUsd: 5_000_000_000n },   // sell credits at $5 each
  }),
})

// Example ledger entry:
// Provider cost: $0.005 (5_000_000n nano-USD)
// Billed to user: $0.020 (20_000_000n nano-USD, after 4× markup)
// Margin: $0.015 per call
```

For per-tenant or per-feature pricing, implement `IMarkupPolicy`:

```typescript
class MyMarkupPolicy implements IMarkupPolicy {
  resolve(ctx: MeteringContext): number | Promise<number> {
    return ctx.feature === 'premium.summarize' ? 5.0 : 3.0
  }
}
```

Every billed amount is stored in both `rawCostNanoUsd` (provider cost) and `billedCostNanoUsd` (after markup), so reports can show provider cost, margin, and customer-facing cost independently.

---

## Wallets & Budgets

### Prepaid Wallets

```typescript
// Grant credits (e.g. on subscription renewal):
await wallets.grant(
  { tenantId, ownerType: 'user', ownerId: userId },
  {
    amountNanoUsd: 25_000_000_000n,         // $25 in credits
    expiresAt: nextRenewal,
    idempotencyKey: `allowance:${userId}:${cycle}`,
    reason: 'monthly plan allowance',
  },
)

// Credits are debited automatically when the ledger posts a billed cost.
// Check balance:
const wallet = await wallets.getOrCreate({ tenantId, ownerType: 'user', ownerId: userId })
console.log(wallet.balanceNanoUsd) // current balance
```

### Multi-Dimension Budgets

```typescript
// Set a monthly budget (anchored to subscription renewal, not calendar):
await budgets.upsertBudget({
  tenantId,
  scope: { type: 'user', id: userId },
  features: ['workout.generate'],
  limitCount: plan.maxAIGenerationsPerMonth,   // count quota
  limitTokens: plan.aiTokensMonthly,           // token quota
  window: 'month',
  anchorAt: subscription.renewalDate,          // renewal-anchored window
  softThresholds: [0.8, 1.0],
  policy: 'block',
})

// Check status:
const status = await metering.getStatus(tenantId, { type: 'user', id: userId })
// status[].remaining, status[].exhausted, status[].policy
```

**Unlimited semantics:** no budget row = unlimited. `limit = 0` = hard block. Never use `null` or `0` to mean unlimited (see §22 migration notes).

---

## Streaming

```typescript
const collector = new StreamUsageCollector({
  provider: 'openai',
  model: 'gpt-4o',
  preset: providerPresets.openaiChat,
})

const hold = await metering.hold(ctx, {
  provider: 'openai', model: 'gpt-4o', operation: 'chat',
  inputTokens: estimatedInput, maxOutputTokens: 1024,
})

try {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o', messages, stream: true,
    stream_options: { include_usage: true },
  })
  for await (const chunk of stream) {
    collector.push(chunk)               // accumulates chunks, watches for the final usage object
    res.write(chunk.choices[0]?.delta?.content ?? '')
  }
} catch (err) {
  // Aborted or provider error: bill partial usage. capture() is idempotent.
  await metering.capture(hold, collector)
  throw err
}
await metering.capture(hold, collector) // settle with provider-final actuals
```

On abort, the collector falls back to a tokenizer estimate of the output tokens so the aborted call is still billed for what it produced.

---

## Reporting & Status

```typescript
// Usage summary — by feature, for the last 30 days:
const summary = await metering.summarize({
  tenantId,
  scope: { type: 'user', id: userId },
  from: thirtyDaysAgo,
  to: now,
  groupBy: ['feature', 'model'],
})

// Export as CSV (streaming):
const csv = await reports.export({
  tenantId, from, to, format: 'csv',
})
csv.pipe(res)

// Access status / remaining budget:
const status = await metering.getStatus(tenantId, { type: 'user', id: userId })
return toJsonSafe(status) // bigint → decimal strings
```

---

## Events

When `@nestjs/event-emitter` is installed and `EventEmitterModule.forRoot()` is registered, the library emits typed events on the NestJS event bus:

| Event | When |
|---|---|
| `ai-tokens.record.posted` | A usage record is posted to the ledger |
| `ai-tokens.hold.placed` | A spend hold is placed |
| `ai-tokens.hold.captured` | A hold is settled with actuals |
| `ai-tokens.hold.released` | A hold is released without charging |
| `ai-tokens.budget.threshold` | A soft-threshold alert fires |
| `ai-tokens.wallet.depleted` | A wallet balance reaches zero |

All event payloads use `bigint` nano-USD internally and `string` decimal at JSON boundaries.

---

## Error Codes

All errors are `AiTokensException extends HttpException`. Use the exported `AI_TOKENS_ERROR_CODES` catalog in switch/catch:

| Code | HTTP | When |
|---|---|---|
| `AI_TOKENS_NOT_CONFIGURED` | 503 | Service invoked before async init completed |
| `AI_TOKENS_INVALID_CONFIG` | 500 | Bad markup, negative limits, missing `scopeResolver`, missing fx |
| `AI_TOKENS_UNKNOWN_PROVIDER` | 400 | No preset/normalizer and usage is not already `NormalizedUsage` |
| `AI_TOKENS_USAGE_MALFORMED` | 422 | Normalizer could not read required token fields |
| `AI_TOKENS_PRICE_NOT_FOUND` | 422 | No effective-dated rate after 6-step resolution chain (strict mode) |
| `AI_TOKENS_FX_REQUIRED` | 500 | `currency !== 'USD'` with no `fx` resolver |
| `AI_TOKENS_BUDGET_EXCEEDED` | 402 | A hard spend budget blocks the call |
| `AI_TOKENS_QUOTA_EXCEEDED` | 429 | A hard token/count quota blocks the call |
| `AI_TOKENS_INSUFFICIENT_CREDITS` | 402 | Wallet debit failed (balance + overdraft below amount) |
| `AI_TOKENS_HOLD_NOT_FOUND` | 404 | `capture()`/`release()` on an unknown or cross-tenant hold |
| `AI_TOKENS_HOLD_EXPIRED` | 410 | `capture()` after the reaper swept the hold (retry via `record()`) |
| `AI_TOKENS_HOLD_ALREADY_SETTLED` | 409 | `capture()` after `release()` |
| `AI_TOKENS_IDEMPOTENCY_CONFLICT` | 409 | Same idempotency key, different payload hash; or reversing an already-reversed record |
| `AI_TOKENS_STREAM_USAGE_MISSING` | 422 | Stream ended without provider usage and no tokenizer fallback available |
| `AI_TOKENS_STORE_ERROR` | 502 | Persistence adapter raised an unmapped error |

---

## BigInt & JSON

`bigint` does not survive `JSON.stringify`. Use `toJsonSafe()` at controller boundaries:

```typescript
import { toJsonSafe } from '@bymax-one/nest-ai-tokens'

// In your controller:
return toJsonSafe(await metering.getStatus(tenantId, scope))
// bigint fields (balanceNanoUsd, billedCostNanoUsd, etc.) become decimal strings.

// For display/formatting:
import { formatNanoUsd } from '@bymax-one/nest-ai-tokens/shared'
formatNanoUsd(5_000_000n)                                        // '$0.005000'
formatNanoUsd(5_000_000n, { currency: 'BRL', fxRateNano: 5_000_000_000n }) // '0.025000 BRL'
```

---

## Migration from bymax-fitness

If you are migrating the `_commons_/ai/*` layer from `bymax-fitness`, see [docs/technical_specification.md §22](./docs/technical_specification.md) for the full field-by-field mapping table, the zero/null → unlimited translation rules, and backfill notes.

Key caution: `bymax-fitness` treats `0` as unlimited on most paths and as blocked on one path. Do not import plan rows verbatim. Translate `0`/`null` limits to **no budget row** (the normative unlimited representation in this library).

---

## Testing

```bash
# Unit tests (100% line/branch coverage):
pnpm test
pnpm test:cov

# E2E (Testcontainers — requires Docker):
pnpm test:e2e

# Mutation gate (Stryker, ~10-20 min):
pnpm mutation

# Type-check + JSDoc coverage + docs fixture:
pnpm docs:check && pnpm typecheck

# Lint:
pnpm lint

# Bundle size budgets:
pnpm build && pnpm size
```

---

## Contributing

See [AGENTS.md](./AGENTS.md) for the architecture map and [CLAUDE.md](./CLAUDE.md) for the critical engineering rules (money-integer invariant, ledger immutability, side-effect matrix).

Issues: [github.com/bymaxone/nest-ai-tokens/issues](https://github.com/bymaxone/nest-ai-tokens/issues)
Security: see [SECURITY.md](./SECURITY.md).

---

## License

MIT — see [LICENSE](./LICENSE).
