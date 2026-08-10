<p align="center">
  <img src="https://img.shields.io/badge/%40bymax--one-nest--ai--tokens-000000?style=for-the-badge&logo=nestjs&logoColor=E0234E" alt="@bymax-one/nest-ai-tokens" />
</p>

<h1 align="center">@bymax-one/nest-ai-tokens</h1>

<p align="center">
  <strong>AI token metering and usage-based billing for NestJS</strong><br />
  <sub>9 Provider Normalizers · Exact bigint nano-USD · Append-only Ledger · Hash-chain Integrity · Prepaid Wallets · Budgets · Streaming · Zero Runtime Dependencies</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bymax-one/nest-ai-tokens"><img src="https://img.shields.io/npm/v/@bymax-one/nest-ai-tokens?style=flat-square&colorA=000000&colorB=000000" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@bymax-one/nest-ai-tokens"><img src="https://img.shields.io/npm/dm/@bymax-one/nest-ai-tokens?style=flat-square&colorA=000000&colorB=000000" alt="npm downloads" /></a>
  <a href="https://github.com/bymaxone/nest-ai-tokens/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/bymaxone/nest-ai-tokens/ci.yml?branch=main&style=flat-square&colorA=000000&label=CI" alt="CI status" /></a>
  <a href="https://github.com/bymaxone/nest-ai-tokens/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&colorA=000000" alt="coverage" /></a>
  <a href="https://github.com/bymaxone/nest-ai-tokens/blob/main/docs/mutation_testing_results.md"><img src="https://img.shields.io/badge/mutation-100%25-brightgreen?style=flat-square&colorA=000000" alt="mutation score" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/bymaxone/nest-ai-tokens"><img src="https://api.scorecard.dev/projects/github.com/bymaxone/nest-ai-tokens/badge?style=flat-square" alt="OpenSSF Scorecard" /></a>
  <a href="https://github.com/bymaxone/nest-ai-tokens/blob/main/LICENSE"><img src="https://img.shields.io/github/license/bymaxone/nest-ai-tokens?style=flat-square&colorA=000000&colorB=000000" alt="license" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
</p>

<p align="center">
  <a href="https://github.com/bymaxone/nest-ai-tokens">GitHub</a> ·
  <a href="https://github.com/bymaxone/nest-ai-tokens/issues">Issues</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-api-reference">API Reference</a> ·
  <a href="https://github.com/bymaxone/nest-ai-tokens-example">Example App</a>
</p>

---

## ✨ Overview

`@bymax-one/nest-ai-tokens` meters AI usage and bills it, in-process. Instead of assembling a
proxy for enforcement, a ledger for accounting, a price table for rating and a wallet for
prepaid credit — four systems that must agree on what a call cost — you install one library
and get all of it behind a NestJS guard and interceptor.

The library has **zero direct dependencies**. NestJS, Prisma, `ioredis`, the event emitter and
OpenTelemetry all arrive as peer dependencies, and the optional ones are never imported unless
the feature that needs them is enabled.

### Why nest-ai-tokens?

- **Enforcement happens in the request.** A guard refuses the call before the handler runs
  and an interceptor settles the actual usage after it — no proxy to deploy, no sidecar to
  keep alive, no external hop that can fail open.
- **Money is exact by construction.** Every persisted amount is `bigint` nano-USD. There is no
  float arithmetic on a money path, because a rounding difference there is a number a customer
  is charged.
- **The ledger is evidence, not state.** Entries are appended and corrections are compensating
  records; with the optional hash chain on, a row edited in the database stops matching the
  chain that follows it.
- **Charging twice is prevented by the database.** The idempotency key carries a unique
  constraint, and the replay path is that violation being recognized as a conflict — not
  application care that someone can forget.

---

## 🔥 Features

### 📊 Metering

- ✅ **Nine provider normalizers** — OpenAI Chat, OpenAI Responses, OpenAI-compatible
  (DeepSeek / xAI / Groq / Azure), Anthropic, Gemini, Bedrock Converse, Mistral, OpenRouter
  and the Vercel AI SDK, all folded into one usage shape
