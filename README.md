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

`PrismaAiTokensStore` needs its tables, and the package ships what creates them, inside the
installed package:

- `node_modules/@bymax-one/nest-ai-tokens/dist/prisma/migrations/0001_init.sql` — the SQL for the
  base tables. Apply it with `psql -f` or `prisma db execute --file` before the first boot.
- `node_modules/@bymax-one/nest-ai-tokens/dist/prisma/migrations/0002_budget_applications.sql` — the
  last two tables, which record each budget movement under what caused it and the attempts that hold it, so that a retry
  moves nothing a second time. Apply it after `0001_init.sql`; an existing database needs only this one.
- `node_modules/@bymax-one/nest-ai-tokens/dist/prisma/migrations/0003_effects_owed.sql` — one table, `ai_usage_effects_owed`,
  beside the ledger: the effects-owed marker that lets the settlement sweep find a capture, a release or a reversal whose
  wallet and budget legs never ran. Apply it before you update the package: the new code writes a marker row in the same
  statement as a transition. It is additive, touches no existing table, and its header documents the rollback.
- `node_modules/@bymax-one/nest-ai-tokens/dist/prisma/migrations/0004_wallet_entry_order.sql` — columns only: a per-wallet
  entry sequence (`ai_wallets.entrySeq`, `ai_wallet_entries.seq`), the balance an entry left (`balanceAfterNanoUsd`) and the
  debit a refund restored (`refundsEntryId`). Apply it before you update the package: the new code writes these columns.
  It is additive and does not rewrite a row; the columns are added in an instant, and its header documents the rollback.
- `node_modules/@bymax-one/nest-ai-tokens/dist/prisma/migrations/0005_wallet_entry_order_indexes.sql` — the indexes and the
  foreign key that go with 0004, kept apart because they lock writes while they build. Apply it after 0004, in a quiet
  period on a large ledger; its header says how to build the indexes with `CONCURRENTLY` by hand instead.
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
import { AiService } from './ai.service' // your wrapper over the provider SDK

@Controller('ai')
@UseGuards(BudgetGuard)
@UseInterceptors(MeteringInterceptor)
export class AiController {
  constructor(
    private readonly metering: MeteringService,
    private readonly ai: AiService,
  ) {}

