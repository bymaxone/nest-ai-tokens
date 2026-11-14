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

The library has **zero direct dependencies**. NestJS, Prisma, `ioredis` and the event emitter
arrive as peer dependencies, and the optional ones are never imported unless the feature that
needs them is enabled. OpenTelemetry is not a dependency at all: you hand the library a sink.

---

## 🔥 Features

### 📊 Metering

- ✅ **Nine provider normalizers** — OpenAI Chat, OpenAI Responses, OpenAI-compatible (DeepSeek / xAI /
  Groq / Azure), Anthropic, Gemini, Bedrock Converse, Mistral, OpenRouter and the Vercel AI SDK, folded
  into one usage shape; they read plain objects, so no provider SDK is a dependency
- ✅ **Every billing dimension** — cached, reasoning, audio and image units, and the write/read split
- ✅ **Streaming capture** — `StreamUsageCollector` prefers the provider's final usage and can count the
  output itself when a stream is cut short

### 💰 Money & Ledger

- ✅ **Exact `bigint` nano-USD** on every persisted amount; no float arithmetic on a money path
- ✅ **Point-in-time rating** — priced at the rate in effect at the call timestamp, never re-rated
- ✅ **Append-only ledger** — corrections are compensating records; nothing is updated in place
- ✅ **Hash-chain integrity** — optional per-entry chain, so a row edited in the database is detectable
- ✅ **Markup as configuration** — a fixed multiplier or a per-call `IMarkupPolicy`

### 🛡️ Enforcement

- ✅ **Hold → capture lifecycle** — the guard holds spend before the handler runs when an estimate is
  declared; the interceptor settles it to actuals afterwards
- ✅ **Multi-dimension budgets** — spend, tokens and operation count per scope per window, hard or
  soft; the optional `RedisBudgetCounterStore` checks and increments in one
  Lua script
- ✅ **Prepaid wallets** — grant / debit / refund / adjust entries with a configurable burn order
  (expiry, priority, FIFO)

### 🧩 Developer Experience