- ✅ **Provider-agnostic by construction** — normalizers consume plain objects, so no provider
  SDK is a dependency and this library never makes the model call itself
- ✅ **Every billing dimension** — cached tokens, reasoning tokens, audio and image units, and
  the write/read split providers report separately
- ✅ **Streaming capture** — `StreamUsageCollector` accumulates chunks and prefers the
  provider's final usage, falling back to its own count when a stream is cut short

### 💰 Money & Ledger

- ✅ **Exact `bigint` nano-USD** — on every persisted amount; no float arithmetic on a money
  path
- ✅ **Point-in-time rating** — an entry is priced at the rate in effect at the call
  timestamp, and never re-rated by a later price change
- ✅ **Append-only ledger** — corrections are compensating records that point at what they
  reverse; nothing is updated in place
- ✅ **Hash-chain integrity** — optional per-entry chain over the previous posted entry, so a
  row edited directly in the database is detectable
- ✅ **Exactly-once accounting** — a unique constraint on the idempotency key; the violation
  is what the replay path recognizes as a conflict
- ✅ **Markup as configuration** — a fixed multiplier or a per-call `IMarkupPolicy`, applied
  in both rating modes, so the resale spread is not application code

### 🛡️ Enforcement

- ✅ **Hold → capture lifecycle** — the guard places a spend hold before the handler runs when
  an estimate is declared; the interceptor settles it to actuals afterwards
- ✅ **Multi-dimension budgets** — cap spend, token count and operation count per scope per
  window (daily / weekly / monthly), hard or soft
- ✅ **Atomic budget counter** — the optional `RedisBudgetCounterStore` runs check and
  increment as one Lua script, so two concurrent requests cannot both fit under a cap that
  holds one
- ✅ **Prepaid wallets** — append-only grant / debit / refund / adjust entries, with a
  configurable burn order (expiry, priority, FIFO)

### 🧩 Developer Experience

- ✅ **Zero runtime dependencies** — Prisma, `ioredis`, the event emitter and OpenTelemetry
  all arrive as peers, and the optional ones are imported only when enabled
- ✅ **Five subpaths** — `.` server · `./shared` zero-dependency contracts · `./prices` seed
  data · `./prisma` the PostgreSQL store · `./redis` the budget counter
- ✅ **Usage reports** — summarize by scope, feature, model or date, with currency conversion
  and CSV or JSON export
- ✅ **Typed events** — ten emitted event types over `@nestjs/event-emitter`, optional
  (`wallet.low_balance` is declared in the catalog and reserved; nothing emits it yet)
- ✅ **OpenTelemetry** — an optional sink that traces every metering call, carrying model and
  operation and never prompt or completion text
- ✅ **Typed end to end** — TypeScript `strict` with `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`; zero `any`

---

## 📦 Subpath Exports

| Subpath                            | What it contains                                                                   | Runtime deps            |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ----------------------- |
| `@bymax-one/nest-ai-tokens`        | Dynamic module, services, guard, interceptor, decorators, collector, ports, errors | NestJS (peer)           |
| `@bymax-one/nest-ai-tokens/shared` | Normalizers, pure cost math, types, catalogs, error codes                          | Zero                    |
| `@bymax-one/nest-ai-tokens/prices` | `MODEL_PRICES_SEED` — pinned price snapshot (data-only, large; imported lazily)    | Zero                    |
| `@bymax-one/nest-ai-tokens/prisma` | `PrismaAiTokensStore` — the official PostgreSQL adapter                            | `@prisma/client` (peer) |
| `@bymax-one/nest-ai-tokens/redis`  | `RedisBudgetCounterStore` — optional fast budget counter                           | `ioredis` (peer)        |

> The `./shared` subpath is framework-free and edge-safe — use it in frontends, workers, and edge functions that must not pull NestJS.
> The `./prices` subpath exists so `./shared` stays within the family's tiny-bundle budget.

### Artifact sizes (brotli)