  @Post('summarize')
  @RequireBudget({
    scope: 'tenant',
    // Name the provider and the model: the settle prices the call with the hold's own. A bare `{ tokens }` or `{ amountNanoUsd }`
    // estimate settles on `context.baseModel` instead (a model listed for the preset's provider), and with none, or with no preset, the guard refuses it under strict pricing on a rate-table mode
    // when the price list has no price for that provider and model (with `pricing.strict: false` it is recorded at 0 USD).
    estimate: { provider: 'anthropic', model: 'claude-opus-4', operation: 'chat', inputTokens: 2_000, maxOutputTokens: 1_000 },
  })
  @Meter({
    feature: 'doc.summarize',
    scope: 'tenant',
    preset: providerPresets.anthropic,
    // The anthropic normalizer reads the whole provider response (its `usage` and its `model`), so extract that, not `result.usage`.
    extract: (result) => (result as { response: unknown }).response,
    exposeHeaders: true,
  })
  async summarize(@Body() dto: { content: string }) {
    // Guard checks budget and places a hold; interceptor settles it with the handler's actual usage.
    return this.ai.summarize(dto.content) // returns { summary, response }, `response` being the provider's own response
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
| `settlement.enabled`        | `boolean`                             | `true`           | Run the settlement sweep with the reaper; inactive for a store without the marker |
| `settlement.graceSeconds`   | `number`                              | `300`            | How long a row's effects may stay owed before the sweep runs them (1 to 2,147,483) |
| `settlement.retentionSeconds` | `number`                            | `604800`         | How long the record of a budget movement is kept after it was given back or its row ended; must exceed `graceSeconds` and `holds.ttlSeconds` |
| `telemetry.sink`            | `ITelemetrySink`                      | — (off)          | Your OpenTelemetry sink; the library ships none and telemetry is off without it  |
| `telemetry.metrics`         | `boolean`                             | `true`           | Emit token-usage and duration metrics when a sink is present                     |

The options are checked when the module is configured. `budgets.defaultPolicy`, the `policy` of a budget passed to `upsertBudget`
(checked at that call), and `ratingMode` accept only the values in the table; any other value throws `AI_TOKENS_INVALID_CONFIG`,
naming the option and never the value. A stored budget whose policy is not a documented value is evaluated as `'block'`. An option
set to `null` or `undefined` is left out: it takes its default, or stays off where it has none; `store` is
required and refuses both. A group of options set to `null` is left out too, except `budgets`, `wallets` and `ledger`, and the flag `ledger.hashChain`: leaving
these out switches a limit or a protection off, so they refuse `null` with `AI_TOKENS_INVALID_CONFIG`, because a configuration that
failed to load must not do the same. Leave them out, or set them to `undefined`, to keep the feature off. `scopeResolver` and `fx` must be
functions, `holds` and `wallets` objects, and `ledger.hashChain` a boolean, so a string such as `'false'` is refused, not read as true; a value of
another kind throws `AI_TOKENS_INVALID_CONFIG`, naming the option and never the value.

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

A grant is spendable from its `effectiveAt` (now, when omitted) until its `expiresAt`, judged on your application's
clock: the service passes the current instant to the store, so a database whose clock differs does not
move a grant. Entries are ordered by the database's creation time, which is the `'fifo'` burn order and breaks ties in the others. Keep NTP running on the application hosts, since their clocks
are the ones that decide and instances that disagree move a grant between them. One that is not
yet due is credited when it falls due, at the next debit or `reconcile()`, through an `adjustment`
entry keyed `activate:<grantId>` (reason `grant activated`); that entry is bookkeeping, so a report of
operator adjustments should skip it. Keys starting `activate:` or `expiry:` are reserved for the store,
and a clash fails with `AI_TOKENS_INVALID_CONFIG`.

> **`getBalance()` can trail the clock.** It reads the stored balance, which changes at a debit or a
> `reconcile()`, so a grant that has just fallen due is not in it until one of them runs. Call `reconcile()`
> when you need the figure that includes every due grant.

#### Refunding to the source, and balances at an instant

`refund()` with no `restore` keeps its old behaviour: it credits the wallet with an entry that no grant owns, so the
credit is spendable at once and never expires. With `restore: 'source'` the refund puts the amount back on the grants
that the debit burned, in proportion to what each still has room for, and links the refund to the debit
(`refundsEntryId`). Pass `debitEntryId` to name the debit, or `usageRecordId` to find it (the wallet must have exactly one debit with that id, or the refund is refused); a `debitEntryId` without
`restore: 'source'` is refused with `AI_TOKENS_INVALID_CONFIG`, since it contradicts the call.

A product sold in whole credits picks the rate (`creditRateNanoUsd`) and never grants or debits a fraction of a credit: every amount is in nano-USD, and credits are only how a balance is shown.

```typescript
const ref = { tenantId, ownerType: 'user', ownerId: userId } as const

await wallets.refund(ref, {
  amountNanoUsd: 90n,
  usageRecordId: 'u-1',
  idempotencyKey: 'refund:u-1',
  reason: 'provider error',
  restore: 'source',
})
```

- The refund writes one `refund` entry and negative allocation rows on the burned grants. No grant is created and no
  posted row is updated, so the ledger stays append-only.
- A part that lands on a grant that has already expired (its `expiresAt` has passed, or the sweep wrote its `expiry:`
  entry) does not come back as spendable credit: the store writes an `expiry:refund:<refundId>:<grantId>` entry that takes
  it out again. A restored credit never outlives the grant it returns to (no rollover).
- What can be restored is the debit, less the refunds already linked to it, less the refunds and positive adjustments
  that carry the same `usageRecordId` and are not linked to any debit. When several debits share one `usageRecordId`, each
  one's cap counts all of that id's unlinked credits, which is conservative: it can refuse a restore that would have fit,
  and never allows one that does not. A later refund that is not linked to a debit is not capped by this rule.
- A debit written by `hold()` or `record()` (key `hold:` or `record:`) is refused for `restore: 'source'`: its grants are
  settled by `capture()`, `release()` and `reverse()`.
- Amounts are `bigint` nano-USD and the split is exact: the parts add up to the refund to the nano-USD. The `credits` figures
  that the service returns are `nanoUsd / creditRateNanoUsd` as a `number` for display and are never stored, so a refund
  that is not a whole number of credits restores a fraction of a credit.
- Entries are listed in the order they committed (`seq`, then `createdAt`, then `id`), and each carries `balanceAfterNanoUsd`,
  the stored balance after it. An entry written before migration 0004 has no `seq` and sorts first when ascending and last when
  descending. A deployment that runs the old and the new code against one wallet orders the rows of the old code by time only.

`getBalance(ref)` is unchanged. `getBalance(ref, { asOf })` answers what could be spent at that instant: a grant not yet
effective, or already expired, is out, and one due but not yet credited is in. `getBalanceBreakdown(ref, { asOf })` lists
the same figure by grant. An `asOf` up to 5 seconds behind the clock is evaluated at now, one further behind is refused
with `AI_TOKENS_INVALID_CONFIG`, and the result carries the instant it used. A store without `balanceAt` and
`balanceBreakdown` is refused with the same code rather than answered from the stored balance.

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
// status.hasAccess and status.blockedBy say whether a budget or the wallet stopped the call;
// status.budgets[].remaining, .usedFraction and .policy describe each budget
```

**Unlimited semantics:** no budget row = unlimited. `limit = 0` = hard block. Never use `null` or `0` to mean unlimited.

**Administering budgets is tenant-scoped.** `removeBudget(budgetId, tenantId)`, `rotateWindow(budgetId, tenantId, newWindowStart?)`
and `reconcileWindow(budgetId, tenantId, windowStart)` act only on a budget the tenant owns: for another tenant's id they
answer exactly as they do for an id that does not exist (`removeBudget` does nothing, the other two reject with the same
`AI_TOKENS_INVALID_CONFIG`), and `upsertBudget` refuses an `id` that belongs to another tenant. Because that refusal is a
different answer from creating a new budget, let the library generate budget ids, or use a UUID: an id a caller can guess
tells them whether it exists. Pass the tenant from your verified auth context, never from the request.

**Dates must be valid `Date`s.** `anchorAt` and `expiresAt` of a budget, the `newWindowStart` of `rotateWindow`, the `windowStart` of
`reconcileWindow`, the `occurredAt` of `record`, the `at` of `estimateCost` and `resolveRate`, the `effectiveFrom` of `upsertPrice`, and
the `from` and `to` of a ledger, report or wallet-entry filter are refused with `AI_TOKENS_INVALID_CONFIG`, naming the input and never
the value, when they are an Invalid Date, a string, a number or `null`. `undefined` keeps the default where the input has one. A `Date` from
another realm and a subclass of `Date` are dates, at the JSON boundary of `toJsonSafe`, in the key `deriveIdempotencyKey` derives and in the SQL of the PostgreSQL store as well; a Proxy of a `Date` is not one there, and as an input a Proxy of a `Date` or a subclass whose `getTime` throws is refused. The range is the year 1 to the year 9999, which PostgreSQL 18 round-trips to the millisecond and fails one millisecond outside, and a date outside it is refused with the reason
`<input> must be a date from the year 1 to the year 9999`.

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
| `ai_tokens.settle.failed`             | The interceptor or `meter()` left a served call unsettled |
| `ai_tokens.budget.threshold_crossed`  | A soft threshold is crossed                               |
| `ai_tokens.budget.exceeded`           | A hard budget is exhausted                                |
| `ai_tokens.budget.projected_exceeded` | An estimate would exceed a budget                         |
| `ai_tokens.wallet.granted`            | Credit is granted to a wallet                             |
| `ai_tokens.wallet.low_balance`        | _Reserved._ Declared in the catalog; nothing emits it yet |
| `ai_tokens.wallet.depleted`           | A wallet balance reaches zero                             |
| `ai_tokens.price.missing`             | No rate is in effect for a model at the call timestamp    |
| `ai_tokens.audit`                     | An auditable operation completed                          |

All event payloads use `bigint` nano-USD internally and `string` decimal at JSON boundaries.

When a served call cannot be settled, `MeteringInterceptor` keeps the guard's hold until `holds.ttlSeconds`: its reservation goes
on counting against the wallet and budget, and a retry with the same idempotency key gets the same hold. `meter()` releases its hold
at once, so that a failed capture strands no headroom for that long. `meter()` and the interceptor
emit `ai_tokens.settle.failed`, whose `where` names the caller, for you to reconcile from your provider's log.

---

## 🚨 Error Codes

All errors are `AiTokensException extends HttpException`. Use the exported `AI_TOKENS_ERROR_CODES` catalog in switch/catch:

| Code                             | HTTP | When                                                                             |
| -------------------------------- | ---- | -------------------------------------------------------------------------------- |
| `AI_TOKENS_NOT_CONFIGURED`       | 503  | Reserved; nothing raises it                                                      |
| `AI_TOKENS_INVALID_CONFIG`       | 500  | Bad markup, negative limits, a date that is not a valid `Date`, missing `scopeResolver`, missing fx |
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
| `AI_TOKENS_STORE_ERROR`          | 500  | Persistence adapter raised an error that retrying does not fix                   |
| `AI_TOKENS_STORE_UNAVAILABLE`    | 503  | Persistence adapter cannot serve the call now; retry it (no `Retry-After` is set) |

### Set a connect timeout on the database client

`AI_TOKENS_STORE_UNAVAILABLE` is raised only when the driver reports a failure; it also covers a failure of the connection, not of the call, that Prisma 7's `pg` adapter
reports as `P2010` with the cause kind `DatabaseNotReachable`, `ConnectionClosed`, `TooManyConnections`, `SocketTimeout` or
`TransactionWriteConflict`. A database that is paused or whose
network drops without closing the socket makes some drivers wait forever instead, and the library cannot classify a
call that never fails. Measured on PostgreSQL 16: with Prisma 6's engine, a plain query against a paused server never
returns, while an interactive transaction fails after `maxWait` with `P2028`. With Prisma 7's `pg` adapter the pool
gives up after its `connectionTimeoutMillis`. Set the bound on the client you pass to the store: `connect_timeout`
and `pool_timeout` in the Prisma 6 connection URL, and `connectionTimeoutMillis` (plus a `statement_timeout`) on the
`pg` pool for Prisma 7.

### Logging the cause of a store error

An `AiTokensException` body is what a client receives: the code, a fixed message and a few safe
details. The error that actually failed (a driver error, a refused connection) is the exception's
standard `cause`, never part of the body, and Nest's default exception filter does not log an
`HttpException`. Log `exception.cause` yourself from an exception filter for statuses of 500 and above,
and keep it out of the response: it can name the host, a statement or a row.

The `reason` of a refused option or input names what was refused and the bound it broke, and never repeats the value, so a string
read from an environment variable cannot reach a response body or a log through it. Match on the option name in the reason, not on
the value. The public methods that take them also refuse an argument of the wrong kind with `AI_TOKENS_INVALID_CONFIG`, naming the argument and never
repeating the value, where it used to fail with a raw `TypeError`, `RangeError` or `SyntaxError` that did: an identifier (tenant, key, model,
provider, operation, scope, wallet owner) that is not a string, a token count, `limit` or `offset` that is not a whole number of 0 or more, a hold
estimate, a cost estimate or a metering context that is not an object, and a `groupBy` that is not an array of the documented dimensions. A runtime error may carry, in its `details`, an identifier the caller already holds (`holdId`, `idempotencyKey`,
`budgetId`, `tenantId`, `provider`, `model`, `operation`, `serviceTier`, `recordId`) so the caller can correlate it, but only when the value is a string of at most 256
characters; otherwise the field is left out. The budget errors also carry the `dimension` that refused (`cost`, `tokens` or `count`). A refusal at startup never carries a supplied value: `AI_TOKENS_FX_REQUIRED` has no
`details`.

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
- **Who closes the Redis client.** The library closes what it creates and the host closes what it passes in.
  A `RedisBudgetCounterStore` built from a connection URL opens its own client and quits it when the Nest
  application closes (a graceful `quit()` bounded by `closeTimeoutMs`, default 2000 ms, then `disconnect()`),
  so the process can exit. A client you pass in is never touched; close it yourself, and call `disconnect()`
  only while its `status` is not `'end'`: `ioredis` arms a 2000 ms teardown timer on `disconnect()` that only
  a `'close'` event clears, and a client that has already ended never emits one, which keeps the process
  alive about two seconds longer.
- **A stopped Redis costs one timeout, then the database answers.** The client a `RedisBudgetCounterStore` creates from a URL
  retries a command once and fails it after `commandTimeoutMs` (default 500 ms, a whole number from 1 to 2,147,483,647). Measured
  against a stopped Redis 7, a command failed in about 500 ms (327 to 503 ms), where the `ioredis` defaults held it for 73 and 107 s; the
  store was serving again 0.3 to 2.5 s after the server came back, which the reconnect backoff of `ioredis` sets. The budget service treats the failure as an unavailable counter
  and decides from the database window, so a call is still counted and refused at the limit. The offline queue stays on, so a
  command issued while the connection is still opening waits for it instead of failing. A client you pass in keeps your own
  settings: set `maxRetriesPerRequest`, `commandTimeout` and `enableOfflineQueue` on it yourself.
- **The hold reaper does not pile up sweeps.** A tick that finds the previous sweep still running does nothing, and a run of
  skipped ticks is one `ai_tokens.hold_reaper.tick_skipped` line, so a slow store is not swept twice at once. A sweep that has run
  for longer than ten intervals, or ten minutes when that is longer, is abandoned with one `ai_tokens.hold_reaper.tick_stalled`
  line and the next tick starts a fresh sweep, so a scan that never settles does not stop the reaper for good; the abandoned
  sweep's late end does not mark the fresh sweep as finished. At most two sweeps run at once, each holding a store connection until
  the store gives it up: while an abandoned sweep is still running, a second stall starts no third sweep, with one
  `ai_tokens.hold_reaper.sweep_blocked` line per run of such ticks, and the reaper sweeps again when either settles. The timer never stops.
- **The scope resolver is trusted input.** `scopeResolver` decides whose budget and wallet a request
  draws on, so it must read the host's **verified** auth context, never the body or query: a resolver
  that reads a tenant id from request input lets a caller bill someone else.
- **Supply chain.** `dependencies` is `{}`, third-party Actions are pinned by commit SHA (org-internal
  reusables by tag).
- **An argument is read once, at the call.** Every object a host passes to a public method is read by the names of its type, once, and
  the call works on that copy, so a getter or a Proxy trap that answers differently the second time cannot change what is checked and
  what is used. A field a Proxy answers by its `get` trap is read like any other. What cannot be read (a getter or a trap that throws) is
  refused as `AI_TOKENS_INVALID_CONFIG`, naming the field and never the host's own error. The maps the library lists itself
  (`context.extraUnits`, `tags`, a price's `unitRates`, the keys of a record) are copied with limits on depth, length and total size; a value that contains itself, and a Proxy that
  lists no key (which answers for names nobody can list, so an empty copy would drop what it holds), are refused, and a `Buffer` or
  a typed array is kept as it is. The raw response of a provider is not copied: the normalizer reads it by the names of its provider,
  through a view that answers each field the same way every time, and a Proxy in it that lists no key, where a normalizer lists keys, is refused as
  `AI_TOKENS_USAGE_MALFORMED`. A usage that is already normalized is read by the names of `NormalizedUsage`. A `StreamUsageCollector`
  passed to `capture()` is used as it is, and a repeated `capture()` of a settled hold returns its record without reading the usage.
  A normalizer of the host receives the host's own object (it may call a method of it or rely on its class), and a function that wraps
  a built-in normalizer is a normalizer of the host: it gets no view.
- **The counts of a usage are counts.** Every built-in normalizer reads a count that is there as a whole number from 0 to the largest safe
  integer, and a value that is not one (a string, `NaN`, `Infinity`, a negative, a fraction, a list) is refused as `AI_TOKENS_USAGE_MALFORMED`
  where it used to be read as `0`, billing the call for less than it used, or as a negative, for more. A part of a total that is more than
  its total (cached, audio or reasoning tokens past the prompt or the completion) is refused, a container of counts that is there must be an
  object, and a count that is absent, or `null`, is `0`.
- **Tool units are counts, billed the same on `record()` and on `capture()`, and the host's count wins.** The tool units of a call are
  the ones the provider reported in the usage and the ones the host puts on the context as `extraUnits`, merged. For a unit both name, the
  host's count replaces the provider's, because the host is the billing caller: a host that passes `{ web_search_requests: 0 }` bills 0
  for that unit whatever the provider reported. A hold stores its `extraUnits`, and `capture()` bills them with the units of the usage.
  A unit count that is not a whole number from 0 to the largest safe integer (a negative, a fraction, `NaN`, `Infinity`, a string, `2**53`)
  is refused as `AI_TOKENS_USAGE_MALFORMED` before anything is debited. When rated from prices, a unit above 0 with no `unitRates` rate
  is a missing price: refused as `AI_TOKENS_PRICE_NOT_FOUND` when `pricing.strict` is on, and otherwise billed for
  what has a price, with `priceMissing` set on the record and `ai_tokens.price.missing` raised.
  The seeded snapshot lists a `web_search_requests` rate only for the models that carry one in `src/prices/model-prices.seed.ts`;
  for the others a call with web searches is refused under `pricing.strict` until the host lists a rate with `upsertPrice`. `-0` is 0, not a negative count. A capture's units can
  push the settled amount past the hold, whose reservation covers the token estimate and not the units: a host with a strict credit
  policy sizes the estimate with them.
- **What else a usage must satisfy.** The tokens of one call may not add up to more than 2,147,483,647, the most a ledger row stores: a
  larger call is refused as `AI_TOKENS_USAGE_MALFORMED` before anything is debited. A count a response reports twice (the AI SDK's
  reasoning tokens and cache reads, at the root of the usage and in its details; the cache hit of an OpenAI-compatible gateway, at the
  root and nested) is one count: two equal values are billed once and two that differ are refused as `AI_TOKENS_USAGE_MALFORMED`, and
  `0` beside a non-zero value differs, so a gateway that zero-fills one of the two is refused on every call that cached. A cache write
  named by a total and by a split (Anthropic `cache_creation_input_tokens` and `cache_creation`, Bedrock `cacheWriteInputTokens` and
  `cacheDetails`) is billed by the total when the split reports nothing, and a total that disagrees with a non-empty split, or a null
  entry of `cacheDetails`, is refused. OpenAI chat and Responses audio output tokens are part of the completion tokens and are billed
  once, at the audio rate. A negative count, a count past the largest safe integer and a negative provider-reported cost in a usage a
  host normalized itself are refused, never clamped. A hold estimate above that bound is refused as `AI_TOKENS_INVALID_CONFIG` before
  anything is reserved.
- **A process whose prototypes are not the engine's is refused.** The module does not start, and no call that moves, reads or reports money
  runs, while this
  realm's `Object.prototype` holds a name the engine does not define, lacks one it defines, or holds one changed (its enumerability, or a function
  that is not the engine's), or while any function of the standard namespaces and constructors the library relies on (`Object`, `Reflect`, `Array`, `Math`, `Number`, `String`,
  `Set`, `Map`, `Date`, `BigInt`, `DataView`, `TextEncoder`, typed arrays and the others, with their prototypes) is no longer the function it
  met when it loaded, or the name of one of them is rebound to another object. `Promise`, its prototype and its binding are exempt, with one exception: tracing and
  monitoring agents (`dd-trace`, New Relic, `zone.js`) wrap them after load on healthy hosts, but `Promise.prototype.constructor` must stay the engine's `Promise`, the getter of `Promise[Symbol.species]` must stay the engine's, and
  neither it nor `Promise.prototype.then` may be an accessor, because a native `await` reads `constructor` and, when it is not `Promise`, calls `then`. The code that
  settles a store result or serializes the writes of a call uses `await`, which does not look the global `Promise` up. `JSON` is exempt too, because a host's own tests spy on it: the keys, the statement parameters and the hashes are made with the `JSON.stringify` the library met when it loaded. The refusal is `AI_TOKENS_INVALID_CONFIG`, nothing is written, and it says how many names of `Object.prototype`
  differ and how many built-ins do, with a count, never a name or a value. A host that extends `Object.prototype` (a
  `should`-style assertion library, a polyfill) cannot run the library, and neither can a process that patches one of those built-ins in place
  (`jest.spyOn(Date, 'now')` in a host's own tests): restore the built-in before the call. The global `Date`
  is one of them, so a fake clock (`jest.useFakeTimers()`) must be restored before the library is called. A symbol on `Object.prototype` is
  counted whether it is enumerable or not, except the one hidden mark that Jest puts there. Beneath the check, the library still reads every option, decorator
  field, usage, filter, row and descriptor as the host's own, so a name planted between the check and the read is not taken for a value the
  host set.
- **The records a service returns are copies, and a store is read through a copy.** Every argument a service hands a store, and every row
  the store hands back, is copied (a plain object or an instance of a class, by its own fields and the getters of its class, into an object
  with no prototype; a `Date`, a `Map`, a typed array and the other built-ins are handed on as they are). A `UsageRecord`, a `Budget`, a wallet
  entry or a price version a service returns therefore has no `hasOwnProperty` or `toString` (`String(record)` throws; use
  `Object.hasOwn(record, name)` and `JSON.stringify`, which are unchanged) and is not an `instanceof` anything. A record or list nested
  deeper than 8 levels in a store argument or row is refused as `AI_TOKENS_INVALID_CONFIG`. A frozen or sealed store object is accepted. A
  usage a built-in normalizer returns has no prototype either.

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

## 🧯 Settlement and its limits

A capture, a release and a reversal commit to the ledger first and run their effects after: the wallet legs and the budget
legs. A marker row in `ai_usage_effects_owed`, written by the same statement as the write, records that the effects are owed, so
a crash between the two no longer strands them. The ledger table itself gains no column. Each tick of the reaper finishes a batch of the rows whose marker is older than
`settlement.graceSeconds`. Each leg is keyed by what causes it, so running it again moves nothing, and two replicas
sweeping at once hold no lock between them. The sweep re-emits the event a write owes, at least once, so a consumer must be
idempotent on the record id. A store without the optional marker calls leaves the sweep inactive, and the reaper says so
once at boot.

**Known limit.** Without those calls, a leg that fails after the ledger commit is not finished by anyone: the record is posted at its actual cost while the wallet keeps the hold's reserved debit, and a second capture returns the posted record without running the leg again. Use a store that keeps the marker (the Prisma store does) when a failed capture leg must be repaired.

The budget has a second sweep on the same tick. A keyed budget movement holds one reference per attempt, and an attempt that
dies between taking the movement and writing its ledger row leaves its reference, so the window counts a call nobody
owns. The sweep lists the references an attempt left that are older than the grace, looks at the ledger row under each key,
and gives each one verdict: it gives the movement back when no row is the same call (the window loses it once), keeps it
under the committed name when the row is the same call (a committed call is never under-counted), and leaves alone a
reference that already belongs to a live row. A hold's committed reservation is given back only when its row was
released, and only once it is older than the hold TTL plus the grace. A tick walks a bounded number of pages from a cursor
that wraps, so the references of live calls cannot starve the ones that need a verdict. It also deletes what no longer
protects anything: applications given back, and applications whose row ended and owes no effects, once they are older than
`settlement.retentionSeconds`. A pending hold's reference is never deleted. A store without the optional
`findStaleReferences`, `pruneApplication` and `pruneGivenBack` calls leaves that part inactive.

The reaper also gives back **orphan wallet debits**. A keyed `hold()` or enforced `record()` whose ledger append failed keeps
its wallet debit so that a retry replays it; a call that is never retried leaves the debit with no ledger row. A tick lists
the debits whose key belongs to a hold or a record, older than `settlement.graceSeconds` and younger than
`settlement.retentionSeconds`, looks at the row under each key, and for a key with none appends a released claim row that owes
the refund, then refunds the wallet once. The claim row carries the wallet's tenant and the fixed value `orphan-claim` as its
provider, model and feature, is never counted by a usage report, a cost summary or a budget, and refuses a later call on the
same key with `AI_TOKENS_IDEMPOTENCY_CONFLICT`. The budget half of such a call is the budget-reference sweep's. A wallet store
without the optional `findDebitsBefore` leaves this part inactive, and the reaper says so once at boot.

A read that asks for `status: ['released']` returns claim rows together with released holds. A claim row has the provider and the feature `orphan-claim`, so filter on them client-side, or list the features you want with `features: [...]`; there is no filter for "not equal".

The Prisma store's listing reads `ai_wallet_entries` across wallets in `(createdAt, id)` order, a bounded number of pages per reaper tick. No shipped index leads with `createdAt`, so on a large table each page is a scan of the whole table. A
host with a large wallet table should add this partial index, created with `CONCURRENTLY` so that it does not block wallet
writes, which means outside a transaction and so outside a migration tool that wraps its files in one. The listing is correct
without the index and slower on a large installation:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_wallet_entries_debit_createdAt_idx" ON "ai_wallet_entries" ("createdAt", "id" COLLATE "C") WHERE "type" = 'debit';
```

Limits you can rely on:

- For the owed effects and the budget references, the grace is a performance knob, not a correctness bound: a sweep that
  reaches a row while the inline path is still running its effects only repeats keyed legs that move nothing. The give-back of
  orphan debits is the exception, below.
- The effects are exact for the wallet and the budget and at-least-once for events and spans.
- While one step of a call is stuck for longer than the grace (a wallet debit or an append that does not return), the
  sweep gives its movement back and the window does not count the call, so another call can be admitted under the limit
  and the window can end above it. The call is counted in the end: its commit takes the movement again, without limits.
  Nothing is added to prevent it: a heartbeat would cost a write per running attempt, and a declared maximum duration would
  turn a number you have to guess into a correctness bound.
- The sweep corrects the budget window, not the live counter of a Redis counter store: a counter keeps what the fast path
  added until the window rotates, and the database decides whenever the counter is stale-high.
- A keyed `record()` row that won a race against a `hold()` on the same key is posted like a captured hold, and the sweep
  cannot tell them apart: it keeps the hold's reservation counted until its window rotates. It needs that race on one key,
  and the over-count fails closed.
- Do not use the same idempotency key for a `hold()` and a `record()`. They debit the wallet under different keys, and when a
  call of one kind posts its row first, the sweep finds a row under the key and leaves the orphan debit of the other kind,
  for the same reason: a posted row cannot be told apart from a captured hold that shares its debit.
- The record of a movement is deleted after the retention. A key is replayed from its ledger row, which holds the
  call, so a replay after the retention takes no budget movement.
- While a row of a tenant has owed its effects for longer than the retention, the records of that tenant's given-back movements
  are kept, because a retry of that row's release or reversal needs them to give nothing back twice; the deletion resumes when
  the marker clears. The other tenants are pruned as usual. A marker that never clears keeps its tenant's records until it is
  settled, and the tick says so in one line, `given-back pruning skipped for <n> tenant(s): an owed marker is older than the
  retention`, so the tables do not grow unseen. A store without the optional `pruneGivenBackExcept`, or a tick whose listing of
  markers may be cut at a page, pauses the deletion for every tenant and logs `given-back pruning skipped: an owed marker is older
  than the retention`.
- For `record({ enforce: true })` and `hold()` with a key, the grace is a correctness bound: it must exceed the longest wallet
  debit or ledger append of a call. A call whose append lands after the sweep claimed its key is refused with the idempotency
  conflict, and the reaper logs `ai_tokens.orphan_claim.late_append claim=<row id>`; the debit was already given back. No
  multiplier is applied to the grace.
- A wallet debit older than `settlement.retentionSeconds` with no ledger row is outside what the sweep repairs, like a stuck
  step older than the retention.
- A step of a call that stays stuck for longer than the grace plus the retention is outside what the sweep repairs: its
  movement was given back and its record deleted, so its commit finds no record, counts nothing, and a later
  `reconcileWindow` counts the call from its ledger row. Keep the retention longer than any call can run.

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