- ✅ **Five subpaths** — see [Subpath Exports](#-subpath-exports)
- ✅ **Usage reports** — by scope, feature, model or date, with currency conversion and CSV or JSON export
- ✅ **Typed events** — ten emitted event types over `@nestjs/event-emitter`, optional
- ✅ **OpenTelemetry** — an optional `ITelemetrySink` port for `gen_ai.*` signals, never carrying prompt
  or completion text; the library imports no OpenTelemetry package
- ✅ **Typed end to end** — TypeScript `strict`, zero `any`

---

## 📦 Subpath Exports

| Subpath                            | What it contains                                                                   | Runtime deps       |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| `@bymax-one/nest-ai-tokens`        | Dynamic module, services, guard, interceptor, decorators, collector, ports, errors | NestJS (peer)      |
| `@bymax-one/nest-ai-tokens/shared` | Normalizers, pure cost math, types, catalogs, error codes                          | Zero               |
| `@bymax-one/nest-ai-tokens/prices` | `MODEL_PRICES_SEED` — pinned price snapshot (data-only, large; imported lazily)    | Zero               |
| `@bymax-one/nest-ai-tokens/prisma` | `PrismaAiTokensStore` — the official PostgreSQL adapter                            | Your Prisma client |
| `@bymax-one/nest-ai-tokens/redis`  | `RedisBudgetCounterStore` — optional fast budget counter                           | `ioredis` (peer)   |

> The `./shared` subpath is framework-free and edge-safe — use it in frontends, workers, and edge functions that must not pull NestJS.

### Artifact sizes (brotli)

| Artifact                                    | Brotli size | Budget  |
| ------------------------------------------- | ----------- | ------- |
| server (`@bymax-one/nest-ai-tokens`)        | 41 KB       | < 42 KB |
| shared (`@bymax-one/nest-ai-tokens/shared`) | 5 KB        | < 10 KB |
| prisma (`@bymax-one/nest-ai-tokens/prisma`) | 12 KB       | < 15 KB |
| redis (`@bymax-one/nest-ai-tokens/redis`)   | 1.3 KB      | < 5 KB  |
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

> **Prisma 6 and 7 are both supported.** The adapter uses parameterized raw SQL and never a model
> delegate, so only how _you_ build the client differs: Prisma 6 takes
> `new PrismaClient({ datasourceUrl })`; Prisma 7 removed `datasourceUrl` and opens through a driver
> adapter, `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`, with the schema's
> datasource `url` moved to `prisma.config.ts`. `PrismaAiTokensStore` receives whatever client you
> built, and imports nothing from `@prisma/client` itself.

#### Create the tables

`PrismaAiTokensStore` needs seven tables, and the package ships what creates them, inside the
installed package:

- `node_modules/@bymax-one/nest-ai-tokens/dist/prisma/migrations/0001_init.sql` — the SQL for all
  seven tables. Apply it with `psql -f` or `prisma db execute --file` before the first boot.
- `node_modules/@bymax-one/nest-ai-tokens/dist/prisma/schema.prisma.fragment` — the same models
  for merging into your own Prisma schema if you manage migrations with `prisma migrate`.

The SQL also creates two partial indexes (exactly one open price row per model, and a fast scan
of pending holds) that a Prisma schema cannot express. If you migrate from the fragment, add them
yourself. Every date-time column is `TIMESTAMP(3)` without a time zone and the store reads and
writes it as UTC; keep it that way, since a column changed to `timestamptz` is read in the session's
zone.

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
        // Required whenever `budgets` is on: the module refuses to boot without it. Read the caller
        // from your verified auth context, never from the request body or query.
        scopeResolver: (ctx) => {
          const { user } = ctx
            .switchToHttp()
            .getRequest<{ user: { tenantId: string; id: string } }>()
          return {
            tenantId: user.tenantId,
            scope: { type: 'user', id: user.id },
            feature: 'workout.generate',
          }
        },
        pricing: { seedFromSnapshot: true }, // seed price table on first boot
      }),
    }),
  ],
})
export class AppModule {}
```

Without a `scopeResolver`, enabling `budgets` fails at boot with `AI_TOKENS_INVALID_CONFIG`
(`BudgetGuard requires options.scopeResolver to resolve the caller scope`).

### 3 — Record usage (post-hoc, observe-only)

```typescript
import { Injectable } from '@nestjs/common'
import { MeteringService, providerPresets } from '@bymax-one/nest-ai-tokens'
import { deriveIdempotencyKey } from '@bymax-one/nest-ai-tokens/shared'

@Injectable()
export class WorkoutAiService {
  constructor(private readonly metering: MeteringService) {}