| Artifact                                    | Brotli size | Budget  |
| ------------------------------------------- | ----------- | ------- |
| server (`@bymax-one/nest-ai-tokens`)        | 37 KB       | < 40 KB |
| shared (`@bymax-one/nest-ai-tokens/shared`) | 5 KB        | < 10 KB |
| prisma (`@bymax-one/nest-ai-tokens/prisma`) | 10 KB       | < 15 KB |
| redis (`@bymax-one/nest-ai-tokens/redis`)   | 1.1 KB      | < 5 KB  |
| prices (data-only, exempt from budget)      | 1.3 KB      | exempt  |

---

## 🚀 Quick Start

### 1 — Install

```bash
npm i @bymax-one/nest-ai-tokens
```

Required peers (if not already present):

```bash
npm i @nestjs/common @nestjs/core reflect-metadata rxjs
# Persistence:
npm i @prisma/client
# Prisma 7 only — the client is opened through a driver adapter:
npm i @prisma/adapter-pg
```

> **Prisma 6 and 7 are both supported.** The adapter talks to PostgreSQL through
> parameterized raw SQL and never touches a generated model delegate, so the same
> code runs on either. What differs is how _your application_ builds the client it
> hands over:
>
> ```typescript
> // Prisma 6
> const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
>
> // Prisma 7 — `datasourceUrl` was removed; open through a driver adapter
> import { PrismaPg } from '@prisma/adapter-pg'
> const prisma = new PrismaClient({
>   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
> })
> ```
>
> Prisma 7 also removed `url` from `datasource` blocks in `schema.prisma`; it
> moves to a `prisma.config.ts` at your project root. Neither change reaches this
> library's API — `PrismaAiTokensStore` receives whatever client you built.

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
        pricing: { seedFromSnapshot: true }, // seed price table on first boot
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
  BudgetGuard,
  MeteringInterceptor,
  Meter,
  RequireBudget,
  MeteringService,
  toJsonSafe,
  providerPresets,
} from '@bymax-one/nest-ai-tokens'

@Controller('ai')
@UseGuards(BudgetGuard)
@UseInterceptors(MeteringInterceptor)
export class AiController {
  constructor(private readonly metering: MeteringService) {}

  @Post('summarize')
  @RequireBudget({ scope: 'tenant', estimate: { tokens: 3_000 } })
  @Meter({
    feature: 'doc.summarize',
    scope: 'tenant',
    preset: providerPresets.anthropic,
    exposeHeaders: true,
  })
  async summarize(@Body() dto: { content: string }) {
    // Guard checks budget and places a hold; interceptor settles it with the handler's actual usage.
    return this.ai.summarize(dto.content) // returns { summary, usage }
  }

  @Get('me/usage')
  async myUsage(@Req() req: { user: { tenantId: string; id: string } }) {
    const status = await this.metering.getStatus(req.user.tenantId, {
      type: 'user',
      id: req.user.id,
    })
    return toJsonSafe(status) // bigint → decimal strings for JSON serialization
  }
}
```

---

## ⚙️ Configuration

`BymaxAiTokensModule.forRoot(options)` / `.forRootAsync({ useFactory })` accept `BymaxAiTokensModuleOptions`:

| Option                      | Type                                  | Default        | Purpose                                                                       |
| --------------------------- | ------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `store`                     | `IAiTokensStore`                      | — (required)   | Persistence adapter (use `PrismaAiTokensStore`)                               |
| `scopeResolver`             | `(ctx) => MeteringContext`            | —              | Resolves the caller's scope from the request (required for guard/interceptor) |
| `ratingMode`                | `'rate-table' \| 'provider-reported'` | `'rate-table'` | Default cost rating mode                                                      |
| `markup`                    | `number \| IMarkupPolicy`             | `1.0`          | The resale multiplier (e.g. `4.0` = 4× provider cost)                         |
| `pricing.seedFromSnapshot`  | `boolean`                             | `false`        | Seed `MODEL_PRICES_SEED` into the registry on first boot                      |
| `wallets.creditRateNanoUsd` | `bigint`                              | —              | Exchange rate: 1 credit = this many nano-USD                                  |
| `wallets.burnOrder`         | `'expiry' \| 'priority' \| 'fifo'`    | `'expiry'`     | Order in which grants are consumed                                            |
| `budgets.defaultPolicy`     | `'block' \| 'alert'`                  | `'alert'`      | Default enforcement when a budget is exhausted                                |
| `budgets.alertThresholds`   | `number[]`                            | `[0.8, 1.0]`   | Soft-threshold events at these fractions                                      |
| `holds.ttlSeconds`          | `number`                              | `300`          | Spend-hold TTL; the reaper voids expired holds                                |
| `telemetry`                 | `ITelemetrySink`                      | no-op          | OpenTelemetry sink (pass `OtelTelemetrySink`)                                 |

---

## 🧩 Providers Matrix

| Provider          | API                               | Normalizer                                                                         |
| ----------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| OpenAI            | Chat Completions                  | `normalizeOpenAiChatUsage` / `providerPresets.openaiChat`                          |
| OpenAI            | Responses API                     | `normalizeOpenAiResponsesUsage` / `providerPresets.openaiResponses`                |
| OpenAI-compatible | DeepSeek, xAI, Groq, Azure OpenAI | `normalizeOpenAiCompatibleUsage` / `providerPresets.openaiCompatible`              |
| Anthropic         | Messages API                      | `normalizeAnthropicUsage` / `providerPresets.anthropic`                            |
| Google            | Gemini / Vertex AI                | `normalizeGeminiUsage` / `providerPresets.gemini`                                  |
| AWS               | Bedrock Converse                  | `normalizeBedrockConverseUsage` / `providerPresets.bedrockConverse`                |
| Mistral           | Chat API                          | `normalizeMistralUsage` / `providerPresets.mistral`                                |
| OpenRouter        | Chat                              | `normalizeOpenRouterUsage` / `providerPresets.openrouter` (provider-reported cost) |
| Vercel            | AI SDK v5/v6                      | `normalizeVercelAiSdkUsage` / `providerPresets.vercelAiSdk`                        |

All normalizers are pure functions over plain objects — no provider SDK peer dependency. Pass the raw response object and get back a `NormalizedUsage`.

---

## 💰 Pricing & Markup

The fundamental difference between "what the provider charged you" and "what you charge your users" is the **markup multiplier**. This library makes that multiplier a first-class configuration option.

```typescript
// Configure at module level:
BymaxAiTokensModule.forRootAsync({
  useFactory: (prisma) => ({
    store: new PrismaAiTokensStore(prisma),
    markup: 4.0, // 4× resale margin
    wallets: { creditRateNanoUsd: 5_000_000_000n }, // sell credits at $5 each
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

## 👛 Wallets & Budgets

### Prepaid Wallets

```typescript
// Grant credits (e.g. on subscription renewal):
await wallets.grant(
  { tenantId, ownerType: 'user', ownerId: userId },
  {
    amountNanoUsd: 25_000_000_000n, // $25 in credits
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
  limitCount: plan.maxAIGenerationsPerMonth, // count quota
  limitTokens: plan.aiTokensMonthly, // token quota
  window: 'month',
  anchorAt: subscription.renewalDate, // renewal-anchored window
  softThresholds: [0.8, 1.0],
  policy: 'block',
})

// Check status:
const status = await metering.getStatus(tenantId, { type: 'user', id: userId })
// status[].remaining, status[].exhausted, status[].policy
```

**Unlimited semantics:** no budget row = unlimited. `limit = 0` = hard block. Never use `null` or `0` to mean unlimited.

---

## 🌊 Streaming

```typescript
const collector = new StreamUsageCollector({
  provider: 'openai',
  model: 'gpt-4o',
  preset: providerPresets.openaiChat,
})

const hold = await metering.hold(ctx, {
  provider: 'openai',
  model: 'gpt-4o',
  operation: 'chat',
  inputTokens: estimatedInput,
  maxOutputTokens: 1024,
})

try {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
    stream: true,
    stream_options: { include_usage: true },
  })
  for await (const chunk of stream) {
    collector.push(chunk) // accumulates chunks, watches for the final usage object
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

## 📊 Reporting & Status

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
  tenantId,
  from,
  to,
  format: 'csv',
})
csv.pipe(res)

// Access status / remaining budget:
const status = await metering.getStatus(tenantId, { type: 'user', id: userId })
return toJsonSafe(status) // bigint → decimal strings
```

---

## 📣 Events

When `@nestjs/event-emitter` is installed and `EventEmitterModule.forRoot()` is registered, the library emits typed events on the NestJS event bus:

| Event                                 | When                                                      |
| ------------------------------------- | --------------------------------------------------------- |
| `ai_tokens.usage.recorded`            | A usage record is posted to the ledger                    |
| `ai_tokens.usage.reversed`            | A record is reversed by a compensating entry              |
| `ai_tokens.hold.released`             | A hold is released without charging                       |
| `ai_tokens.budget.threshold_crossed`  | A soft threshold is crossed                               |
| `ai_tokens.budget.exceeded`           | A hard budget is exhausted                                |
| `ai_tokens.budget.projected_exceeded` | An estimate would exceed a budget                         |
| `ai_tokens.wallet.granted`            | Credit is granted to a wallet                             |
| `ai_tokens.wallet.low_balance`        | _Reserved._ Declared in the catalog; nothing emits it yet |
| `ai_tokens.wallet.depleted`           | A wallet balance reaches zero                             |
| `ai_tokens.price.missing`             | No rate is in effect for a model at the call timestamp    |
| `ai_tokens.audit`                     | An auditable operation completed                          |

All event payloads use `bigint` nano-USD internally and `string` decimal at JSON boundaries.

---

## 🚨 Error Codes

All errors are `AiTokensException extends HttpException`. Use the exported `AI_TOKENS_ERROR_CODES` catalog in switch/catch:

| Code                             | HTTP | When                                                                                  |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `AI_TOKENS_NOT_CONFIGURED`       | 503  | Service invoked before async init completed                                           |
| `AI_TOKENS_INVALID_CONFIG`       | 500  | Bad markup, negative limits, missing `scopeResolver`, missing fx                      |
| `AI_TOKENS_UNKNOWN_PROVIDER`     | 400  | No preset/normalizer and usage is not already `NormalizedUsage`                       |
| `AI_TOKENS_USAGE_MALFORMED`      | 422  | Normalizer could not read required token fields                                       |
| `AI_TOKENS_PRICE_NOT_FOUND`      | 422  | No effective-dated rate after 6-step resolution chain (strict mode)                   |
| `AI_TOKENS_FX_REQUIRED`          | 500  | `currency !== 'USD'` with no `fx` resolver                                            |
| `AI_TOKENS_BUDGET_EXCEEDED`      | 402  | A hard spend budget blocks the call                                                   |
| `AI_TOKENS_QUOTA_EXCEEDED`       | 429  | A hard token/count quota blocks the call                                              |
| `AI_TOKENS_INSUFFICIENT_CREDITS` | 402  | Wallet debit failed (balance + overdraft below amount)                                |
| `AI_TOKENS_HOLD_NOT_FOUND`       | 404  | `capture()`/`release()` on an unknown or cross-tenant hold                            |
| `AI_TOKENS_HOLD_EXPIRED`         | 410  | `capture()` after the reaper swept the hold (retry via `record()`)                    |
| `AI_TOKENS_HOLD_ALREADY_SETTLED` | 409  | `capture()` after `release()`                                                         |
| `AI_TOKENS_IDEMPOTENCY_CONFLICT` | 409  | Same idempotency key, different payload hash; or reversing an already-reversed record |
| `AI_TOKENS_STREAM_USAGE_MISSING` | 422  | Stream ended without provider usage and no tokenizer fallback available               |
| `AI_TOKENS_STORE_ERROR`          | 502  | Persistence adapter raised an unmapped error                                          |

---

## 🔢 BigInt & JSON

`bigint` does not survive `JSON.stringify`. Use `toJsonSafe()` at controller boundaries:

```typescript
import { toJsonSafe } from '@bymax-one/nest-ai-tokens'

// In your controller:
return toJsonSafe(await metering.getStatus(tenantId, scope))
// bigint fields (balanceNanoUsd, billedCostNanoUsd, etc.) become decimal strings.

// For display/formatting:
import { formatNanoUsd } from '@bymax-one/nest-ai-tokens/shared'
formatNanoUsd(5_000_000n) // '$0.005000'
formatNanoUsd(5_000_000n, { currency: 'BRL', fxRateNano: 5_000_000_000n }) // '0.025000 BRL'
```

---

## 📖 API Reference

The sections above document each of these with a runnable example. This is the index.

### Services

| Service                | Surface                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `MeteringService`      | `meter<T>` · `record` · `estimateCost` · `hold` · `capture` · `release` · `restoreReleasedHold` · `reverse` · `getStatus`            |
| `LedgerService`        | `append` · `query` · `findById` · `findByIdempotencyKey` · `findExpiredHolds` · `sumCost` · `transition` · `reverse` · `verifyChain` |
| `WalletService`        | `getBalance` · `grant` · `debit` · `refund` · `adjust` · `settleAdjustment` · `getEntries` · `reconcile`                             |
| `BudgetService`        | `upsertBudget` · `removeBudget` · `list` · `status` · `consume` · `release` · `adjust` · `rotateWindow` · `reconcileWindow`          |
| `PricingService`       | `resolveRate` · `upsertPrice` · `getPriceHistory` · `seedFromSnapshot`                                                               |
| `UsageReportService`   | `summarize` · `export`                                                                                                               |
| `StreamUsageCollector` | Accumulates streamed chunks; prefers the provider's final usage over its own count                                                   |

### Request-scoped enforcement

| Class                 | Role                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BudgetGuard`         | Check-only gate: refuses the request before the handler runs when a hard budget is exhausted, and — when `@RequireBudget.estimate` is present — places the hold and attaches it to the request            |
| `MeteringInterceptor` | The capture half: extracts usage from the handler's result, then settles the guard's hold or records post-hoc when there is none. On a handler error it releases the hold and rethrows the original error |

### Subpaths

| Subpath    | Exports                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `.`        | Everything above, the DI tokens, the option types and the error catalog                                                 |
| `./shared` | The zero-dependency contract layer — types, `AI_TOKENS_ERROR_CODES`, event shapes; safe to import from a browser bundle |
| `./prices` | `MODEL_PRICES_SEED` — a dated price snapshot to seed `PricingService` from                                              |
| `./prisma` | `PrismaAiTokensStore` — the reference store over PostgreSQL                                                             |
| `./redis`  | `RedisBudgetCounterStore` — the atomic budget counter                                                                   |

---

## 🏗️ Architecture

```
                        HTTP request
                             │
                             ▼
                   ┌─────────────────────┐
                   │     BudgetGuard     │  ← scopeResolver
                   │  check-only; holds  │    (your VERIFIED auth
                   │  when an estimate   │     context, never the
                   │  is declared        │     client's body)
                   └──────────┬──────────┘
                              │  refuses here if a hard budget is spent
                              ▼
                        your handler
                     (calls the provider)
                              │
                              ▼
                   ┌─────────────────────┐
                   │ MeteringInterceptor │
                   │ extracts usage, then│
                   │ settles the hold or │
                   │ records post-hoc    │
                   └──────────┬──────────┘
                              │
                              ▼
                        normalizers/
              9 providers → one usage shape
                              │
                              ▼
                          pricing/
            rate in effect AT the call timestamp
                    (never re-rated)
                              │
                              ▼
                          markup/
              multiplier or IMarkupPolicy
                              │
                              ▼
                          ledger/
             append-only; a correction is a
             compensating record. Optional hash
             chain over the previous posted entry
                              │
              ┌───────────────┴───────────────┐
              │                               │
        wallets/budgets            RedisBudgetCounterStore
      append-only entries          one Lua incrIfBelow —
      spend · tokens · count       check and increment
      per scope per window         cannot interleave
```

**Storage is an adapter, not a dependency.** `./prisma` is the reference
implementation over PostgreSQL and `./redis` accelerates budget counters; both are
peers you already control. The library defines the contracts.

### Design Principles

| Principle                                      | Description                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 💵 **Exact money, always**                     | Every persisted amount is `bigint` nano-USD. A float on a billing path is a rounding difference someone is charged for                            |
| 📜 **Append, never update**                    | The ledger is evidence. A correction is a compensating record that points at what it reverses, so the history of a charge survives the correction |
| 🔒 **The database prevents the double charge** | A unique constraint on the idempotency key, with the violation recognized as a conflict — not application discipline that can be forgotten        |
| ⏱️ **Priced when it happened**                 | An entry is rated at the price in effect at the call timestamp and never re-rated, so a price change does not rewrite the past                    |
| 🚪 **In-request enforcement**                  | Guard and interceptor, in-process: no proxy to deploy, no sidecar to keep alive, no external hop that can fail open                               |
| 🧊 **Zero runtime dependencies**               | `dependencies` is `{}`, and an optional peer is imported only when the feature that needs it is enabled                                           |

---

## 🔐 Security Model

This library decides what a customer is charged and holds the record that proves it. Its
security contract is about arithmetic that cannot drift, a record that cannot be quietly
rewritten, and text that does not travel.

### Money is `bigint` nano-USD everywhere it is persisted

Not because floats are imprecise in the abstract, but because a rounding difference on a
billing path is a number a customer is charged. There is no float arithmetic on a money
path.

### The ledger cannot be rewritten

Entries are appended; a correction is a compensating record that points at what it
reverses. With the optional hash chain on, each posted entry carries a hash over its
predecessor, so a row edited directly in the database stops matching the chain that follows
it. It is tamper-_evident_, not tamper-proof: pair it with database permissions that forbid
`UPDATE` on the ledger table.

### Charging twice is prevented by the database

The idempotency key carries a unique constraint, and the replay path is that constraint
violation being recognized as a conflict rather than surfacing as a store error. Application
care is not what stands between a retry and a second charge.

### Prompt and completion text never reach the ledger, the events or the telemetry

The stream collector holds response text only to count it; the OpenTelemetry emitter carries
model, operation, provider and service tier, and never content. The ledger stores no text at
all.

There is one place text can be persisted, and it is opt-in: `IContentStore`, the content
sidecar. A host that enables it stores **masked** text under a short TTL, separate from the
ledger, with a `purge()` that deletes by tenant, record or subject so an erasure request can
be honoured without touching the accounting. It is off unless you provide a store — and if
you do, text is being written, and where it is written is your implementation.

### Budget checks are atomic

The Redis counter runs check-and-increment as one Lua script, so two concurrent requests
cannot both observe room under a cap that only fits one.

### The scope resolver is trusted input

`scopeResolver` decides whose budget and whose wallet a request draws on. It is documented
as taking the host's **verified** auth context — never the client's body or query. A resolver
that reads a tenant id from request input lets a caller bill someone else.

---

## 🛡️ Security Table

| Layer            | Implementation                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money            | `bigint` nano-USD on every persisted amount; no float arithmetic on a money path                                                                               |
| Ledger           | Append-only; corrections are compensating records, never updates                                                                                               |
| Tamper evidence  | Optional per-entry hash chain over the previous posted entry                                                                                                   |
| Double charging  | Unique constraint on the idempotency key; the violation is the exactly-once signal                                                                             |
| Rating           | Point-in-time — an entry is priced at the call timestamp and never re-rated                                                                                    |
| Telemetry        | Model, operation, provider, service tier; prompt and completion text never emitted                                                                             |
| Content          | Never in the ledger, events or telemetry. The opt-in `IContentStore` sidecar stores masked text under a short TTL, with `purge()` by tenant, record or subject |
| Budget races     | One atomic Lua `incrIfBelow` — the check and the increment cannot interleave                                                                                   |
| Provider surface | Normalizers consume plain objects; no provider SDK dependency, no outbound call made here                                                                      |
| Supply chain     | `dependencies: {}`; third-party Actions pinned by commit SHA (org-internal reusables by tag); CodeQL, TruffleHog and OpenSSF Scorecard                         |

> [!IMPORTANT]
> **The hash chain is tamper-_evident_, not tamper-_proof_.** It makes an edited row
> detectable by anyone who verifies the chain; it does not stop someone with write
> access from rewriting the chain wholesale. Pair it with database permissions that
> forbid `UPDATE` on the ledger table.

---

## 🧱 Tech Stack

- **Runtime:** Node.js 24+
- **Framework:** NestJS 11 (guard + interceptor, `ConfigurableModuleBuilder`, `Symbol()` tokens)
- **Persistence:** `@prisma/client ^6 || ^7` (peer) over PostgreSQL — both majors supported
- **Budget acceleration:** `ioredis ^6` (peer), optional
- **Events:** `@nestjs/event-emitter >=2` (peer), optional
- **Telemetry:** `@opentelemetry/api ^1.9` (peer), optional
- **Build:** tsup — ESM + CJS per subpath, with `.d.ts` _and_ `.d.cts` declarations
- **Tests:** Jest + Testcontainers (PostgreSQL, end-to-end) + Stryker (mutation)
- **TypeScript:** 5.x strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zero `any`

---

## 🧪 Testing & Quality

This library decides what a customer is charged, so the suite is held to a bar beyond "the
tests pass".

- ✅ **100% line coverage** — statements, branches, functions and lines, enforced as a gate
- ✅ **100% mutation score against a `break: 95` gate** — the gate is the floor a run must
  clear; the score the suite actually reaches is 100%, verified with
  [Stryker](https://stryker-mutator.io/) ([report](./docs/mutation_testing_results.md))
- ✅ **Real PostgreSQL in e2e** — Testcontainers, so the unique constraint that prevents a
  double charge is exercised against an actual database rather than a mock of one
- ✅ **Both Prisma majors** — the raw-query violation path is unit-tested for the query engine
  _and_ the driver adapter, because the peer range admits 6 and 7 and each reports the
  SQLSTATE in a different place
- ✅ **Published-artifact gates** — `check:exports` resolves the types the way each module
  system does, `check:runtime` loads every subpath from the packed tarball in ESM and
  CommonJS, and `check:published` compiles this README's snippets against `dist/`
- ✅ **Every suppression carries its reason** — no coverage directives anywhere; each
  `// Stryker disable` in the production source states, after the `:` Stryker reads it
  from, why the mutant it silences is unobservable from a unit test (an internal error
  context, a provider id reached only through integration). `check:mutants` proves the
  reasons parse, so they reach the mutation report instead of being replaced by
  Stryker's `Ignored using a comment` fallback

```bash
pnpm test          # unit tests
pnpm test:cov      # unit tests with the 100% coverage gate
pnpm test:e2e      # end-to-end against PostgreSQL (requires Docker)
pnpm mutation      # Stryker mutation testing (break: 95)
pnpm typecheck     # tsc strict check
pnpm lint          # ESLint
pnpm build && pnpm size   # bundle-size budgets
```

---

## 🤝 Contributing

Pull requests are welcome. Please open an issue first for significant changes.

- Read [`docs/technical_specification.md`](./docs/technical_specification.md) for architecture decisions.
- Run `pnpm test:cov` and `pnpm lint` before opening a PR.
- Please use Conventional Commits for the message; nothing enforces it here, so it is a convention rather than a gate.

---

## 🔒 Security Policy

If you discover a security vulnerability, please **do not** open a public issue. Instead, email us
at **support@bymax.one** with details. We take security seriously and will respond promptly. See
[`SECURITY.md`](./SECURITY.md) for the full policy.

---

## 📄 License

[MIT](./LICENSE) © [Bymax One](https://github.com/bymaxone)

---

<p align="center">
  <sub>Built with ❤️ by <a href="https://github.com/bymaxone">Bymax One</a></sub>
</p>