  async generate(tenantId: string, userId: string, jobId: string) {
    const res = await this.openai.chat.completions.create({ model: 'gpt-5-mini', messages: [] })
    await this.metering.record({
      usage: res, // the whole response: the normalizer reads its `model` and `usage`
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

A retry with the same `idempotencyKey` and request returns the stored record and repeats nothing:
no second event, metric, budget or wallet movement. The price, the markup and a defaulted
`occurredAt` are not compared (a provider-reported cost is), so a retry after a price change returns the original cost. A different
request, or a key held by a hold not yet captured, fails with `AI_TOKENS_IDEMPOTENCY_CONFLICT`;
`enforce` is part of the request, so set it in your own code, never from a caller-controlled field.
Calls with one key are serialized within an instance only. With `enforce: true` the budget and the
wallet are charged before the record is written, so a call they refuse leaves no record and a retry of it is
decided afresh; a record that exists was enforced, and its replay charges nothing more.
An idempotency key identifies one call shape: reusing it across `hold()` and `record()`, or across payers or scopes,
is refused with a conflict, and the attempt that loses refunds its own debit; the one exception is a hold that was
already captured, which a `record()` with its key cannot tell from a record.

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

| Option                      | Type                                  | Default          | Purpose                                                                          |
| --------------------------- | ------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `store`                     | `IAiTokensStore`                      | — (required)     | Persistence adapter (use `PrismaAiTokensStore`)                                  |
| `scopeResolver`             | `(ctx) => MeteringContext`            | —                | Resolves the caller's scope from the request (required for guard/interceptor)    |
| `ratingMode`                | `'rate-table' \| 'provider-reported'` | `'rate-table'`   | Default cost rating mode                                                         |
| `markup`                    | `number \| IMarkupPolicy`             | `1.0`            | The resale multiplier (e.g. `4.0` = 4× provider cost)                            |
| `currency`                  | `string`                              | `'USD'`          | Presentation currency for reports; persisted money is always nano-USD            |
| `fx`                        | `(date, currency) => bigint`          | —                | USD → `currency` rate; required when `currency` is not `'USD'`                   |
| `tokenizer`                 | `ITokenizer`                          | —                | Token counter exposed on `BYMAX_AI_TOKENS_TOKENIZER`; `hold()` does not call it  |
| `pricing.strict`            | `boolean`                             | `true`           | Throw `AI_TOKENS_PRICE_NOT_FOUND` when no rate matches; off stores cost 0        |
| `ledger.hashChain`          | `boolean`                             | `false`          | Per-tenant hash chain over posted records, checked by `verifyChain`              |
| `wallets.overdraftNanoUsd`  | `bigint`                              | `0n`             | Negative balance a wallet may reach before a debit fails                         |
| `budgets.failClosed`        | `boolean`                             | `true`           | Keep enforcing the hard ceiling when the counter store is unavailable            |
| `content.store`             | `IContentStore`                       | — (off)          | Opt-in sidecar for prompt/response text, via `content.mask`; never in the ledger |
| `pricing.seedFromSnapshot`  | `boolean`                             | `true`           | Add seed rows only for combinations with no price row; never changes a price     |
| `wallets.creditRateNanoUsd` | `bigint`                              | `1_000_000_000n` | Exchange rate: 1 credit = this many nano-USD                                     |
| `wallets.burnOrder`         | `'expiry' \| 'priority' \| 'fifo'`    | `'expiry'`       | Order in which grants are consumed                                               |
| `budgets.defaultPolicy`     | `'block' \| 'throttle' \| 'allow'`    | `'block'`        | Default enforcement when a budget is exhausted                                   |
| `budgets.alertThresholds`   | `number[]`                            | `[0.8, 1.0]`     | Soft-threshold events at these fractions                                         |
| `holds.ttlSeconds`          | `number`                              | `3600`           | Spend-hold TTL; the reaper voids expired holds                                   |
| `telemetry.sink`            | `ITelemetrySink`                      | — (off)          | Your OpenTelemetry sink; the library ships none and telemetry is off without it  |
| `telemetry.metrics`         | `boolean`                             | `true`           | Emit token-usage and duration metrics when a sink is present                     |

With `forRootAsync`, the options arrive after the providers are declared, so `WalletService`,
`BudgetService` and `BudgetGuard` are always registered. When the options leave `wallets` or
`budgets` out, the injected object throws `AI_TOKENS_INVALID_CONFIG` on any method call, with a
reason naming the missing block. With `forRoot` they are not registered, so injecting one fails
when the application boots.

---

## 🧩 Providers Matrix

| Provider          | API                               | Normalizer                                                                         |
| ----------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| OpenAI            | Chat Completions                  | `normalizeOpenAiChatUsage` / `providerPresets.openaiChat`                          |
| OpenAI            | Responses API                     | `normalizeOpenAiResponsesUsage` / `providerPresets.openaiResponses`                |
| OpenAI-compatible | DeepSeek, xAI, Groq, Azure OpenAI | `normalizeOpenAiCompatibleUsage` / `providerPresets.openaiCompatible`              |
| Anthropic         | Messages API                      | `normalizeAnthropicUsage` / `providerPresets.anthropic`                            |
| Google            | Gemini / Vertex AI                | `normalizeGeminiUsage` / `providerPresets.gemini`                                  |
| AWS               | Bedrock Converse                  | `normalizeBedrockConverseUsage` / `providerPresets.bedrock`                        |
| Mistral           | Chat API                          | `normalizeMistralUsage` / `providerPresets.mistral`                                |
| OpenRouter        | Chat                              | `normalizeOpenRouterUsage` / `providerPresets.openrouter` (provider-reported cost) |
| Vercel            | AI SDK v5/v6                      | `normalizeVercelAiSdkUsage` / `providerPresets.vercelAiSdk`                        |

All normalizers are pure functions over plain objects — no provider SDK peer dependency. Pass the raw response object and get back a `NormalizedUsage`.

`MODEL_PRICES_SEED` covers `openai`, `anthropic`, `gemini`, `mistral`, `deepseek`, `xai` and `groq`.
A price row belongs to one provider id, model id, operation and service tier, and a preset prices from
the provider id its normalizer stamps: `azureOpenai` records `openai` and `vertex` records `gemini`, so
those calls use the seeded rows when the model id matches (`gpt-5-mini`, `gemini-2.5-flash`).
`openaiCompatible(id)` records the `id` you pass, so `'deepseek'` is priced from the seeded rows and
`'together'` needs prices of its own. A model that matches nothing, such as an Azure deployment name,
throws `AI_TOKENS_PRICE_NOT_FOUND` while `pricing.strict` is on (the default): give the context a
`baseModel` or add a price with `upsertPrice`. With `strict` off the record is stored at cost 0 and
marked `priceMissing`.

`bedrock` records provider `bedrock` and `vercelAiSdk` records none (the AI SDK does not say which
vendor served the call), so neither has seeded rows: add a price, and for the AI SDK pass a normalized
usage whose `provider` you set. A hold sized with `{ tokens }` or `{ amountNanoUsd }` takes the
preset's provider, so a `vercelAiSdk` hold is stored as `openai` and billed from the OpenAI rows; name
the provider in a full estimate to avoid that. A Converse response carries no model id: pass
`baseModel` in the context, or `{ model, ...response }`. The `openrouter` preset rates from the cost the
provider reports and needs no price unless a call sets `ratingMode: 'rate-table'`. See
[Pricing & Markup](#-pricing--markup).

---

## 💰 Pricing & Markup

The fundamental difference between "what the provider charged you" and "what you charge your users" is the **markup multiplier**. This library makes that multiplier a first-class configuration option.

```typescript
// Configure at module level:
BymaxAiTokensModule.forRootAsync({
  useFactory: (prisma: PrismaService) => ({
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

A provider or model the snapshot does not price needs a rate before it can be rated. Add one with
`PricingService.upsertPrice`; the new row closes the previous one at its `effectiveFrom`, which
defaults to now. Rates are nano-USD per million tokens:

```typescript
await pricing.upsertPrice({
  provider: 'bedrock',
  model: 'my-model', // the model id your calls report
  operation: 'chat',
  inputNanoUsdPerMillion: 3_000_000_000n, // $3 per million input tokens
  outputNanoUsdPerMillion: 15_000_000_000n, // $15 per million output tokens
})
```

For per-tenant or per-feature pricing, implement `IMarkupPolicy`:

```typescript
class MyMarkupPolicy implements IMarkupPolicy {
  resolve(ctx: { feature?: string }): number | Promise<number> {
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
const balance = await wallets.getBalance({ tenantId, ownerType: 'user', ownerId: userId })
console.log(balance.nanoUsd) // current balance
```

A grant is spendable from its `effectiveAt` (now, when omitted) until its `expiresAt`, judged on the database's clock: skew
between your application's clock and the database's moves both instants by up to that skew, in either direction (a grant
effective "now" waits when the application is ahead, and a dated grant is due early or expires late when the database is
ahead or behind), so keep NTP running on both. One that is not
yet due is credited when it falls due, at the next debit or `reconcile()`, through an `adjustment`
entry keyed `activate:<grantId>` (reason `grant activated`); that entry is bookkeeping, so a report of
operator adjustments should skip it. Keys starting `activate:` or `expiry:` are reserved for the store,
and a clash fails with `AI_TOKENS_INVALID_CONFIG`.

> **`getBalance()` can trail the clock.** It reads the stored balance, which changes at a debit or a
> `reconcile()`, so a grant that has just fallen due is not in it until one of them runs. Call `reconcile()`
> when you need the figure that includes every due grant.

#### What a debit costs as a wallet grows

A debit reads the wallet's grants and what each has spent, spent grants included, so its cost grows
with the number of grants and their allocations, and the wallet row stays locked while it runs. Grant
fewer, larger credits (one per billing cycle rather than one per event) and watch the debit latency of
your busiest wallets.

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

**Administering budgets is tenant-scoped.** `removeBudget(budgetId, tenantId)`, `rotateWindow(budgetId, tenantId, newWindowStart?)`
and `reconcileWindow(budgetId, tenantId, windowStart)` act only on a budget the tenant owns: for another tenant's id they
answer exactly as they do for an id that does not exist (`removeBudget` does nothing, the other two reject with the same
`AI_TOKENS_INVALID_CONFIG`), and `upsertBudget` refuses an `id` that belongs to another tenant. Because that refusal is a
different answer from creating a new budget, let the library generate budget ids, or use a UUID: an id a caller can guess
tells them whether it exists. Pass the tenant from your verified auth context, never from the request.

---

## 🌊 Streaming

```typescript
const collector = new StreamUsageCollector({
  provider: 'openai',
  model: 'gpt-5-mini',
  preset: providerPresets.openaiChat,
})

const hold = await metering.hold(ctx, {
  provider: 'openai',
  model: 'gpt-5-mini',
  operation: 'chat',
  inputTokens: estimatedInput,
  maxOutputTokens: 1024,
})

try {
  const stream = await openai.chat.completions.create({
    model: 'gpt-5-mini',
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
  await metering.capture(hold, ctx, collector)
  throw err
}
await metering.capture(hold, ctx, collector) // settle with provider-final actuals
```

`capture(hold, caller, usage)` and `release(hold, caller, reason)` take the caller, `{ tenantId, scope }` from your verified auth context
(the `ctx` of the hold works). The stored hold must belong to that caller: a hold of another tenant or payer, and a hold that does not
exist, both answer `AI_TOKENS_HOLD_NOT_FOUND`, and the tenant and scope on the `Hold` object are not read. A second argument that is
not a tenant and a scope (the shape of earlier versions) is refused with `AI_TOKENS_INVALID_CONFIG` before anything is read.

A stream cut short has no provider-final usage. When the collector is built with a `tokenizer`, it falls back to a count of the output text; without one, settling it throws `AI_TOKENS_STREAM_USAGE_MISSING`.

---

## 📊 Reporting & Status

```typescript
// Usage summary — by feature, for the last 30 days:
const summary = await reports.summarize({
  tenantId,
  scope: { type: 'user', id: userId },
  from: thirtyDaysAgo,
  to: now,
  groupBy: ['feature', 'model'],
})

// Export as CSV (streaming):
const csv = await reports.export({ tenantId, from, to }, 'csv')
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

| Code                             | HTTP | When                                                                             |
| -------------------------------- | ---- | -------------------------------------------------------------------------------- |
| `AI_TOKENS_NOT_CONFIGURED`       | 503  | Reserved; nothing raises it                                                      |
| `AI_TOKENS_INVALID_CONFIG`       | 500  | Bad markup, negative limits, missing `scopeResolver`, missing fx                 |
| `AI_TOKENS_UNKNOWN_PROVIDER`     | 400  | No preset/normalizer and usage is not already `NormalizedUsage`                  |
| `AI_TOKENS_USAGE_MALFORMED`      | 422  | Normalizer could not read required token fields                                  |
| `AI_TOKENS_PRICE_NOT_FOUND`      | 422  | No effective-dated rate after the model-resolution chain (strict mode)           |
| `AI_TOKENS_FX_REQUIRED`          | 500  | `currency !== 'USD'` with no `fx` resolver                                       |
| `AI_TOKENS_BUDGET_EXCEEDED`      | 402  | A hard spend budget blocks the call                                              |
| `AI_TOKENS_QUOTA_EXCEEDED`       | 429  | A hard token/count quota blocks the call                                         |
| `AI_TOKENS_INSUFFICIENT_CREDITS` | 402  | Wallet debit failed (balance + overdraft below amount)                           |
| `AI_TOKENS_HOLD_NOT_FOUND`       | 404  | `capture()`/`release()` on an unknown hold or one of another caller              |
| `AI_TOKENS_HOLD_EXPIRED`         | 410  | `capture()` after the reaper swept the hold (retry via `record()`)               |
| `AI_TOKENS_HOLD_ALREADY_SETTLED` | 409  | `capture()` after `release()`                                                    |
| `AI_TOKENS_IDEMPOTENCY_CONFLICT` | 409  | Same idempotency key, different request; or reversing an already-reversed record |
| `AI_TOKENS_STREAM_USAGE_MISSING` | 422  | Stream ended without provider usage and no tokenizer fallback available          |
| `AI_TOKENS_STORE_ERROR`          | 502  | Persistence adapter raised an unmapped error                                     |

### Logging the cause of a store error

An `AiTokensException` body is what a client receives: the code, a fixed message and a few safe
details. The error that actually failed (a driver error, a refused connection) is the exception's
standard `cause`, never part of the body, and Nest's default exception filter does not log an
`HttpException`. Log `exception.cause` yourself from an exception filter for statuses of 500 and above,
and keep it out of the response: it can name the host, a statement or a row.

---

## 🔢 BigInt & JSON

`bigint` does not survive `JSON.stringify`. Use `toJsonSafe()` at controller boundaries:

```typescript
import { toJsonSafe } from '@bymax-one/nest-ai-tokens'

// In your controller:
return toJsonSafe(await metering.getStatus(tenantId, scope))
// bigint fields (wallet.balanceNanoUsd, budgets[].spent.nanoUsd, etc.) become decimal strings.

// For display/formatting:
import { formatNanoUsd } from '@bymax-one/nest-ai-tokens/shared'
formatNanoUsd(5_000_000n) // '$0.005000'
formatNanoUsd(5_000_000n, { currency: 'BRL', fxRateNano: 5_000_000_000n }) // '0.025000 BRL'
```

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

---

## 🔐 Security Model

This library decides what a customer is charged and holds the record that proves it. Money,
append-only corrections and the database-enforced idempotency key are described above; what is
specific to security is below.

- **The hash chain is tamper-_evident_, not tamper-_proof_.** It makes an edited row detectable by
  anyone who verifies it; it does not stop someone with write access from rewriting the chain
  wholesale. Pair it with database permissions that limit who can write the ledger table.
- **Prompt and completion text never reach the ledger, the events or the telemetry.** The stream
  collector holds response text only to count it, and the telemetry carries model, operation,
  provider and service tier. The one opt-in exception is `IContentStore`, a sidecar that stores
  text, passed through your `content.mask` (identity by default), under a TTL, apart from the ledger, with a `purge()` by tenant, record or
  subject. It is off unless you provide a store, and you bring its schema and retention job: the
  library ships no implementation.
- **Budget checks are atomic.** The Redis counter runs check-and-increment as one Lua script, so two
  concurrent requests cannot both fit under a cap that holds one.
- **The scope resolver is trusted input.** `scopeResolver` decides whose budget and wallet a request
  draws on, so it must read the host's **verified** auth context, never the body or query: a resolver
  that reads a tenant id from request input lets a caller bill someone else.
- **Supply chain.** `dependencies` is `{}`, third-party Actions are pinned by commit SHA (org-internal
  reusables by tag).

---

## 🛡️ Security Table

| Control          | Implementation                                                                        |
| ---------------- | ------------------------------------------------------------------------------------- |
| Money            | `bigint` nano-USD on every persisted amount; no float arithmetic on a money path      |
| Ledger           | Append-only; a correction is a compensating record                                    |
| Tamper evidence  | Optional per-entry hash chain, checked by `verifyChain`; evident, not proof           |
| Double charging  | Unique constraint on the idempotency key; the violation is the exactly-once signal    |
| Rating           | Priced at the call timestamp and never re-rated                                       |
| Content          | Never in the ledger, events or telemetry; opt-in `IContentStore` sidecar, your schema |
| Budget races     | One atomic Lua check-and-increment in the Redis counter                               |
| Caller identity  | `scopeResolver` reads the verified auth context, never the request body or query      |
| Provider surface | Normalizers read plain objects; no provider SDK dependency, no outbound call          |
| Supply chain     | `dependencies` is `{}`; third-party Actions pinned by commit SHA                      |

---

## 🧱 Tech Stack

- **Runtime:** Node.js 24+
- **Framework:** NestJS 11 (guard + interceptor, `Symbol()` tokens)
- **Persistence:** `@prisma/client ^6 || ^7` (peer) over PostgreSQL — both majors supported
- **Budget acceleration:** `ioredis ^6` (peer), optional
- **Events:** `@nestjs/event-emitter >=2` (peer), optional
- **Telemetry:** optional `ITelemetrySink` port; the library imports nothing from `@opentelemetry/api`
- **Build:** tsup — ESM + CJS per subpath, with `.d.ts` _and_ `.d.cts` declarations
- **Tests:** Jest + Testcontainers (PostgreSQL, end-to-end) + Stryker (mutation)
- **TypeScript:** 5.x strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zero `any`

---

## 🧪 Testing & Quality

This library decides what a customer is charged, so the suite is held to a bar beyond "the
tests pass".

- ✅ **100% coverage and a 100% mutation score** ([Stryker](https://stryker-mutator.io/), `break: 100`;
  [report](./docs/mutation_testing_results.md)), both enforced as gates
- ✅ **Real PostgreSQL in e2e** — Testcontainers, so the unique constraint that prevents a double charge
  runs against an actual database
- ✅ **Both Prisma majors** — the raw-query violation path is tested for the query engine and the driver
  adapter, which report the SQLSTATE in different places
- ✅ **Published-artifact gates** — `check:exports`, `check:runtime` (every subpath in ESM and CommonJS)
  and `check:published`, which compiles this README's snippets against `dist/`

```bash
pnpm test          # unit tests
pnpm test:cov      # unit tests with the 100% coverage gate
pnpm test:e2e      # end-to-end against PostgreSQL (requires Docker)
pnpm mutation      # Stryker mutation testing (break: 100)
pnpm typecheck     # tsc strict check
pnpm lint          # ESLint
pnpm build && pnpm size   # bundle-size budgets
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

#### Verifying the hash chain

`LedgerService.verifyChain(tenantId, from?, to?)` resolves to a `ChainVerification`:

- `{ valid: true, unchainedCount, chainStartsAtRecordId?, forks? }` — every hashed record recomputes and,
  without `from`/`to`, the hashed records form one chain. `forks` lists records that name the same
  predecessor; a fork does not invalidate the chain, but one among records the official adapter wrote
  since 1.1.8 is unexpected (it links each record to the single tail under a per-tenant lock), so
  investigate it. Older forks, such as a hold that settled after a later record, are benign.
- `{ valid: false, brokenAtRecordId, unchainedCount }` — a record that fails: a removed hash, a
  changed record or, without `from`/`to`, a gap or a chain that does not start at a genesis record.
- `{ valid: false, status: 'never-enabled', unchainedCount }` — no settled record carries a hash; the
  chain was never on for this tenant, which is not evidence of tampering.

Enable `ledger.hashChain` before the first write: records written earlier are **unchained**, counted
in `unchainedCount`, and neither verified nor protected. What it does not catch:

1. A record no other record names as its predecessor can be deleted undetected: the newest record, and
   a hold that settled while a later-created record was already hashed.
2. The chain is unkeyed, so someone with write access who recomputes the whole tail is not detected;
   anchor the latest hash outside the database.
3. A rising `unchainedCount` after enabling is a signal to investigate; a rolling deploy with mixed
   `hashChain` settings can also cause it.
4. With `from` or `to`, only each record's own hash is checked, not the links between records.

A `valid: false` on records written by 1.1.11 or earlier on Prisma 6 under a non-UTC session zone is a
known date shift, not tampering; see the 1.1.12 entry of the [changelog](./CHANGELOG.md).

### Decorators, helpers and catalogs

| Export                                                                                         | Role                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@Meter` · `@RequireBudget` · `@AiFeature(name)`                                               | Handler metadata read by the interceptor and the guard; `@AiFeature` only tags the feature name                            |
| `deriveIdempotencyKey` · `toJsonSafe` · `formatNanoUsd`                                        | Idempotency key from content, `bigint` to decimal strings for JSON, and display formatting                                 |
| `floatUsdToNanoUsd` · `perMillion` · `computeCostNanoUsd`                                      | The money math: the only float-to-`bigint` entry, a cost at a nano-USD-per-million rate, and a usage priced against a rate |
| `applyMarkup` · `resolveMultiplier4dp`                                                         | A markup applied in exact `bigint`, and a multiplier validated and rounded to 4 decimal places                             |
| `isLegalLedgerTransition` · `isLegalTransitionPatchKey`                                        | The ledger lifecycle rules a custom store can reuse: which status changes and which columns each may touch                 |
| `PROVIDER_IDS` · `SERVICE_TIERS` · `AI_OPERATIONS` · `TOKEN_CATEGORIES` · `WALLET_ENTRY_TYPES` | The catalogs the types are derived from                                                                                    |
| `CounterValueOutOfRangeError` (`./redis`)                                                      | Thrown when a counter value leaves the safe-integer range; the budget service then falls back to the database consume      |

### Injection tokens

`BYMAX_AI_TOKENS_OPTIONS` (the resolved options) and the port tokens `BYMAX_AI_TOKENS_LEDGER_STORE`,
`_PRICING_STORE`, `_WALLET_STORE`, `_BUDGET_STORE`, `_BUDGET_COUNTER`, `_TOKENIZER`, `_TELEMETRY`,
`_EVENT_SINK`, `_CONTENT_STORE` and `_LOGGER`. The wallet and budget tokens exist only when their
options block is set (with `forRoot`; `forRootAsync` always exports them).

---

## 🚫 What This Library Does NOT Do

- It never calls a model: normalizers read the plain object your provider SDK returned.
- It stores no prompt or completion text; the only path is your own opt-in `IContentStore`.
- It ships no OpenTelemetry sink, no `IContentStore` implementation and no migration runner: you apply
  the SQL, and you bring the sink and the content store.
- It is not tamper-proof: the hash chain detects an edited row, not a rewritten tail.
- It does not read `0` or `null` as unlimited: no budget row is unlimited and `limit = 0` blocks every
  call.

---

## 🤝 Contributing

Pull requests are welcome. Please open an issue first for significant changes.

- Run `pnpm test:cov` and `pnpm lint` before opening a PR.
- Use Conventional Commits for the message.

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
