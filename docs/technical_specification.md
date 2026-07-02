# @bymax-one/nest-ai-tokens — Complete Technical Specification

> **Version:** 0.2.0 (post-audit revision)
> **Last updated:** 2026-07-02
> **Status:** Draft for implementation
> **Type:** Public npm package (`@bymax-one/nest-ai-tokens`)
> **Owner:** Bymax One — Platform Engineering
> **Related:** `@bymax-one/nest-storage`, `@bymax-one/nest-queue`, `@bymax-one/nest-cache`, `@bymax-one/nest-logger`; reference extraction from the private `bymax-fitness` monorepo (`_commons_/ai/*`).

---

## Table of Contents

1. [Vision and Value Proposition](#1-vision-and-value-proposition)
2. [Architecture](#2-architecture)
3. [Package Structure](#3-package-structure)
4. [Configuration API](#4-configuration-api)
5. [Provider Usage Normalizer](#5-provider-usage-normalizer)
6. [Pricing Registry (versioned, effective-dated)](#6-pricing-registry-versioned-effective-dated)
7. [Cost Engine and Markup / Margin](#7-cost-engine-and-markup--margin)
8. [Immutable Usage Ledger](#8-immutable-usage-ledger)
9. [Wallets and Prepaid Credits](#9-wallets-and-prepaid-credits)
10. [Budgets, Quotas and Enforcement](#10-budgets-quotas-and-enforcement)
11. [Metering API — Services, Guard, Interceptor, Decorators](#11-metering-api--services-guard-interceptor-decorators)
12. [Events](#12-events)
13. [Reporting, Aggregation and Export](#13-reporting-aggregation-and-export)
14. [Observability, Security and Compliance](#14-observability-security-and-compliance)
15. [Data Model and Persistence Ports](#15-data-model-and-persistence-ports)
16. [Error Code Catalog](#16-error-code-catalog)
17. [What is NOT in the package](#17-what-is-not-in-the-package)
18. [Dependencies (peer deps)](#18-dependencies-peer-deps)
19. [Implementation Phases](#19-implementation-phases)
20. [Known Limitations](#20-known-limitations)
21. [Example Integration](#21-example-integration)
22. [Migration from bymax-fitness](#22-migration-from-bymax-fitness)

---

## 1. Vision and Value Proposition

### 1.1 What it is

`@bymax-one/nest-ai-tokens` is a public npm package for NestJS that provides an **embeddable, dependency-injection-native metering and usage-based billing layer for AI/LLM token consumption**. It captures how much each request consumed — split by token category (input, output, cache read/write, reasoning, audio, image) plus non-token line items (web-search calls, tool sessions, per-image units) — rates that consumption against a **versioned, point-in-time price table keyed by model and service tier**, writes it to an **immutable append-only ledger**, enforces **per-tenant/team/user/key budgets, quotas and prepaid wallets**, and applies a **configurable markup/margin** so a SaaS can resell AI capacity to its own end-users at a profit.

The same application code runs unchanged across **OpenAI (Chat Completions + Responses), Azure OpenAI, Anthropic, Google Gemini, Vertex AI, Mistral, AWS Bedrock, OpenRouter, and the OpenAI-compatible ecosystem (DeepSeek, xAI, Groq, Together, Fireworks, Ollama, …)** — plus anything the host already normalizes through the **Vercel AI SDK** — because the library is **normalizer-first**: it consumes the provider's own `usage` object and maps every provider's native shape into a single canonical `NormalizedUsage`.

The starting point is the internal AI cost layer extracted from the production `bymax-fitness` monorepo (`_commons_/ai/{pricing,ai-token-transaction,...}.service.ts` + the `ModelPricing` / `AITokenTransaction` Prisma models). That implementation is hardcoded to OpenAI, stores cost inside an untyped JSON blob, has two divergent write paths, and offers no markup. This library generalizes the strong bones (the DB-backed effective-dated pricing service, the signed credit/debit ledger, the atomic "update counter + insert ledger row" transaction) and fixes the gaps (provider lock-in, typed cost columns, one unified metering path, markup, count quotas, billing-cycle-anchored windows, streaming-safe capture, race-safe enforcement).

### 1.2 Why it exists

Today, a team that wants to meter and bill AI usage must stitch together several tools: a tokenizer (`tiktoken`, `@dqbd/tiktoken`), a price dataset (`genai-prices`, LiteLLM's `model_prices_and_context_window.json`), a metering/billing engine (Lago, OpenMeter, Orb), a proxy for enforcement (LiteLLM, Helicone — a separate process and a second source of truth), and an observability tool (Langfuse). Every one of those is either a separate process, an external SaaS, or a stateless calculator with no ledger, no budgets, and no markup.

The library eliminates that assembly:

- Removes the need for a proxy/sidecar/SaaS — enforcement lives **in the request path** as a NestJS **guard** and **interceptor**, exactly where the request already is.
- Standardizes token accounting across providers, including the dimensions naïve implementations get wrong: cached traffic (up to 10× over-billing if cache reads are priced as input), **reasoning tokens** (double-billed if the adapter copies both `completion_tokens` and its `reasoning_tokens` subset), **service tiers** (a flex/batch call billed at standard rates is 2× wrong), and **server-side tool surcharges** (Anthropic web search is $10/1k calls carried inside the `usage` object — dropping it silently under-bills).
- Makes cost **auditable and reproducible** — an entry is rated at the price in effect at the moment of the call, never re-rated at today's price.
- Turns "provider cost" into "customer price" with a first-class **markup multiplier / credit exchange rate** — the SaaS profit lever.
- Owns its own migrated tables, so usage, prices, budgets, and wallets are one dependency, not five integrations.

### 1.3 Who uses it

NestJS applications in the Bymax ecosystem that call LLMs and need to (a) track cost per feature for internal FinOps, and/or (b) charge their own users/tenants for AI usage. Multi-tenant SaaS platforms that resell AI capabilities under their own brand and pricing. Any NestJS project that wants exact, provider-agnostic token accounting without adopting a separate billing platform.

### 1.4 Distribution

| Aspect        | Detail                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| Registry      | Public npm (`@bymax-one/nest-ai-tokens`)                                      |
| License       | MIT                                                                           |
| Runtime       | Node.js 24+                                                                   |
| Framework     | NestJS 11+                                                                    |
| Subpaths      | `.` (server), `./shared` (zero-dep), `./prices` (seed dataset), `./prisma` (store adapter), `./redis` (budget counter) |
| Persistence   | Storage-port + official Prisma/PostgreSQL adapter                             |

### 1.5 Design Principles

1. **Normalizer-first, provider-agnostic** — the canonical unit is a `NormalizedUsage`; provider SDKs are never required. The library never makes the LLM call itself.
2. **The ground truth is the provider-reported `usage`** — client-side token counting is used only for pre-flight budget holds and context guards, then reconciled against actuals.
3. **Money is an integer** — every persisted monetary value, in every table, is integer **nano-USD** (`bigint`); never floating point. Currency conversion and rounding to cents happen only at presentation time (reports, exports, status).
4. **Point-in-time pricing** — every ledger entry references the immutable price version in effect at the call timestamp, keyed by `(provider, model, operation, serviceTier)`. Prices are append-only and effective-dated.
5. **Append-only ledger, derived balance** — usage and credits are immutable entries; balances are the sum of entries; corrections are compensating entries, never `UPDATE`/`DELETE`.
6. **Exactly-once accounting** — a host-supplied, content-derived idempotency key makes retries after a 429/network failure safe from double-billing. The library exports the derivation helper; the host owns the request payload and therefore supplies the key.
7. **Markup is a first-class knob** — the difference between provider cost and customer price is configuration, not application code. It applies in both rating modes, including on top of provider-reported cost.
8. **PII discipline** — the ledger stores token counts, model, cost, and IDs only; never prompt or completion text.
9. **Configuration over convention** — everything wired via `forRoot()` / `forRootAsync()`; opt-in extensions register zero providers when unused.
10. **Idiomatic NestJS** — dynamic module, `Symbol()` DI tokens, injectable services, a `CanActivate` guard, an interceptor, decorators, and typed events over the optional `@nestjs/event-emitter`.

### 1.6 Features

**Core (always active):**

- **Usage normalizers** (pure functions, `./shared`) — map every provider `usage` shape into `NormalizedUsage` (input / output / cache-read / cache-write-5m / cache-write-1h / reasoning / audio-in / audio-out / image-in / image-out / server-tool units / service tier / provider-reported cost).
- `PricingService` — versioned, effective-dated rate resolution with model-ID alias resolution and two rating modes (rate-table and provider-reported).
- `MeteringService` — the public facade: `record()`, `meter()`, `hold()` / `capture()` / `release()`, `reverse()`, `estimateCost()`, `getStatus()`.
- `LedgerService` — append immutable usage records, compensating entries, query, sum, chain verification.

**Opt-in (enabled via config):**

- `WalletService` (`wallets: {}`) — prepaid credit balances, grants with burn-down, debits, refunds, adjustments, entry history.
- `BudgetService` + `BudgetGuard` (`budgets: {}`) — multi-scope, multi-window, feature-scoped budgets (spend, tokens, and operation counts) with soft/hard enforcement, billing-cycle anchoring, and a status API.
- `MeteringInterceptor` — automatic capture around a decorated handler, optional cost response headers.
- Typed **events** (`events: {}`) — budget/wallet/usage event catalog over `@nestjs/event-emitter` and/or an `IEventSink`.
- OpenTelemetry emission (`telemetry: {}`) — `gen_ai.*` spans and metrics.
- `UsageReportService` (`reporting: {}`) — SQL aggregation + CSV/JSON export, cache-savings reporting.

> When an opt-in extension is not configured, its providers are not registered in the NestJS container — zero runtime overhead.

---

## 2. Architecture

### 2.1 NestJS dynamic module

`@bymax-one/nest-ai-tokens` is a `@Global()` dynamic module that runs inside each application that imports it. It is global — unlike `@bymax-one/nest-storage` — because the `BudgetGuard` and `MeteringInterceptor` must be injectable from any feature module without re-importing, and because a single ledger/pricing instance per application is a correctness requirement, not a convenience. The consuming app controls the persistence adapter (store), the price dataset, the markup policy, and the budget configuration.

```
┌────────────────────────────────────────────────────────────────┐
│                   Host Application (NestJS)                     │
│                                                                 │
│  LLM call (OpenAI / Azure / Anthropic / Gemini / Vertex /       │
│   Mistral / Bedrock / OpenRouter / OpenAI-compatible /          │
│   Vercel AI SDK)  ──►  response.usage                           │
│                            │                                    │
│                            ▼                                    │
│   MeteringService ──► normalizer ──► NormalizedUsage             │
│        │                                                        │
│        ├──► PricingService ──► resolveRate(model, tier, at)      │
│        │         │              └─ alias resolution              │
│        │         └──► cost (+ surcharges) ──► markup ──► billed  │
│        │                                                        │
│        ├──► BudgetService ──► hold / capture (auth-hold model)   │
│        ├──► WalletService ──► atomic conditional debit           │
│        ├──► LedgerService ──► append immutable record            │
│        └──► Events + OTel gen_ai.* emission                      │
│                     │                                           │
│                     ▼                                           │
│      ILedgerStore / IPricingStore / IWalletStore / IBudgetStore  │
│                     │                                           │
│              ┌──────────────┐   ┌──────────────────┐            │
│              │ Prisma/Postgres│  │ Redis (optional)  │            │
│              │  (own tables)  │  │ IBudgetCounterStore│           │
│              └──────────────┘   └──────────────────┘            │
└────────────────────────────────────────────────────────────────┘
```

### 2.2 The metering lifecycle — auth-hold → capture

The library models the gap between a pre-call **estimate** and the provider-reported **actual** on the credit-card **authorization-hold → capture → settlement** flow. This is what makes concurrent enforcement correct and makes streaming/aborted calls bill fairly.

```
1. hold(ctx, estimate) → rate the estimate (provider/model/tier come from the estimate)
                       → apply markup
                       → atomically consume budget windows + counter, then debit wallet
                       → write a PENDING ledger entry (the "hold") with a TTL
                       → throw AI_TOKENS_BUDGET_EXCEEDED / _QUOTA_EXCEEDED /
                         _INSUFFICIENT_CREDITS if any check fails (each step compensated)
2. (host runs the LLM call)
3. capture(hold, usage) → normalize the provider usage (final SSE chunk for streams)
                        → rate actuals; settle: pending → POSTED with actual amounts
                        → adjust wallet/budget by the delta vs the hold (release or top up)
                        → idempotent: capturing an already-captured hold returns the
                          posted record unchanged
4. release(hold, reason) → void the hold: pending → RELEASED, restore wallet/budget
                          in full. release() never bills — partial billing on an
                          aborted stream is done by calling capture() with the
                          StreamUsageCollector's partial count instead.
```

Expired holds (process crashed between 1 and 3) are swept by the **hold reaper** (§8.3) after `holds.ttlSeconds` — the reaper performs the same restoration as `release()`. The reaper is a v0.1 requirement, not an optimization: a hold moves real wallet/budget headroom.

`MeteringService.meter(fn, ctx, extract)` wraps steps 1–4 around an async function for the common case; `hold()` / `capture()` / `release()` are exposed for full manual control (streaming, multi-call features); `record(input)` is the pure post-hoc path (no hold) that mirrors how `bymax-fitness` works today — observe-only by default, enforcing when `ctx.enforce: true` (§11.4).

### 2.3 Rating flow — two modes

```
NormalizedUsage + (provider, model, operation, serviceTier, occurredAt)
   │
   ├─ mode = 'rate-table' (default):
   │     resolveRate(provider, model, operation, serviceTier, occurredAt)
   │       └─ model alias resolution (§6.6): exact → alias map → normalized → prefix
   │     cost = Σ (tokens[category] × ratePerMillion[category]) / 1_000_000    (bigint)
   │            + Σ (extraUnits[unit] × unitRate[unit])                        (surcharges)
   │            with long-context tier rates when the threshold is crossed (§7.1)
   │
   └─ mode = 'provider-reported':
         cost = normalizedUsage.providerReportedCostNanoUsd    (OpenRouter usage.cost, …)
   │
   ▼
rawCostNanoUsd ──► applyMarkup(multiplier) ──► billedCostNanoUsd
```

Markup applies in **both** modes — including on top of OpenRouter's provider-reported cost. `provider-reported` is mandatory for OpenRouter (which returns the real charged `usage.cost`) and any gateway that already computed the dollar amount — the equivalent of Lago's `dynamic` charge. `rate-table` is used for direct provider calls.

### 2.4 Storage ports — why the library owns its tables but not your ORM

Unlike `@bymax-one/nest-storage` (which deliberately persists nothing), this library is **stateful by definition**: an immutable ledger, versioned prices, budgets, and wallets are its reason to exist. To stay idiomatic to the family's provider-agnostic DNA, persistence is abstracted behind ports:

- **Four storage ports:** `ILedgerStore`, `IPricingStore`, `IWalletStore`, `IBudgetStore` — bundled as `IAiTokensStore` (§4.1). The `forRoot()` wiring registers the single `store` object under each per-port DI token; a host may override any individual port by binding its token directly (§4.6).
- **One optional counter port:** `IBudgetCounterStore` — a live cross-replica spend counter (official Redis implementation in `./redis`). Without it, enforcement falls back to the budget store's DB atomic conditional consume — correct, but a hotter row under high concurrency.
- The official adapter `PrismaAiTokensStore` (`./prisma`, Prisma 6+ / PostgreSQL, matching the `bymax-fitness` stack) implements the four storage ports and ships a schema fragment + SQL migrations (§15.3).
- A host that enables neither `wallets` nor `budgets` only needs the ledger + pricing halves; `forRoot()` validates at init that every enabled feature has a working port (§4.6).

### 2.5 Why in-process (guard/interceptor) instead of a proxy

A proxy/gateway (LiteLLM, Helicone, Portkey) requires a separate process, a network hop, and a second source of truth. In NestJS, enforcement "in the request path" is exactly a `CanActivate` guard plus an `Interceptor` — no extra infrastructure, the tenant/user context is already resolved by the host's auth layer, and the ledger lives in the same transaction boundary as the rest of the request. This is the gap the library fills: there is no NestJS-native metering + ledger + budget + markup library in the ecosystem (nearest prior art is `@golevelup/nestjs-stripe`, which handles Stripe webhooks — a pattern this library's `IEventSink` borrows).

---

## 3. Package Structure

### 3.1 Directory tree

```
@bymax-one/nest-ai-tokens/
├── package.json, tsconfig.*.json, tsup.config.ts
├── src/
│   ├── server/                              # NestJS backend (subpath ".")
│   │   ├── index.ts
│   │   ├── bymax-ai-tokens.module.ts         # Root dynamic module (forRoot/forRootAsync)
│   │   ├── bymax-ai-tokens.constants.ts      # Injection tokens (Symbol)
│   │   ├── interfaces/                       # module-options, metering-context, hold,
│   │   │                                     # ports: ledger-store, pricing-store,
│   │   │                                     # wallet-store, budget-store,
│   │   │                                     # budget-counter-store, markup-policy,
│   │   │                                     # tokenizer, telemetry-sink, event-sink,
│   │   │                                     # content-store
│   │   ├── config/                           # default-options, resolved-options,
│   │   │                                     # validate-options, provider-presets
│   │   ├── services/                         # metering, pricing, ledger, wallet,
│   │   │                                     # budget, usage-report
│   │   ├── enforcement/                      # budget.guard, metering.interceptor,
│   │   │                                     # decorators (@Meter, @RequireBudget,
│   │   │                                     # @AiFeature), hold-reaper
│   │   ├── streaming/                        # stream-usage-collector (public)
│   │   ├── events/                           # event catalog types, emitter bridge
│   │   ├── telemetry/                        # otel-emitter, no-op-telemetry
│   │   ├── errors/                           # ai-tokens-error-codes, ai-tokens-exception,
│   │   │                                     # error-messages, error-status
│   │   └── utils/                            # money (nano-usd bigint math), idempotency,
│   │                                         # hash-chain, window-anchor (UTC + cycle),
│   │                                         # model-id (normalization)
│   ├── shared/                              # zero deps (subpath "./shared")
│   │   ├── index.ts
│   │   ├── normalizers/                      # pure: openai-chat, openai-responses,
│   │   │                                     # openai-compatible, anthropic, gemini,
│   │   │                                     # bedrock-converse, mistral, openrouter,
│   │   │                                     # vercel-ai-sdk (v5+v6) → NormalizedUsage
│   │   ├── pricing/                          # compute-cost (pure, tier+surcharge aware),
│   │   │                                     # apply-markup, rate-types
│   │   ├── types/                            # normalized-usage, usage-record,
│   │   │                                     # price-version, wallet, budget, report,
│   │   │                                     # events, error-types, catalogs
│   │   └── constants/                        # provider-ids, operations, service-tiers,
│   │                                         # token-categories, wallet-entry-types,
│   │                                         # error-codes
│   ├── prices/                              # data-only (subpath "./prices")
│   │   └── index.ts                          # MODEL_PRICES_SEED (pinned snapshot)
│   ├── prisma/                              # official store adapter (subpath "./prisma")
│   │   ├── index.ts                          # PrismaAiTokensStore (four storage ports)
│   │   ├── schema.prisma.fragment            # models for the host's multi-file schema
│   │   └── migrations/                       # SQL for the seven tables
│   └── redis/                               # official counter (subpath "./redis")
│       └── index.ts                          # RedisBudgetCounterStore
├── test/                                    # e2e (Testcontainers + Postgres [+ Redis])
├── scripts/check-size.mjs
└── docs/
```

### 3.2 Subpath exports

```json
{
  "exports": {
    ".":         { "types": "./dist/server/index.d.ts", "import": "./dist/server/index.mjs", "require": "./dist/server/index.cjs" },
    "./shared":  { "types": "./dist/shared/index.d.ts", "import": "./dist/shared/index.mjs", "require": "./dist/shared/index.cjs" },
    "./prices":  { "types": "./dist/prices/index.d.ts", "import": "./dist/prices/index.mjs", "require": "./dist/prices/index.cjs" },
    "./prisma":  { "types": "./dist/prisma/index.d.ts", "import": "./dist/prisma/index.mjs", "require": "./dist/prisma/index.cjs" },
    "./redis":   { "types": "./dist/redis/index.d.ts",  "import": "./dist/redis/index.mjs",  "require": "./dist/redis/index.cjs" }
  }
}
```

| Subpath      | Description                                                              | Dependencies            |
| ------------ | ------------------------------------------------------------------------ | ----------------------- |
| `.` (server) | Dynamic module, services, guard, interceptor, decorators, collector, ports | NestJS                  |
| `./shared`   | Pure normalizers, pure cost math, types, catalogs, error codes           | Zero                    |
| `./prices`   | `MODEL_PRICES_SEED` — the pinned price snapshot (data-only, large)       | Zero                    |
| `./prisma`   | `PrismaAiTokensStore` + schema fragment + migrations                     | `@prisma/client` (peer) |
| `./redis`    | `RedisBudgetCounterStore`                                                | `ioredis` (peer)        |

> The price seed lives in its own subpath so `./shared` stays within the family's tiny-bundle budget (§19.1); the server entry imports it lazily only when `pricing.seedFromSnapshot` is enabled.

### 3.3 Public exports

**Server (`@bymax-one/nest-ai-tokens`):**

- Module: `BymaxAiTokensModule`
- Facade services (the intended public surface): `MeteringService`, `WalletService`, `BudgetService`, `UsageReportService`
- Lower-level services (exported for advanced/admin use): `PricingService`, `LedgerService`
- Enforcement: `BudgetGuard`, `MeteringInterceptor`, `@Meter()`, `@RequireBudget()`, `@AiFeature()`
- Streaming: `StreamUsageCollector`
- Presets: `providerPresets`
- Tokens: `BYMAX_AI_TOKENS_OPTIONS`, `BYMAX_AI_TOKENS_LEDGER_STORE`, `BYMAX_AI_TOKENS_PRICING_STORE`, `BYMAX_AI_TOKENS_WALLET_STORE`, `BYMAX_AI_TOKENS_BUDGET_STORE`, `BYMAX_AI_TOKENS_BUDGET_COUNTER`, `BYMAX_AI_TOKENS_TOKENIZER`, `BYMAX_AI_TOKENS_TELEMETRY`, `BYMAX_AI_TOKENS_EVENT_SINK`, `BYMAX_AI_TOKENS_CONTENT_STORE`, `BYMAX_AI_TOKENS_LOGGER`
- Types: `BymaxAiTokensModuleOptions`, `MeteringContext`, `MeterResult`, `Hold`, `AccessStatus`, `BudgetStatus`, and every port interface (`IAiTokensStore`, `ILedgerStore`, `IPricingStore`, `IWalletStore`, `IBudgetStore`, `IBudgetCounterStore`, `ITokenizer`, `ITelemetrySink`, `IEventSink`, `IContentStore`, `IMarkupPolicy`)
- Errors: `AiTokensException`, `AI_TOKENS_ERROR_CODES`, `AiTokensErrorResponse`
- **Re-export rule (family precedent):** the server entry re-exports every `./shared` type and constant, so server consumers use a single import; `./shared` exists for frontends/workers/edge code that must stay NestJS-free.

**Shared (`@bymax-one/nest-ai-tokens/shared`):**

- Normalizers: `normalizeOpenAiChatUsage`, `normalizeOpenAiResponsesUsage`, `normalizeOpenAiCompatibleUsage`, `normalizeAnthropicUsage`, `normalizeGeminiUsage`, `normalizeBedrockConverseUsage`, `normalizeMistralUsage`, `normalizeOpenRouterUsage`, `normalizeVercelAiSdkUsage`
- Pure math: `computeCostNanoUsd`, `applyMarkup`, `deriveIdempotencyKey`, `formatNanoUsd`
- Catalogs & constants: `PROVIDER_IDS`, `AI_OPERATIONS`, `SERVICE_TIERS`, `TOKEN_CATEGORIES`, `WALLET_ENTRY_TYPES`, `AI_TOKENS_ERROR_CODES`
- Types: `NormalizedUsage`, `UsageNormalizer`, `ProviderPreset`, `ProviderId`, `AiOperation`, `ServiceTier`, `RatingMode`, `TokenCategory`, `MeteringScope`, `ScopeType`, `UsageRecord`, `UsageStatus`, `PriceVersion`, `Wallet`, `WalletRef`, `WalletEntry`, `Budget`, `BudgetWindowKind`, `BudgetPolicy`, `LedgerFilter`, `ReportFilter`, `UsageSummary`, `AiTokensEvent` (+ per-event payload types)

**Prices (`@bymax-one/nest-ai-tokens/prices`):** `MODEL_PRICES_SEED`.

**Prisma (`@bymax-one/nest-ai-tokens/prisma`):** `PrismaAiTokensStore`.

**Redis (`@bymax-one/nest-ai-tokens/redis`):** `RedisBudgetCounterStore`.

> **Public vs internal:** `KeyResolver`-style internals — the money/hash-chain/window-anchor/model-id utilities, the hold reaper, the event emitter bridge, and the error message/status maps — are implementation details and are not exported.

---

## 4. Configuration API

### 4.1 `BymaxAiTokensModuleOptions` interface

```typescript
export interface BymaxAiTokensModuleOptions {
  /**
   * Persistence adapter implementing the storage ports. Use PrismaAiTokensStore or a
   * custom implementation. The wallet/budget halves are only exercised (and validated
   * at init) when the corresponding feature is enabled. REQUIRED.
   */
  store: IAiTokensStore

  /**
   * Resolves the metering scope from the current request — used by BudgetGuard and
   * MeteringInterceptor. Receives the ExecutionContext; typically reads the host's
   * auth payload (req.user). REQUIRED when the guard/interceptor/decorators are used;
   * unnecessary for pure service-level usage.
   */
  scopeResolver?: (ctx: ExecutionContext) => MeteringContext | Promise<MeteringContext>

  /**
   * Default rating mode. 'rate-table' computes cost from the price registry;
   * 'provider-reported' trusts NormalizedUsage.providerReportedCostNanoUsd.
   * Can be overridden per call/preset. Default: 'rate-table'.
   */
  ratingMode?: RatingMode

  /**
   * Presentation currency for reports/exports/status. ALL persisted money is nano-USD
   * (§7.4); this setting only converts at presentation time. Default: 'USD'.
   */
  currency?: string

  /**
   * FX resolver USD → `currency`, returning integer nano-units of `currency` per USD.
   * Required when currency !== 'USD' (otherwise AI_TOKENS_FX_REQUIRED at init).
   */
  fx?: (date: Date, currency: string) => Promise<bigint> | bigint

  /** Price registry behavior. */
  pricing?: {
    /** Seed the registry from MODEL_PRICES_SEED on first boot (idempotent, advisory-locked). Default: true. */
    seedFromSnapshot?: boolean
    /** Throw AI_TOKENS_PRICE_NOT_FOUND when no rate matches. If false, record with cost 0 + priceMissing flag. Default: true. */
    strict?: boolean
    /** In-memory rate cache TTL. Default: 300_000 ms. See §20.3 on staleness. */
    cacheTtlMs?: number
    /** Model-ID alias map consulted during rate resolution (§6.6), e.g. { 'my-azure-deployment': 'gpt-5.4' }. */
    modelAliases?: Record<string, string>
  }

  /**
   * Markup / margin — the SaaS profit lever. A flat multiplier or a policy object.
   * Validated: finite, > 0, at most 4 decimal places (rounded to 4 dp otherwise).
   * Default: 1.0 (bill at cost — internal FinOps only).
   */
  markup?: number | IMarkupPolicy

  /** Enables WalletService when present. */
  wallets?: {
    /** 1 credit = this many nano-USD (presentation + grant sizing). Default: 1_000_000_000n (1 credit = $1). */
    creditRateNanoUsd?: bigint
    /** Allow the balance to go negative (postpaid overdraft) up to this many nano-USD. Default: 0n. */
    overdraftNanoUsd?: bigint
    /** Grant burn order: 'expiry' (soonest first) | 'priority' | 'fifo'. Default: 'expiry'. */
    burnOrder?: 'expiry' | 'priority' | 'fifo'
  }

  /** Enables BudgetService + BudgetGuard when present. */
  budgets?: {
    /** Default enforcement policy when a budget is exceeded. Default: 'block'. */
    defaultPolicy?: BudgetPolicy
    /** Soft-alert thresholds as fractions of the limit. Default: [0.8, 1.0]. */
    alertThresholds?: number[]
    /** Optional live cross-replica spend counter (Redis). Falls back to DB atomic consume. */
    counter?: IBudgetCounterStore
    /** Enforce budgets as a hard ceiling even if the counter store is unavailable. Default: true. */
    failClosed?: boolean
    /** Host callback invoked when a matched budget has policy 'throttle'. Absent → 'throttle' behaves as 'allow' + warning. */
    onThrottle?: (ctx: { context: MeteringContext; budget: Budget; status: BudgetStatus }) => void | Promise<void>
  }

  /** Hold lifecycle (applies whenever hold()/meter() is used). */
  holds?: {
    /** Pending-hold TTL; expired holds are swept (wallet/budget restored). Default: 3_600 s. */
    ttlSeconds?: number
    /** Reaper sweep interval. Default: 300 s. */
    reaperIntervalSeconds?: number
  }

  /** Ledger extras. */
  ledger?: {
    /** Per-tenant tamper-evident hash chain over posted records (§8.6). Serializes appends per tenant — see §20.2. Default: false. */
    hashChain?: boolean
  }

  /** Pre-flight token estimation used by hold() when the caller supplies text instead of counts. */
  tokenizer?: ITokenizer

  /** Typed event emission (§12). */
  events?: {
    /** Emit through @nestjs/event-emitter's EventEmitter2 when the host has it installed. Default: true. */
    emitter?: boolean
    /** Additional programmatic sink (webhooks, queues). */
    sink?: IEventSink
  }

  /** OpenTelemetry emission of gen_ai.* attributes and metrics. */
  telemetry?: {
    sink?: ITelemetrySink
    /** Emit gen_ai.client.token.usage histogram + operation.duration. Default: true when sink present. */
    metrics?: boolean
  }

  /** Reporting + export. */
  reporting?: {
    /** Max rows a single export streams before requiring pagination. Default: 1_000_000. */
    maxExportRows?: number
  }

  /**
   * PII policy for the optional prompt/response text sidecar. The immutable ledger NEVER
   * stores text. Default: undefined (no text is ever stored).
   */
  content?: {
    store: IContentStore
    /** Mask function applied before persistence. */
    mask?: (text: string) => string
    /** Retention in seconds. Default: 604_800 (7 days). */
    ttlSeconds?: number
  }
}

/**
 * Aggregate port bundle. Ledger + pricing are always required; wallet + budget methods
 * are validated at init only when the corresponding feature is configured.
 */
export interface IAiTokensStore
  extends ILedgerStore, IPricingStore, Partial<IWalletStore>, Partial<IBudgetStore> {}
```

### 4.2 Summary of required options and defaults

**Required:** `store` (+ `scopeResolver` when guard/interceptor/decorators are used).

| Category   | Defaults                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Rating     | `ratingMode: 'rate-table'`, `pricing.strict: true`, `pricing.seedFromSnapshot: true`, `pricing.cacheTtlMs: 300_000` |
| Currency   | `currency: 'USD'`; all persisted money is nano-USD regardless (§7.4)                                          |
| Markup     | `markup: 1.0`                                                                                                 |
| Wallets    | `creditRateNanoUsd: 1_000_000_000n`, `overdraftNanoUsd: 0n`, `burnOrder: 'expiry'`                             |
| Budgets    | `defaultPolicy: 'block'`, `alertThresholds: [0.8, 1.0]`, `failClosed: true`                                    |
| Holds      | `ttlSeconds: 3_600`, `reaperIntervalSeconds: 300`                                                              |
| Ledger     | `hashChain: false`                                                                                             |
| Events     | `emitter: true` (no-op unless `@nestjs/event-emitter` is installed)                                            |
| Telemetry  | `metrics: true` (when a sink is present)                                                                       |
| Content    | disabled — no prompt/response text is ever persisted                                                           |

### 4.3 Provider presets

A preset pairs a normalizer with the right provider ID and rating mode:

```typescript
export interface ProviderPreset {
  provider: ProviderId
  normalizer: UsageNormalizer
  ratingMode: RatingMode
}

import { providerPresets } from '@bymax-one/nest-ai-tokens'

providerPresets.openaiChat          // { provider: 'openai',       normalizeOpenAiChatUsage,      'rate-table' }
providerPresets.openaiResponses     // { provider: 'openai',       normalizeOpenAiResponsesUsage, 'rate-table' }
providerPresets.azureOpenai         // { provider: 'azure-openai', normalizeOpenAiChatUsage,      'rate-table' } — pass baseModel! (§6.6)
providerPresets.anthropic           // { provider: 'anthropic',    normalizeAnthropicUsage,       'rate-table' }
providerPresets.gemini              // { provider: 'gemini',       normalizeGeminiUsage,          'rate-table' }
providerPresets.vertex              // { provider: 'vertex',       normalizeGeminiUsage,          'rate-table' }
providerPresets.bedrock             // { provider: 'bedrock',      normalizeBedrockConverseUsage, 'rate-table' }
providerPresets.mistral             // { provider: 'mistral',      normalizeMistralUsage,         'rate-table' }
providerPresets.vercelAiSdk         // { provider: 'openai'*,      normalizeVercelAiSdkUsage,     'rate-table' } — *override per call
providerPresets.openrouter          // { provider: 'openrouter',   normalizeOpenRouterUsage,      'provider-reported' }
providerPresets.openaiCompatible(id: string)  // custom ProviderId ('deepseek', 'xai', 'groq', …) + chat normalizer
```

The preset is passed in `MeteringContext.preset` (used by `meter()`, the interceptor, and `record()`); `record()` alternatively accepts a raw `normalizer` function directly.

### 4.4 `forRootAsync` example

```typescript
BymaxAiTokensModule.forRootAsync({
  imports: [ConfigModule, PrismaModule],
  inject: [ConfigService, PrismaService],
  useFactory: (config: ConfigService, prisma: PrismaService) => ({
    store: new PrismaAiTokensStore(prisma),
    scopeResolver: (ctx) => {
      const req = ctx.switchToHttp().getRequest()
      return {
        tenantId: req.user.tenantId,
        scope: { type: 'user', id: req.user.id },
        feature: 'unset', // decorators override
      }
    },
    markup: 4.0,                                        // resell at 4× provider cost
    wallets: { creditRateNanoUsd: 5_000_000_000n },     // 1 credit = $5
    budgets: {
      defaultPolicy: 'block',
      alertThresholds: [0.8, 0.95, 1.0],
      counter: new RedisBudgetCounterStore(config.getOrThrow('REDIS_URL')),
    },
    telemetry: { sink: otelSink },                      // an ITelemetrySink implementation
  }),
})
```

### 4.5 Injection tokens

All defined via `Symbol()` in `bymax-ai-tokens.constants.ts`: `BYMAX_AI_TOKENS_OPTIONS` (resolved options), `BYMAX_AI_TOKENS_LEDGER_STORE`, `BYMAX_AI_TOKENS_PRICING_STORE`, `BYMAX_AI_TOKENS_WALLET_STORE`, `BYMAX_AI_TOKENS_BUDGET_STORE`, `BYMAX_AI_TOKENS_BUDGET_COUNTER`, `BYMAX_AI_TOKENS_TOKENIZER`, `BYMAX_AI_TOKENS_TELEMETRY`, `BYMAX_AI_TOKENS_EVENT_SINK`, `BYMAX_AI_TOKENS_CONTENT_STORE`, `BYMAX_AI_TOKENS_LOGGER`.

### 4.6 Wiring and precedence rules

- `forRoot()` **fans the single `store` object out** under each per-port token (`BYMAX_AI_TOKENS_LEDGER_STORE`, …). A host-provided binding for an individual port token **overrides** the bundle for that port.
- The same rule applies to every option-vs-token pair (`budgets.counter` ↔ `BYMAX_AI_TOKENS_BUDGET_COUNTER`, `tokenizer` ↔ `_TOKENIZER`, `telemetry.sink` ↔ `_TELEMETRY`, `events.sink` ↔ `_EVENT_SINK`, `content.store` ↔ `_CONTENT_STORE`): the option value is registered under the token; a direct token binding wins. Binding a token does **not** enable a disabled feature — features are enabled only by their options block.
- **Validation at init:** `forRoot()`/`forRootAsync()` validate the resolved options (`AI_TOKENS_INVALID_CONFIG` on failure) and verify that every enabled feature's port methods exist on the store (e.g. `wallets: {}` without `IWalletStore` methods → init error). `AI_TOKENS_NOT_CONFIGURED` (503) is reserved for the async-factory edge where a service is invoked before the resolved options/store finished initializing.

---

## 5. Provider Usage Normalizer

The normalizer is the heart of the library. Each provider reports usage in a different shape; a single canonical type lets everything downstream (pricing, ledger, budgets) be provider-agnostic.

### 5.1 Catalogs

```typescript
/** Known providers; custom OpenAI-compatible providers register their own ID via providerPresets.openaiCompatible(). */
export type ProviderId =
  | 'openai' | 'azure-openai' | 'anthropic' | 'gemini' | 'vertex' | 'mistral'
  | 'bedrock' | 'openrouter' | 'deepseek' | 'xai' | 'groq'
  | (string & {})

export type AiOperation =
  | 'chat' | 'responses' | 'embeddings' | 'image' | 'video' | 'audio' | 'rerank' | 'moderation'

/**
 * Service tier of the actual response. 'batch' = Batch API (≈50% discount);
 * 'flex' = OpenAI flex processing (batch rates, synchronous); 'priority' = paid premium.
 * IMPORTANT: providers may silently downgrade (OpenAI returns service_tier: "default"
 * when priority capacity is exhausted) — pricing MUST key off the tier reported in the
 * RESPONSE, which is what the normalizers read.
 */
export type ServiceTier = 'standard' | 'batch' | 'flex' | 'priority'

export type RatingMode = 'rate-table' | 'provider-reported'

export type TokenCategory =
  | 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h'
  | 'reasoning' | 'audioIn' | 'audioOut' | 'imageIn' | 'imageOut'

export interface MeteringScope { type: 'tenant' | 'team' | 'user' | 'key'; id: string }
export type ScopeType = MeteringScope['type']

/** A pure function mapping one provider's raw usage object into the canonical shape. */
export type UsageNormalizer = (raw: unknown) => NormalizedUsage
```

OpenAI Chat Completions and the Responses API share `provider: 'openai'` and are distinguished by `operation` (`'chat'` vs `'responses'`); rate resolution treats `'responses'` as `'chat'` (the two APIs bill identically, so they share `'chat'` price rows).

### 5.2 `NormalizedUsage`

```typescript
export interface NormalizedUsage {
  provider: ProviderId
  /** Model ID as reported by the RESPONSE (may be a dated snapshot — see §6.6). */
  model: string
  operation: AiOperation
  /** Tier reported by the response; absent → 'standard'. */
  serviceTier?: ServiceTier
  /** Uncached, non-reasoning input tokens (after the last cache breakpoint). */
  inputTokens: number
  /**
   * Output/completion tokens EXCLUDING reasoning tokens (§5.5 invariant).
   * Anthropic folds thinking into output with no sub-field → adapters leave
   * reasoningTokens 0 and keep everything here.
   */
  outputTokens: number
  /** Tokens served from a cache hit (billed at a fraction of input). */
  cacheReadTokens: number
  /** Tokens written to a 5-minute cache (Anthropic 1.25× input; Bedrock cacheWrite). */
  cacheWrite5mTokens: number
  /** Tokens written to a 1-hour cache (Anthropic 2× input). */
  cacheWrite1hTokens: number
  /** Reasoning/thinking tokens reported separately (OpenAI, Gemini). Priced at the output (or dedicated) rate. */
  reasoningTokens: number
  /** Multimodal token categories. */
  audioInTokens: number
  audioOutTokens: number
  imageInTokens: number
  imageOutTokens: number
  /**
   * Server-side tool usage counts — NON-token line items rated via PriceVersion.unitRates
   * (§6.2), e.g. { web_search_requests: 2 }. Anthropic reports these inside usage
   * (usage.server_tool_use); for OpenAI/Gemini the host passes counts via
   * MeteringContext.extraUnits because the usage object does not carry them.
   */
  serverToolUse?: Record<string, number>
  /** Provider-reported cost in nano-USD when available (OpenRouter usage.cost) — enables 'provider-reported' rating. */
  providerReportedCostNanoUsd?: bigint
  /** Unclassified fields preserved verbatim for audit. */
  raw?: Record<string, unknown>
}
```

### 5.3 Per-provider field mapping

| Provider / API           | Source fields the adapter reads                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI Chat**          | `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.{cached_tokens, audio_tokens}`, `completion_tokens_details.{reasoning_tokens, audio_tokens}`, response `service_tier`, response `model`. **`outputTokens = completion_tokens − reasoning_tokens`** (details are a subset, not an addition). |
| **OpenAI Responses**     | `usage.input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens` (same subtraction rule; note the input/output rename vs Chat). |
| **OpenAI-compatible**    | Same shape as OpenAI Chat (`prompt_tokens`/`completion_tokens`), verified for DeepSeek, xAI, Groq; provider ID supplied by the preset. DeepSeek's `prompt_cache_hit_tokens` maps to `cacheReadTokens`. |
| **Azure OpenAI**         | Same shape as OpenAI Chat; model identity comes from the deployment name → callers MUST pass `baseModel` (§6.6). |
| **Anthropic Messages**   | `usage.input_tokens`, `output_tokens` (thinking already included; `reasoningTokens: 0`), `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, `usage.service_tier` (standard/priority/batch), `usage.server_tool_use.web_search_requests` → `serverToolUse`. |
| **Google Gemini**        | `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount, toolUsePromptTokenCount}`. `candidatesTokenCount` EXCLUDES thoughts → maps directly to `outputTokens`; `thoughtsTokenCount → reasoningTokens`; `toolUsePromptTokenCount` folds into `inputTokens` (billed at input rate). |
| **Vertex AI (Gemini)**   | Same `usageMetadata` shape → reuses the Gemini normalizer with `provider: 'vertex'`; model IDs aliased (§6.6). |
| **AWS Bedrock Converse** | `usage.{inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens, cacheDetails[]}` — `cacheDetails` TTL entries map to `cacheWrite5m/1h`; model IDs like `us.anthropic.claude-…-v1:0` aliased (§6.6). |
| **Mistral**              | `usage.{prompt_tokens, completion_tokens}`; additional audio/cache detail fields are preserved in `raw` (their exact shape is version-dependent and not normatively mapped in v0.1). |
| **OpenRouter**           | `usage.{prompt_tokens, completion_tokens, cost}`, `cost_details.upstream_inference_cost`, `prompt_tokens_details.{cached_tokens, cache_write_tokens}`, `completion_tokens_details.reasoning_tokens` (same subtraction rule). `cost` (float USD) → `providerReportedCostNanoUsd = BigInt(Math.round(cost × 1e9))`. |
| **Vercel AI SDK**        | v5 shape (`usage.{inputTokens, outputTokens, cachedInputTokens, reasoningTokens}`) AND v6 shape (`inputTokenDetails.{cacheReadTokens, cacheWriteTokens}`, `outputTokenDetails.reasoningTokens`) — the adapter reads both. |

### 5.4 Cache tokens are first-class

Anthropic prompt caching prices are clean multipliers of base input: 5-minute cache write **1.25×**, 1-hour write **2×**, cache read **0.1×**. OpenAI prompt caching has no write fee — cached input is discounted and reported as `cached_tokens`. Because a naïve input/output-only model over-bills cached traffic by up to 10×, the normalizer and the rate schema treat `cacheRead`, `cacheWrite5m`, and `cacheWrite1h` as distinct rate categories.

### 5.5 Reconciliation invariants (per-adapter test requirements)

Every adapter must satisfy, against the provider's reported totals:

- **Input side:** `providerTotalInput = inputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens` (+ audio/image input categories where the provider splits them out of the prompt count).
- **Output side:** `providerTotalOutput = outputTokens + reasoningTokens`. Adapters for providers whose completion count *includes* reasoning (OpenAI Chat + Responses, OpenRouter) **subtract** the reasoning detail; adapters for providers that report thoughts *separately* (Gemini) map directly; Anthropic keeps `reasoningTokens: 0`.

These invariants are what prevent the two classic billing bugs: double-billing OpenAI reasoning tokens and under-billing Gemini thinking tokens.

### 5.6 Streaming-safe capture

For streamed responses, provider `usage` arrives only in the final chunk (OpenAI: last chunk with empty `choices`, requires `stream_options.include_usage`; Anthropic: cumulative in `message_delta`, finalized at `message_stop`). A stream aborted mid-flight returns **all-zero usage** even though tokens were consumed.

```typescript
export class StreamUsageCollector {
  constructor(opts: {
    provider: ProviderId
    model: string
    operation?: AiOperation           // default 'chat'
    preset?: ProviderPreset            // how to parse the final usage chunk
    tokenizer?: ITokenizer             // fallback counter; defaults to the module tokenizer
  })
  /** Feed every stream chunk; accumulates output text and watches for the final usage. */
  push(chunk: unknown): void
  /**
   * Provider-final usage if seen; else tokenizer count of the accumulated output
   * (partial billing); else throws AI_TOKENS_STREAM_USAGE_MISSING.
   */
  finalize(): NormalizedUsage
}
```

`capture()` accepts either a final `NormalizedUsage` or a `StreamUsageCollector`. **Aborted-stream input tokens:** when the collector falls back to counting (no provider-final usage), input tokens are taken from the tokenizer count of the prompt if the host provided it to the collector, else from the hold's estimated `inputTokens`, else `0` — in that order, documented so hosts know what an abort bills.

---

## 6. Pricing Registry (versioned, effective-dated)

### 6.1 Why point-in-time pricing is mandatory

A ledger entry must be rated at the price in effect at the moment of the call — never re-rated at today's price. This is the same invariant as Stripe's deliberately immutable `Price` object (to change a price you create a new one and archive the old) and ASC 606 revenue recognition (the transaction price is fixed at the time of the exchange). Model prices change on schedule (e.g. a mid-2026 Claude Sonnet tier increase), so a call the day before and the day after must bill different rates.

The registry is therefore **append-only and effective-dated** — the pattern already present in `bymax-fitness`'s `ModelPricing` (`effectiveFrom`/`effectiveTo`), generalized here with two extra dimensions: **service tier** and **non-token unit rates**.

### 6.2 `PriceVersion`

```typescript
export interface PriceVersion {
  id: string
  provider: ProviderId
  model: string
  operation: AiOperation
  /** Part of the resolution key. Batch/flex/priority calls resolve their own rows; 'standard' is the default. */
  serviceTier: ServiceTier
  /** Rates as integer nano-USD per 1,000,000 tokens. */
  inputNanoUsdPerMillion: bigint
  outputNanoUsdPerMillion: bigint
  cacheReadNanoUsdPerMillion: bigint
  cacheWrite5mNanoUsdPerMillion: bigint
  cacheWrite1hNanoUsdPerMillion: bigint
  /** Usually equals output; kept separate for models that price reasoning differently. */
  reasoningNanoUsdPerMillion: bigint
  audioInNanoUsdPerMillion: bigint
  audioOutNanoUsdPerMillion: bigint
  imageInNanoUsdPerMillion: bigint
  imageOutNanoUsdPerMillion: bigint
  /**
   * Long-context tier: when total input (all input-side categories) exceeds the
   * threshold, tier rates replace the base input/output rates for the WHOLE call
   * (all-or-nothing, matching Gemini's billing).
   */
  tierThresholdTokens?: number
  tierInputNanoUsdPerMillion?: bigint
  tierOutputNanoUsdPerMillion?: bigint
  /**
   * Non-token line items in nano-USD PER UNIT, matched against
   * NormalizedUsage.serverToolUse / MeteringContext.extraUnits — e.g.
   * { web_search_request: 10_000_000n, image: 40_000_000n, video_second: 100_000_000n }
   * (10_000_000n nano-USD = $0.01 per web-search call).
   * Persisted as JSON of decimal strings (bigint is not JSON-serializable) — §15.3.
   */
  unitRates?: Record<string, bigint>
  currency: 'USD'
  effectiveFrom: Date
  /** null = current; set when a newer row supersedes it. */
  effectiveTo: Date | null
  /** Provenance: 'snapshot' | 'manual' | 'import'. */
  source: string
}
```

### 6.3 Rate resolution

`PricingService.resolveRate(provider, model, operation, at, serviceTier?)` selects the row where `effectiveFrom <= at AND (effectiveTo IS NULL OR effectiveTo >= at)` for the resolved model ID (§6.6) and tier (falling back to the `'standard'` row when no tier-specific row exists **only** for `'standard'` requests — a `batch`/`flex`/`priority` call with no tier row is a strict-mode miss, never silently billed at standard rates). Results are cached in memory for `pricing.cacheTtlMs`.

`PricingService.upsertPrice(input: NewPriceVersion)` closes the current open row (`effectiveTo = now`) and inserts a new open row — full history retained, queryable via `PricingService.getPriceHistory(provider, model, operation, serviceTier?)`. `NewPriceVersion` is `Omit<PriceVersion, 'id' | 'effectiveTo'>` with every rate field optional (defaulting to `0n`).

In `strict` mode an unpriced call throws `AI_TOKENS_PRICE_NOT_FOUND`; otherwise the record is written with `rawCostNanoUsd = 0` and a `priceMissing` flag for later backfill.

### 6.4 The seed dataset

The library vendors a **pinned snapshot** (`MODEL_PRICES_SEED` in `./prices`, derived from LiteLLM's community-maintained `model_prices_and_context_window.json` — including its `*_batches` / `*_flex` / `*_priority` tier fields and `search_context_cost_per_query`-style unit rates — converted to nano-USD integers). Pinning keeps rates point-in-time stable. Seeding on first boot is **idempotent and advisory-locked** so N replicas booting simultaneously produce exactly one seed pass. A `refresh-prices` CLI (v0.2) pulls newer snapshots (LiteLLM + genai-prices as sources) and appends new effective-dated rows. Hosts override or add models via `upsertPrice()` (fine-tuned models, negotiated rates, custom providers).

### 6.5 OpenRouter — skip the table

For OpenRouter traffic, `usage.cost` is the real charged amount (1 credit = 1 USD); the normalizer converts it to `providerReportedCostNanoUsd` (round-half-up at nano precision) and rating uses `provider-reported` mode — no price row needed. An async `GET /api/v1/generation?id=…` reconciliation (v0.2) can true-up the finalized `total_cost`.

### 6.6 Model resolution (aliases, snapshots, deployments)

Exact-string price lookup fails in production: OpenAI responses return dated snapshots (`gpt-5.2-2026-03-14` for a `gpt-5.2` request), Gemini prefixes (`models/gemini-2.5-flash`), Azure returns deployment names, Bedrock uses regionalized ARN-style IDs. Every serious tool ships a resolution layer (LiteLLM `base_model`, genai-prices regex match clauses, Langfuse match patterns). `PricingService.resolveRate` resolves the model ID through this chain, stopping at the first hit:

1. **Exact** match against price rows.
2. **Caller override:** `MeteringContext.baseModel` (mandatory guidance for Azure deployments and Bedrock).
3. **Configured alias map:** `pricing.modelAliases`.
4. **Normalized ID:** strip a `models/` prefix, strip a trailing date suffix (`-YYYY-MM-DD` or `-YYYYMMDD`), strip a Bedrock region/vendor prefix (`us.`, `eu.`, …), lowercase.
5. **Longest-`startsWith`** match against known price rows for the same provider+operation.
6. Strict-mode error `AI_TOKENS_PRICE_NOT_FOUND` (or `priceMissing` record).

`UsageRecord` stores both `requestedModel` (what the host asked for, when supplied) and `model` (what the response reported) — pricing follows the response model; the pair makes drift auditable.

---

## 7. Cost Engine and Markup / Margin

### 7.1 Money is an integer — nano-USD

All monetary values are integer **nano-USD** (`1e-9 USD`) stored as `bigint`. Per-token costs sit at micro-cent levels (~$0.000002/token = 2,000 nano-USD/token), and floating-point errors compound across millions of tiny entries. Rates are stored as nano-USD **per 1,000,000 tokens** so every computation is exact integer math:

```typescript
// compute-cost.ts (pure, in ./shared)
export function computeCostNanoUsd(u: NormalizedUsage, r: PriceVersion): bigint {
  const perMillion = (tokens: number, rate: bigint): bigint =>
    (BigInt(tokens) * rate) / 1_000_000n

  // Long-context tier: all-or-nothing when total input crosses the threshold (§6.2).
  const totalInput =
    u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens
  const overTier = r.tierThresholdTokens != null && totalInput > r.tierThresholdTokens
  const inputRate = overTier ? (r.tierInputNanoUsdPerMillion ?? r.inputNanoUsdPerMillion) : r.inputNanoUsdPerMillion
  const outputRate = overTier ? (r.tierOutputNanoUsdPerMillion ?? r.outputNanoUsdPerMillion) : r.outputNanoUsdPerMillion

  const tokenCost =
    perMillion(u.inputTokens, inputRate) +
    perMillion(u.outputTokens, outputRate) +
    perMillion(u.cacheReadTokens, r.cacheReadNanoUsdPerMillion) +
    perMillion(u.cacheWrite5mTokens, r.cacheWrite5mNanoUsdPerMillion) +
    perMillion(u.cacheWrite1hTokens, r.cacheWrite1hNanoUsdPerMillion) +
    perMillion(u.reasoningTokens, r.reasoningNanoUsdPerMillion) +
    perMillion(u.audioInTokens, r.audioInNanoUsdPerMillion) +
    perMillion(u.audioOutTokens, r.audioOutNanoUsdPerMillion) +
    perMillion(u.imageInTokens, r.imageInNanoUsdPerMillion) +
    perMillion(u.imageOutTokens, r.imageOutNanoUsdPerMillion)

  // Non-token line items (web search calls, images, video seconds, …).
  let surcharge = 0n
  for (const [unit, count] of Object.entries({ ...u.serverToolUse })) {
    const rate = r.unitRates?.[unit]
    if (rate != null) surcharge += BigInt(count) * rate
  }
  return tokenCost + surcharge
}
```

The token part and the surcharge part are also exposed separately (`UsageRecord.surchargeNanoUsd`) so reports can distinguish token spend from tool spend. Rounding to cents happens only at presentation time. Example: Claude Opus input $5/1M → `inputNanoUsdPerMillion = 5_000_000_000n`; 1,000 input tokens → `5_000_000n` nano-USD = $0.005.

### 7.2 Markup / margin — the SaaS profit lever

This is the feature pure cost-calculators lack and the explicit reason this library exists for reselling SaaS. Two interchangeable mechanisms, both letting provider costs float without repricing customers:

1. **Multiplier** — `billedCost = applyMarkup(rawCost, multiplier)`. `markup: 4.0` bills end-users at 4× provider cost. A policy varies it per model/feature/tenant tier:

```typescript
export interface IMarkupPolicy {
  /** Return the multiplier for this call. Resolved once per record; the resolved value is persisted. */
  resolve(ctx: {
    scope: MeteringScope
    provider: ProviderId
    model: string
    operation: AiOperation
    serviceTier: ServiceTier
    feature?: string
  }): number | Promise<number>
}

/**
 * Pure. The multiplier is validated (finite, > 0) and rounded to 4 decimal places
 * (matching the persisted Decimal(10,4)); the math is exact bigint with truncation
 * toward zero on the final division:
 *   billed = (raw * BigInt(Math.round(m * 10_000))) / 10_000n
 */
export function applyMarkup(rawCostNanoUsd: bigint, multiplier: number): bigint
```

2. **Credit exchange rate** — with wallets enabled, `creditRateNanoUsd` sets how many nano-USD one credit is worth. Selling credits at $5 each while the underlying cost is lower is the margin — the natural lever for prepaid plans.

`billedCostNanoUsd` (post-markup) and `rawCostNanoUsd` (provider cost) are **both** stored on every ledger record, so a tenant's margin is a single subtraction — the per-customer cost/margin analysis that otherwise requires a commercial platform. Markup applies in both rating modes (§2.3).

### 7.3 Free tier, overage, and plan mapping

The library owns the **usage/consumption** half of pricing and composes with a seat/subscription layer (e.g. Stripe subscriptions) rather than reinventing it. The recommended pattern — a generous credit allowance per plan tier plus per-unit overage — is expressed as: a periodic `grant` to the wallet (the allowance) + `markup` on metered usage (the overage rate). Pool credits at the **tenant/org** level to avoid stranded per-seat allotments.

### 7.4 Currency rule (normative)

**Every persisted money column in every table is nano-USD.** The `currency` option and the `fx` resolver affect **presentation only**: `UsageReportService` summaries/exports and `getStatus()` convert nano-USD → the presentation currency at read time using `fx(date, currency)`. Budget limits, wallet balances, grants, and ledger records are always denominated, compared, and summed in nano-USD. The per-record `currency` column is fixed to `'USD'` in v0.1 and exists for forward compatibility (a future multi-currency ledger would stamp records with their denomination). This single rule removes every FX ambiguity from the enforcement path; `formatNanoUsd(nanoUsd, { currency?, fxRate? })` is the exported presentation helper.

---

## 8. Immutable Usage Ledger

### 8.1 Append-only, derived balance

The ledger is the source of truth. It is **append-only**: usage and corrections are immutable entries; a balance is the sum of entries; a mistake is fixed by appending a **compensating** entry, never by `UPDATE`/`DELETE`. This is the TigerBeetle / Square Books / Modern Treasury model, and it is what makes the ledger auditable — every state, including mistakes, is preserved. A customer's prepaid credit balance is modeled as a **liability** (you owe them service), so double-entry semantics keep balances provable.

### 8.2 `UsageRecord`

```typescript
export type UsageStatus = 'pending' | 'posted' | 'reversed' | 'released'

export interface UsageRecord {
  id: string
  tenantId: string
  /** The PAYER — the subject whose wallet/budget is consumed. */
  scope: MeteringScope
  /** Optional distinct beneficiary (e.g. the client a trainer generated for). Reporting dimension only. */
  beneficiary?: MeteringScope
  /** Optional actor who triggered the call (audit). */
  requestedBy?: string
  provider: ProviderId
  /** Model reported by the response (pricing follows this). */
  model: string
  /** Model the host requested, when supplied (drift audit; §6.6). */
  requestedModel?: string
  operation: AiOperation
  serviceTier: ServiceTier
  /** Caller-supplied logical operation, e.g. 'workout.generate', 'chat.reply'. */
  feature: string
  /** Free-form cost-attribution labels (≤ 10), e.g. ['team:research', 'exp:B']. */
  tags: string[]
  // Token counts — typed columns, never JSON:
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  reasoningTokens: number
  audioInTokens: number
  audioOutTokens: number
  imageInTokens: number
  imageOutTokens: number
  totalTokens: number
  /** Non-token line items actually rated, e.g. { web_search_request: 2 }. */
  extraUnits?: Record<string, number>
  // Cost — typed, indexed, integer nano-USD:
  priceVersionId: string | null      // null for provider-reported mode or priceMissing
  rawCostNanoUsd: bigint              // provider cost (tokens + surcharges)
  surchargeNanoUsd: bigint            // the non-token share of rawCost
  billedCostNanoUsd: bigint           // after markup — what the customer pays
  markupMultiplier: number            // the resolved 4-dp value actually applied
  currency: string                    // 'USD' in v0.1 (§7.4)
  priceMissing: boolean               // rated at 0 in non-strict mode; backfill target
  // Lifecycle & correctness:
  status: UsageStatus
  /** Set on a posted record when a compensating record reversed it — the ONE permitted post-posting mutation (§8.5). */
  reversedByRecordId?: string
  /** Set on a compensating record, pointing back at the record it negates. */
  reversesRecordId?: string
  idempotencyKey: string              // unique per (tenantId, idempotencyKey)
  correlationId?: string              // ties an invoice line back to app logs
  requestId?: string                  // provider request id
  isSystemCost: boolean               // platform-absorbed — never consumes wallet/budget
  systemCostCategory?: string         // e.g. 'workout_generation_retry', 'guideline_setup'
  /** True when this record consumed wallet/budget (hold/meter path or record({enforce:true})). Reconciliation predicate (§10.7). */
  enforced: boolean
  // Tamper-evidence (optional per-tenant hash chain, §8.6):
  prevHash?: string
  hash?: string
  occurredAt: Date                    // when the LLM call happened
  createdAt: Date
  updatedAt: Date                     // pending-row settlements only
}
```

### 8.3 Lifecycle state machine (pending → posted / released)

- **`pending`** — a hold (§2.2). Mutable, excluded from the hash chain, carries the estimate. Expires after `holds.ttlSeconds`.
- **`posted`** — settled with actual amounts. Immutable, except the single permitted annotation in §8.5.
- **`released`** — a voided hold (released explicitly or swept by the reaper). Never billed; wallet/budget fully restored.
- **`reversed`** — a posted record that has been compensated. Its amounts are unchanged; the negation lives in the compensating record.

**Balance/spend math always sums records with `status IN ('posted', 'reversed')`** — compensating records are themselves `posted` with negated amounts, so sums stay correct without special-casing.

**The hold reaper** (a periodic sweep inside the module, `holds.reaperIntervalSeconds`) finds `pending` records older than `holds.ttlSeconds` and performs the same restoration as `release()`. It is a v0.1 deliverable (Phase 4): a hold moves real wallet/budget headroom, so a crash between `hold()` and `capture()` must not strand it. Multi-replica safety: the sweep uses the store's atomic transition (only one replica wins each expired hold).

### 8.4 Exactly-once via idempotency keys

The idempotency key should be **derived from request content** (`deriveIdempotencyKey(payload)` — sha256-based, exported from `./shared`) so a retry after a 429/network failure reuses the same key. **The host owns the request payload and therefore supplies the key** in `MeteringContext.idempotencyKey`; the library cannot derive it (it never sees the request). When omitted, the library generates a random UUID — the record is still written exactly once, but *retries are not deduplicated*; the spec therefore treats the key as strongly recommended and every example includes it.

`LedgerService.append()` upserts on `unique(tenantId, idempotencyKey)`: a replay with the same key **and the same payload hash** returns the existing record; the same key with a *different* payload hash throws `AI_TOKENS_IDEMPOTENCY_CONFLICT`. The payload hash (an internal column) is computed over the canonical normalized-usage + context fields.

### 8.5 Compensation (reversal) semantics

`MeteringService.reverse(usageRecordId, reason)` is the public orchestrator; in **one store transaction** it:

1. Appends a **compensating record**: `status: 'posted'`, negated token counts and costs, `reversesRecordId` → the original, its own idempotency key (`reverse:<originalId>`).
2. Annotates the original: `status: 'posted' → 'reversed'` + `reversedByRecordId` — **the only permitted post-posting mutation**, an annotation that never alters amounts (`ILedgerStore.transition()` enforces this).
3. If the original was `enforced`: refunds the linked wallet debit (a `refund` entry) and releases the budget-window consumption — cost, tokens, **and count** — plus the live counter.

`LedgerService.reverse()` is the ledger-only primitive (steps 1–2) for hosts that manage wallet/budget effects themselves. Reversing an already-reversed record throws `AI_TOKENS_IDEMPOTENCY_CONFLICT`; reversing a `pending`/`released` record is invalid (use `release()`).

This is `bymax-fitness`'s refund-on-failure made first-class: a refunded user immediately regains quota headroom, including the operation-count headroom.

### 8.6 Tamper-evident hash chain (opt-in)

With `ledger.hashChain: true`, each record's `hash = sha256(prevHash + canonical(record))` forms a per-tenant chain. Precisely specified to avoid the classic races:

- Hashes are computed **only at settlement** (`posted` — including compensating records). `pending`/`released` rows are outside the chain, so settling a hold never invalidates a hash.
- Appends to a tenant's chain are **serialized per tenant** (Postgres advisory lock in the official adapter). This caps per-tenant posted-write throughput — acknowledged in §20.2; leave the feature off unless SOC 2-style tamper evidence is required.
- Idempotent replays return the existing record and never re-hash.
- `LedgerService.verifyChain(tenantId, from?, to?)` recomputes and reports the first break, plus an audit event.

---

## 9. Wallets and Prepaid Credits

Enabled via `wallets: {}`. Supports both **prepaid** (debit in real time) and **postpaid** (overdraft, invoice at period close) over the same entry ledger — prepaid is postpaid plus a real-time balance guard.

### 9.1 Types

```typescript
export interface WalletRef { tenantId: string; ownerType: 'tenant' | 'team' | 'user'; ownerId: string }
// 'key' scopes deliberately cannot own money — API keys spend their owner's wallet.

export interface Wallet {
  id: string
  tenantId: string
  ownerType: WalletRef['ownerType']
  ownerId: string
  /** Materialized, kept transactionally consistent with Σ entries; reconciled on demand. */
  balanceNanoUsd: bigint
  createdAt: Date
  updatedAt: Date
}

export type WalletEntryType = 'grant' | 'debit' | 'refund' | 'adjustment' | 'expiry'

export interface WalletEntry {
  id: string
  walletId: string
  type: WalletEntryType
  amountNanoUsd: bigint               // + = credit, − = debit
  priority: number                     // grant burn priority (lower first)
  effectiveAt: Date
  expiresAt?: Date                     // grants only
  usageRecordId?: string               // present on usage-driven debits/refunds
  idempotencyKey: string               // unique per wallet
  reason?: string
  createdAt: Date
}
```

Wallets are **auto-created on first `grant()`** (or first `adjust()` with a positive amount); debiting a nonexistent wallet throws `AI_TOKENS_INSUFFICIENT_CREDITS`.

### 9.2 `WalletService`

```typescript
@Injectable()
export class WalletService {
  /** Current balance. Excludes expired and not-yet-effective grants. */
  getBalance(ref: WalletRef): Promise<{ nanoUsd: bigint; credits: number }>

  /** Grant credits (allowance, purchase, promo). Appends a 'grant' entry. */
  grant(ref: WalletRef, input: {
    amountNanoUsd: bigint
    priority?: number
    effectiveAt?: Date
    expiresAt?: Date
    idempotencyKey: string
    reason: string
  }): Promise<WalletEntry>

  /**
   * Atomic conditional debit (§9.4). `usageRecordId` links usage-driven debits;
   * non-usage debits (e.g. voucher reservation at mint) omit it and MUST carry a reason.
   * @throws AI_TOKENS_INSUFFICIENT_CREDITS
   */
  debit(ref: WalletRef, input: {
    amountNanoUsd: bigint
    usageRecordId?: string
    idempotencyKey: string
    reason?: string
  }): Promise<WalletEntry>

  /** Refund a previous debit (appends a 'refund' entry). */
  refund(ref: WalletRef, input: {
    amountNanoUsd: bigint
    usageRecordId?: string
    idempotencyKey: string
    reason: string
  }): Promise<WalletEntry>

  /** Signed manual correction (admin plane — see §14.4). Positive or negative. */
  adjust(ref: WalletRef, input: {
    amountNanoUsd: bigint
    idempotencyKey: string
    reason: string
  }): Promise<WalletEntry>

  /** Paginated entry history — the tenant-token transaction listing of bymax-fitness. */
  getEntries(ref: WalletRef, filter?: {
    from?: Date; to?: Date; type?: WalletEntryType
    limit?: number; offset?: number
  }): Promise<{ entries: WalletEntry[]; total: number }>
}
```

### 9.3 Grant burn-down

Multiple grants (a monthly allowance, a top-up, a promo) are burned in `burnOrder`: `'expiry'` (soonest-expiring first — the OpenMeter/Orb credit-block model), `'priority'`, or `'fifo'`. Each debit's draw is persisted in a **debit-allocation table** (`AiWalletDebitAllocation`, §15.3) mapping debit entries to the grant entries they consumed — making expiry, refunds, and rollover fully auditable (a grant's remaining value = its amount − Σ allocations).

**Grant lifecycle rules:** `getBalance()` and burn-down ignore grants with `effectiveAt` in the future or `expiresAt` in the past. `expiry` entries (negating a grant's unspent remainder) are written lazily — at the next debit that observes the expired grant, or by the hold reaper's sweep. **Recurring allowances are host-triggered** (a renewal event calls `grant()`); for rollover policies the host computes the new grant using the documented formula `newBalance = MIN(maxRollover, MAX(balanceBeforeReset, minRollover))` — the library provides the balance, the host provides the policy.

### 9.4 Race-safe debit

The wallet keeps a **materialized `balanceNanoUsd`** column, updated in the same transaction as every entry insert and verifiable against Σ entries (a `reconcile(ref)` admin method recomputes it). The atomic debit is a conditional update against that column:

```sql
UPDATE ai_wallets SET balance_nano_usd = balance_nano_usd - :cost, updated_at = now()
WHERE id = :id AND balance_nano_usd - :cost >= -:overdraft
```

— it succeeds only if it affects a row (no read-check-write gap), then the entry + allocations are inserted in the same transaction. This is why §8.1's "derived balance" and a materialized column are not in conflict: the entries remain the source of truth; the column is a transactionally-maintained materialization that makes the conditional decrement possible.

### 9.5 Overdraft (postpaid)

`overdraftNanoUsd > 0n` allows the balance to go negative up to the limit — the postpaid/overage case. Usage still writes to the ledger; the negative balance becomes the invoice at period close.

---

## 10. Budgets, Quotas and Enforcement

Enabled via `budgets: {}`.

### 10.1 `Budget`

```typescript
export type BudgetWindowKind = 'day' | 'week' | 'month' | 'total' | { customSeconds: number }
export type BudgetPolicy = 'block' | 'throttle' | 'allow'

export interface Budget {
  id: string
  tenantId: string
  scope: MeteringScope
  /**
   * Restrict which usage counts against this budget. Empty/absent = all features.
   * This is what lets embeddings bypass a user's generation quota while decision-assist
   * consumes it (the bymax-fitness selective-metering requirement).
   */
  features?: string[]
  /** Caps — any combination; each dimension is enforced independently. */
  limitNanoUsd?: bigint      // billed spend
  limitTokens?: number        // total tokens
  limitCount?: number         // number of operations (posted, enforced, non-reversed records)
  window: BudgetWindowKind
  /**
   * Per-budget window anchor. For 'month'/'week'/'day': windows start at this instant
   * and repeat (month windows handle short months by clamping to the last day —
   * a Jan 31 anchor yields Feb 28/29, Mar 31, …). Absent → calendar UTC anchoring
   * (day = midnight UTC, week = Sunday 00:00 UTC, month = 1st 00:00 UTC).
   * This is how subscription-renewal-anchored quotas are expressed.
   */
  anchorAt?: Date
  /** For window 'total': the window never rotates; windowStart = anchorAt ?? createdAt. */
  /** Optional budget lifetime (trials): enforcement ignores the budget after this instant. */
  expiresAt?: Date
  /** Fractions of the limit that trigger soft alert events. Default from module options. */
  softThresholds: number[]
  policy: BudgetPolicy
  createdAt: Date
}
```

### 10.2 Unlimited semantics (normative)

- **Unlimited = no budget row, or a budget row whose relevant limit field is absent/null.**
- **A present limit of `0` is a valid hard block** (always exceeded) — e.g. "AI disabled for this tier".
- Negative limits are rejected at validation (`AI_TOKENS_INVALID_CONFIG`).

> Migration warning (§22): `bymax-fitness` treats `0` as *unlimited* on most paths and as *blocked* on one — importing plan rows verbatim would invert entitlements. Fitness `0`/`null` limits must be translated to **no budget row**.

### 10.3 Scopes, windows, and multi-level enforcement

Budgets exist at `tenant` / `team` / `user` / `key` scopes. **Every matching budget across the hierarchy is checked, and each consumes independently** — a user-level budget does not exempt spend from the tenant-level cap. ("Most-specific wins" applies to nothing; it is a documented anti-pattern that silently bypasses org-wide caps.) Multiple concurrent windows on one subject are supported (e.g. $10/day **and** $100/month). Reset boundaries are computed in UTC from `anchorAt` (or calendar UTC when absent), with month-end clamping.

### 10.4 Soft vs hard enforcement

- **Soft thresholds** (default 80% and 100%) emit `ai_tokens.budget.threshold_crossed` events (§12) but never block.
- **`policy: 'block'`** throws `AI_TOKENS_BUDGET_EXCEEDED` (**HTTP 402** for spend caps) or `AI_TOKENS_QUOTA_EXCEEDED` (**429** for token/count quotas).
- **`policy: 'throttle'`** invokes `budgets.onThrottle` (host downgrades the model, disables features, queues the request); if no callback is configured, behaves as `'allow'` with a warning log.
- **`policy: 'allow'`** is alert-only (the OpenAI-style notification budget). A **projected-spend** event (`ai_tokens.budget.projected_exceeded`) fires when the current burn rate projects crossing the limit before the window resets.

### 10.5 `BudgetService`

```typescript
@Injectable()
export class BudgetService {
  /** Create or replace a budget (admin plane — §14.4). */
  upsertBudget(input: Omit<Budget, 'id' | 'createdAt'> & { id?: string }): Promise<Budget>
  removeBudget(budgetId: string): Promise<void>
  list(tenantId: string, scope?: MeteringScope): Promise<Budget[]>

  /** The user-facing "how much is left" query — §10.6. */
  status(tenantId: string, scope: MeteringScope): Promise<BudgetStatus[]>

  /**
   * Force a fresh window NOW (or at a given start) — called by the host on subscription
   * renewal or plan change. Also updates anchorAt so subsequent windows follow the new cycle.
   */
  rotateWindow(budgetId: string, newWindowStart?: Date): Promise<void>

  /** Recompute a window's spent counters from the ledger using the §10.7 predicate. */
  reconcileWindow(budgetId: string, windowStart: Date): Promise<void>
}
```

### 10.6 Status API (`BudgetStatus` / `AccessStatus`)

The query every consuming frontend needs to render a usage meter — the `aiTokensRemaining` / `aiGenerationsRemaining` DTOs of `bymax-fitness`, generalized (OpenMeter-entitlement semantics):

```typescript
export interface BudgetStatus {
  budgetId: string
  features?: string[]
  window: BudgetWindowKind
  windowStart: Date
  resetsAt: Date | null                 // null for 'total'
  policy: BudgetPolicy
  limit:     { nanoUsd?: bigint; tokens?: number; count?: number }
  spent:     { nanoUsd: bigint; tokens: number; count: number }
  remaining: { nanoUsd?: bigint; tokens?: number; count?: number }   // absent dimension = unlimited
  usedFraction: number                   // max across limited dimensions
}

export interface AccessStatus {
  hasAccess: boolean
  blockedBy?: 'wallet' | 'budget'
  wallet?: { balanceNanoUsd: bigint; credits: number; overdraftRemainingNanoUsd: bigint }
  budgets: BudgetStatus[]
}

// MeteringService.getStatus(tenantId, scope): Promise<AccessStatus>   (§11.1)
```

The recommended host pattern is a thin controller (`GET /me/ai-usage`) returning `getStatus()` — with `bigint` fields serialized as strings (§15.5).

### 10.7 Which records consume budgets (normative predicate)

A usage record consumes a budget window iff **all** of:

1. It was written through the enforcement path — `hold()`/`meter()`, or `record()` with `enforce: true` (persisted as `UsageRecord.enforced = true`);
2. `isSystemCost` is false — system costs never consume wallets or budgets;
3. The record's `feature` matches the budget's `features` filter (or the filter is empty);
4. Its status is `posted` or `reversed` (reversal releases the consumption — §8.5);
5. `occurredAt` falls inside the window.

`reconcileWindow()` recomputes `spentNanoUsd`/`spentTokens`/`spentCount` from the ledger with **this same predicate** — the materialized window row and the live counter are caches; the ledger remains the reconcilable source of truth. Counter drift after crashes heals on window rotation (counter keys are TTL'd to the window length + grace) or on explicit reconcile.

### 10.8 Race-safe consumption

The "check-then-decrement" race is prevented with an **atomic conditional consume** on the window row:

```sql
UPDATE ai_budget_windows
SET spent_nano_usd = spent_nano_usd + :cost,
    spent_tokens   = spent_tokens   + :tokens,
    spent_count    = spent_count    + :count
WHERE budget_id = :id AND window_start = :ws
  AND (:limitCost  IS NULL OR spent_nano_usd + :cost   <= :limitCost)
  AND (:limitTok   IS NULL OR spent_tokens   + :tokens <= :limitTok)
  AND (:limitCount IS NULL OR spent_count    + :count  <= :limitCount)
```

When a Redis `IBudgetCounterStore` is configured, the live counter is the fast path (`incrIfBelow` per dimension, key `ai_tokens:budget:{budgetId}:{windowStartISO}:{dimension}`, TTL = window length + 1h grace, values stored as int64 strings); `failClosed: true` keeps budgets a hard ceiling even if the counter store degrades (falls back to the DB conditional consume; if the DB is also unavailable, the call fails closed).

---

## 11. Metering API — Services, Guard, Interceptor, Decorators

### 11.1 `MeteringService` (the public facade)

```typescript
export interface MeteringContext {
  tenantId: string
  /** The PAYER — enforcement target. */
  scope: MeteringScope
  /** Optional distinct beneficiary (reporting dimension). */
  beneficiary?: MeteringScope
  /** Optional actor id (audit). */
  requestedBy?: string
  feature: string
  tags?: string[]
  /** Normalization/rating instructions for meter()/interceptor (record() may pass a bare normalizer instead). */
  preset?: ProviderPreset
  ratingMode?: RatingMode
  /** Price-lookup override for deployment-named models (Azure/Bedrock) — §6.6. */
  baseModel?: string
  /** Declared tier when it cannot come from the response (e.g. Batch API result files). */
  serviceTier?: ServiceTier
  /** Non-token line items the provider does not report in usage (OpenAI web search counts, image counts). */
  extraUnits?: Record<string, number>
  /** Strongly recommended; derive with deriveIdempotencyKey(payload). §8.4. */
  idempotencyKey?: string
  correlationId?: string
  /** record() only: also debit wallet + consume budgets post-hoc. Default false. */
  enforce?: boolean
  isSystemCost?: boolean
  systemCostCategory?: string
}

export interface Hold {
  id: string                      // == the pending UsageRecord id
  tenantId: string
  scope: MeteringScope
  estimatedTokens: number
  estimatedCostNanoUsd: bigint    // billed (post-markup) estimate
  expiresAt: Date
}
// Plain serializable object — survives process boundaries; capture()/release()
// revalidate it against the store and the caller's tenant (§14.4).

export type HoldEstimate =
  | { provider: ProviderId; model: string; operation: AiOperation; serviceTier?: ServiceTier
      inputTokens: number; maxOutputTokens: number }
  | { tokens: number }            // rated against the context's preset model
  | { amountNanoUsd: bigint }     // pre-rated (e.g. a domain heuristic like fitness's estimator)

export interface MeterResult<T> { result: T; usage: UsageRecord }

@Injectable()
export class MeteringService {
  /** Post-hoc metering. Observe-only unless ctx.enforce. */
  record(input: {
    usage: unknown                       // raw provider usage OR a NormalizedUsage
    preset?: ProviderPreset
    normalizer?: UsageNormalizer         // alternative to preset
    context: MeteringContext
    occurredAt?: Date                    // default now; backfills pass the original time
  }): Promise<UsageRecord>

  /** hold (estimate) → run fn → capture (actuals); release on error. ctx.preset drives normalization. */
  meter<T>(
    fn: () => Promise<T>,
    context: MeteringContext,
    extract: (result: T) => unknown,     // pull the raw usage out of the provider result
    estimate?: HoldEstimate,             // optional; without it meter() skips the hold (post-hoc + enforce)
  ): Promise<MeterResult<T>>

  /** Explicit auth-hold flow for streaming or multi-call features (compose several holds). */
  hold(context: MeteringContext, estimate: HoldEstimate): Promise<Hold>
  /**
   * Settle with actuals. IDEMPOTENT: capturing an already-captured hold returns the
   * posted record unchanged. capture() after release() throws AI_TOKENS_HOLD_ALREADY_SETTLED.
   */
  capture(hold: Hold, usage: unknown | StreamUsageCollector): Promise<UsageRecord>
  /** Void the hold and restore wallet/budget in full. No-op (warn) if already captured. Never bills. */
  release(hold: Hold, reason: string): Promise<void>

  /** Orchestrated compensation: ledger reversal + wallet refund + budget release (§8.5). */
  reverse(usageRecordId: string, reason: string): Promise<UsageRecord>

  /** Pure pre-flight estimate (no side effects). */
  estimateCost(input: {
    provider: ProviderId; model: string; operation: AiOperation; serviceTier?: ServiceTier
    inputTokens: number; maxOutputTokens: number; at?: Date
    scope?: MeteringScope; feature?: string   // lets the markup policy resolve
  }): Promise<{ rawCostNanoUsd: bigint; billedCostNanoUsd: bigint }>

  /** Combined wallet + budget status — §10.6. */
  getStatus(tenantId: string, scope: MeteringScope): Promise<AccessStatus>
}
```

### 11.2 Side-effect matrix (normative)

| API | Ledger | Wallet | Budget window | Live counter | Events |
|---|---|---|---|---|---|
| `record()` (default) | `posted` row (`enforced: false`) | — | — | — | `usage.recorded` |
| `record({ enforce: true })` | `posted` row (`enforced: true`) | debit (post-hoc — **may throw after the LLM call ran**; documented trade-off) | consume | incr | `usage.recorded`, thresholds |
| `hold()` | `pending` row (`enforced: true`) | conditional debit (estimate) | conditional consume | incr | — |
| `capture()` | `pending → posted`, amounts → actuals | adjustment for the ±delta vs the hold | ±delta | ±delta | `usage.recorded`, thresholds |
| `release()` / reaper | `pending → released` | refund of the hold debit | release in full | decr | `hold.released` |
| `reverse()` | compensating `posted` row + original annotated `reversed` | refund of the linked debit | release actuals (cost/tokens/count) | decr | `usage.reversed` |

`isSystemCost: true` rows touch **only** the Ledger and Events columns, regardless of `enforce`. Failure ordering inside `hold()`: counter incr → budget window consume → wallet debit → pending insert, each step compensating all previous steps on failure (the counter is the cheapest to move and to roll back; the wallet debit is last so no money moves unless quota passed).

### 11.3 `BudgetGuard` and `MeteringInterceptor`

- **`BudgetGuard`** (`CanActivate`): resolves the context via `scopeResolver` (§4.1), merges the decorator config, and calls `getStatus()`. If any matching hard budget is exhausted → `AI_TOKENS_BUDGET_EXCEEDED`/`_QUOTA_EXCEEDED` before the handler runs. When `@RequireBudget` supplies an `estimate`, the guard additionally places a **hold** and attaches it to the request; otherwise it is **check-only** (a cheaper but racy gate — the §10.8 atomic consume still protects the actual charge at capture/record time).
- The guard attaches `request.aiTokens = { status: AccessStatus, hold?: Hold, context: MeteringContext }` — the request-enrichment contract `bymax-fitness`'s `AIGenerationGuard` provides today (`tokensRemaining`, `estimatedTokens`).
- **`MeteringInterceptor`**: after the handler resolves, extracts the raw usage from the return value using `@Meter`'s `extract` (default: the `usage` property), normalizes via `@Meter`'s `preset`, and either **captures the guard's hold** (when present on the request) or calls `record({ enforce: true })`. On handler error with a hold present, it releases the hold. With `exposeHeaders: true`, sets `x-ai-tokens-cost`, `x-ai-tokens-billed-cost`, and `x-ai-tokens-budget-remaining` response headers (the LiteLLM `x-litellm-response-cost` pattern).

### 11.4 Decorators

```typescript
@Meter(config: {
  feature: string
  scope?: ScopeType                       // which scope type from the resolved context to charge; default 'user'
  preset?: ProviderPreset
  extract?: (result: unknown) => unknown  // default: result.usage
  exposeHeaders?: boolean
  isSystemCost?: boolean
  tags?: string[]
})

@RequireBudget(config: {
  scope?: ScopeType
  feature?: string                        // budget feature-filter matching; defaults to @Meter's feature
  estimate?: HoldEstimate                 // static estimate → the guard places a hold
})

@AiFeature(name: string)                  // lightweight tag; @Meter.feature wins when both are present
```

The three ways to meter:

| Path                        | When to use                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `record(input)`             | You already have the usage; observe (or `enforce: true`) after the fact. |
| `meter(fn, ctx, extract, est?)` | Programmatic wrap: enforce before, capture actuals after.       |
| `@RequireBudget` + `@Meter` + guard/interceptor | Declarative, controller-level, minimal boilerplate. |

---

## 12. Events

For a public library, the event contract **is** an API. The catalog, envelope, and delivery semantics are typed and versioned.

### 12.1 Envelope and delivery

```typescript
export interface AiTokensEvent<T = unknown> {
  /** UUID — the consumer's dedupe key (delivery is at-least-once). */
  id: string
  type: AiTokensEventType
  occurredAt: Date
  tenantId: string
  scope?: MeteringScope
  data: T
}
```

Two delivery channels, both optional and composable (§4.1 `events`):

1. **`@nestjs/event-emitter`** (optional peer): when installed and `events.emitter !== false`, every event is emitted via `EventEmitter2` under its `type` string — hosts subscribe with `@OnEvent('ai_tokens.budget.exceeded')`. When the package is absent, this channel is a silent no-op.
2. **`IEventSink`** port: `deliver(event: AiTokensEvent): Promise<void>` — for webhooks, queues (`@bymax-one/nest-queue`), or realtime fan-out (`@bymax-one/nest-realtime`). Sink failures are logged, never thrown into the metering path.

### 12.2 Event catalog

| `type` | Fired when | `data` payload |
|---|---|---|
| `ai_tokens.usage.recorded` | A record posts (record/capture) | `{ usageRecordId, feature, provider, model, serviceTier, totalTokens, rawCostNanoUsd, billedCostNanoUsd, enforced, isSystemCost }` |
| `ai_tokens.usage.reversed` | `reverse()` completes | `{ usageRecordId, reversalRecordId, reason }` |
| `ai_tokens.hold.released` | Explicit release or reaper sweep | `{ holdId, reason, expired: boolean }` |
| `ai_tokens.budget.threshold_crossed` | Window spend crosses a soft threshold | `{ budgetId, threshold, usedFraction, limit, spent, remaining, resetsAt }` (LiteLLM-superset fields) |
| `ai_tokens.budget.exceeded` | A hard budget blocks a call | `{ budgetId, policy, dimension: 'cost' \| 'tokens' \| 'count', limit, spent, resetsAt }` |
| `ai_tokens.budget.projected_exceeded` | Burn rate projects crossing before reset | `{ budgetId, projectedAt, usedFraction, resetsAt }` |
| `ai_tokens.wallet.low_balance` | Balance falls below a grant-relative threshold | `{ walletId, balanceNanoUsd, thresholdFraction }` |
| `ai_tokens.wallet.depleted` | A debit exhausts the balance (or hits overdraft cap) | `{ walletId, balanceNanoUsd }` |
| `ai_tokens.wallet.granted` | `grant()` posts | `{ walletId, entryId, amountNanoUsd, expiresAt }` |
| `ai_tokens.price.missing` | Non-strict rating found no rate | `{ provider, model, operation, serviceTier, usageRecordId }` |
| `ai_tokens.audit` | Admin-plane mutation (price/markup/budget/adjust/export — §14.4) | `{ action, actor?, details }` |

Numeric `bigint` payload fields are emitted as-is in-process (EventEmitter2) and serialized as decimal strings by the JSON boundary rule (§15.5) when a sink ships them out of process.

---

## 13. Reporting, Aggregation and Export

### 13.1 `UsageReportService`

```typescript
export interface ReportFilter {
  tenantId: string
  scope?: MeteringScope
  beneficiary?: MeteringScope
  feature?: string
  features?: string[]
  provider?: ProviderId
  model?: string
  operation?: AiOperation
  serviceTier?: ServiceTier
  tags?: string[]                      // records carrying ANY of these tags
  isSystemCost?: boolean
  systemCostCategory?: string
  enforcedOnly?: boolean
  status?: UsageStatus[]               // default ['posted', 'reversed']
  from: Date
  to: Date
}

export interface UsageSummary {
  /** groupBy key → value, e.g. { day: '2026-07-01', model: 'gpt-5.4' }. Empty groupBy = one grand-total row. */
  group: Record<string, string>
  records: number
  totalTokens: number
  tokens: Record<TokenCategory, number>
  rawCostNanoUsd: bigint
  surchargeNanoUsd: bigint
  billedCostNanoUsd: bigint
  /** Σ cacheReadTokens × (inputRate − cacheReadRate) — the "you saved $X via caching" number. */
  cacheSavingsNanoUsd: bigint
}

@Injectable()
export class UsageReportService {
  /** Real SQL aggregation over typed columns (SUM … GROUP BY) — scales where bymax-fitness's JSON-in-memory filtering could not. */
  summarize(filter: ReportFilter & {
    groupBy: Array<'day' | 'week' | 'month' | 'feature' | 'provider' | 'model'
                  | 'operation' | 'serviceTier' | 'scope' | 'beneficiary'
                  | 'tag' | 'systemCostCategory'>
  }): Promise<UsageSummary[]>

  /** Stream a CSV/JSON export with the §13.2 field set. `Readable` from node:stream. */
  export(filter: ReportFilter, format: 'csv' | 'json'): Promise<Readable>
}
```

When `currency !== 'USD'`, summaries and exports additionally carry the converted presentation amounts using `fx` (§7.4). Every export is recorded as an `ai_tokens.audit` event (§14.4).

### 13.2 Export field set

Each export row carries: tenant/scope/beneficiary ids, `requestedBy`, feature, tags, provider, model, `requestedModel`, operation, serviceTier, the ten token-category counts, totalTokens, `extraUnits`, `rawCostNanoUsd`, `surchargeNanoUsd`, `billedCostNanoUsd`, markup, currency, `priceMissing`, `occurredAt`, `idempotencyKey`, `correlationId`, `requestId`, `isSystemCost`, `systemCostCategory`, `enforced`, and `status` — the field set an invoice pipeline needs to trace a line back to app logs.

### 13.3 Dashboards

The library provides the query surface (`summarize`, `getStatus`); it does not ship a UI. A reference dashboard belongs to `nest-ai-tokens-example` (the sibling reference app, per the family's `<lib>-example` convention).

---

## 14. Observability, Security and Compliance

### 14.1 OpenTelemetry GenAI conventions

With `telemetry: {}`, the library emits spans and metrics on the standard `gen_ai.*` namespace so it interoperates with Datadog/Grafana/Honeycomb with zero mapping: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.token.type`, plus the `gen_ai.client.token.usage` histogram and `gen_ai.client.operation.duration`. Content is **not** captured.

```typescript
export interface ITelemetrySink {
  recordUsage(attributes: Record<string, string | number>, record: UsageRecord): void
  recordDuration?(attributes: Record<string, string | number>, milliseconds: number): void
}
```

The sink is pluggable; without one, telemetry is a no-op.

### 14.2 PII discipline — no prompt text in the ledger

The immutable ledger stores **token counts, model, cost, and IDs only — never prompt or completion text** (the OTel GenAI convention itself captures no content by default). If a host needs text for debugging, it opts into a **separate, redacted, short-TTL** content sidecar:

```typescript
export interface IContentStore {
  put(input: { usageRecordId: string; tenantId: string; role: 'prompt' | 'completion'
               text: string; ttlSeconds: number }): Promise<void>
  purge(filter: { tenantId: string; usageRecordId?: string; subjectId?: string }): Promise<number>
}
```

`content.mask` runs before persistence; `purge()` supports erasure requests independently of the ledger.

### 14.3 GDPR / LGPD

An immutable ledger structurally conflicts with the right to erasure and data minimization — resolved by keeping PII **out** of the ledger:

- The ledger holds counts/cost/IDs (minimization); a legal-basis carve-out (billing/tax/audit retention) legitimately lets the token-count record survive an erasure request.
- Prompt/response text lives only in the opt-in `IContentStore` and is deleted on erasure (or crypto-shredded — per-subject keys revoked, v0.2 helper).
- LGPD's extraterritoriality and legal-obligation retention exception map onto the same design.

### 14.4 Security considerations (threat model)

- **Authorization is the host's responsibility — stated explicitly.** The library performs no authn/authz; any code path that can inject `WalletService` can mint credits. Hosts MUST restrict the **admin plane** — `WalletService.grant/adjust`, `PricingService.upsertPrice`, `BudgetService.upsertBudget/removeBudget/rotateWindow`, `MeteringService.reverse`, `UsageReportService.export` — to privileged roles. The **data plane** (`record`, `meter`, `hold/capture/release`, `getStatus`, `getBalance`) is safe for request-scoped use with a correctly resolved scope.
- **Cross-tenant validation:** `capture()`/`release()` revalidate the `Hold` against the store and reject a hold whose `tenantId`/scope does not match the caller's context (`AI_TOKENS_HOLD_NOT_FOUND` — deliberately indistinguishable from a nonexistent hold).
- **Idempotency-key forgery:** keys are unique per tenant; a key can only replay a record within its own tenant, and a payload mismatch throws (§8.4).
- **Every admin-plane mutation emits `ai_tokens.audit`** (price/markup changes, grants/adjustments, budget changes, reversals, exports) with actor propagation via `requestedBy`.
- **Tamper evidence:** the opt-in hash chain (§8.6) + `verifyChain()` make post-hoc modification detectable — the SOC 2 expectation for billing records.
- **Scope resolution is trusted input:** `scopeResolver` runs on every guarded request; it must read from the host's *verified* auth context (JWT claims, session), never from client-supplied body/query fields.

### 14.5 SOC 2 audit trail

The append-only ledger with per-record actor/timestamp, the audit event stream, and the optional per-tenant hash chain make modification/deletion **detectable**. Recommended retention: ≥ 12 months of ledger history hot, with prior periods locked (no reversals into closed periods — host policy).

---

## 15. Data Model and Persistence Ports

### 15.1 Store ports

```typescript
export interface LedgerFilter {
  tenantId: string
  scope?: MeteringScope
  beneficiary?: MeteringScope
  feature?: string; features?: string[]
  provider?: ProviderId; model?: string; operation?: AiOperation; serviceTier?: ServiceTier
  tags?: string[]
  isSystemCost?: boolean; systemCostCategory?: string
  status?: UsageStatus[]
  enforcedOnly?: boolean
  from?: Date; to?: Date
  limit?: number; offset?: number
}

/** Caller-supplied fields; the store computes id/hash/createdAt/updatedAt. */
export type NewUsageRecord = Omit<UsageRecord, 'id' | 'prevHash' | 'hash' | 'createdAt' | 'updatedAt'>

export interface ILedgerStore {
  /** Upsert on (tenantId, idempotencyKey) — replay returns the existing record iff the payload hash matches (§8.4). */
  append(record: NewUsageRecord, payloadHash: string): Promise<UsageRecord>
  /**
   * State transitions only (§8.3): pending→posted (settle, amounts patched),
   * pending→released, posted→reversed (annotation only — amount fields rejected).
   * Atomic: returns null when the record was not in the expected source state
   * (that is how exactly one reaper replica wins an expired hold).
   */
  transition(id: string, from: UsageStatus, to: UsageStatus, patch?: Partial<UsageRecord>): Promise<UsageRecord | null>
  findByIdempotencyKey(tenantId: string, key: string): Promise<UsageRecord | null>
  findExpiredHolds(olderThan: Date, limit: number): Promise<UsageRecord[]>
  query(filter: LedgerFilter): Promise<UsageRecord[]>
  sumCost(filter: LedgerFilter): Promise<{ rawCostNanoUsd: bigint; billedCostNanoUsd: bigint
    surchargeNanoUsd: bigint; totalTokens: number; records: number }>
  lastHash(tenantId: string): Promise<string | null>
}

export type NewPriceVersion =
  Partial<Omit<PriceVersion, 'id' | 'effectiveTo'>> &
  Pick<PriceVersion, 'provider' | 'model' | 'operation'>   // rates default to 0n; serviceTier to 'standard'

export interface IPricingStore {
  resolveRate(provider: ProviderId, model: string, operation: AiOperation,
              serviceTier: ServiceTier, at: Date): Promise<PriceVersion | null>
  upsertPrice(input: NewPriceVersion): Promise<PriceVersion>   // closes the open row, inserts the new one
  getPriceHistory(provider: ProviderId, model: string, operation: AiOperation,
                  serviceTier?: ServiceTier): Promise<PriceVersion[]>
  /** All distinct (model, operation, serviceTier) for a provider — powers §6.6 prefix matching. */
  listModels(provider: ProviderId): Promise<Array<{ model: string; operation: AiOperation; serviceTier: ServiceTier }>>
}

export type NewWalletEntry = Omit<WalletEntry, 'id' | 'createdAt'>

export interface IWalletStore {
  getWallet(ref: WalletRef): Promise<Wallet | null>
  /** Creates the wallet when missing (idempotent) and appends the entry + allocations in one transaction. */
  appendEntry(ref: WalletRef, entry: NewWalletEntry,
              allocations?: Array<{ grantEntryId: string; amountNanoUsd: bigint }>): Promise<WalletEntry>
  /** Atomic conditional debit against the materialized balance (§9.4). Null = insufficient. */
  conditionalDebit(ref: WalletRef, entry: NewWalletEntry, overdraftNanoUsd: bigint): Promise<WalletEntry | null>
  /** Open grants with remaining value, ordered per burnOrder — feeds allocation. */
  openGrants(ref: WalletRef, order: 'expiry' | 'priority' | 'fifo'): Promise<Array<WalletEntry & { remainingNanoUsd: bigint }>>
  listEntries(ref: WalletRef, filter?: { from?: Date; to?: Date; type?: WalletEntryType
    limit?: number; offset?: number }): Promise<{ entries: WalletEntry[]; total: number }>
  /** Recompute the materialized balance from Σ entries. */
  reconcile(ref: WalletRef): Promise<Wallet>
}

export interface IBudgetStore {
  upsert(budget: Omit<Budget, 'id' | 'createdAt'> & { id?: string }): Promise<Budget>
  remove(budgetId: string): Promise<void>
  /** Every budget matching the scope AND all ancestor scopes (§10.3) for the tenant. */
  findMatching(tenantId: string, scope: MeteringScope): Promise<Budget[]>
  /** Atomic multi-dimension conditional consume (§10.8). False = a limit would be exceeded. Creates the window row on first touch. */
  conditionalConsume(budgetId: string, windowStart: Date,
    delta: { nanoUsd: bigint; tokens: number; count: number },
    limits: { nanoUsd?: bigint; tokens?: number; count?: number }): Promise<boolean>
  /** Signed release/adjust of a window's counters (capture delta, release, reverse). */
  adjustWindow(budgetId: string, windowStart: Date,
    delta: { nanoUsd: bigint; tokens: number; count: number }): Promise<void>
  getWindow(budgetId: string, windowStart: Date): Promise<{ spentNanoUsd: bigint; spentTokens: number; spentCount: number } | null>
  setWindowStart(budgetId: string, windowStart: Date): Promise<void>   // rotateWindow support
}

/** Optional live cross-replica counter (Redis). Values serialized as int64 decimal strings. */
export interface IBudgetCounterStore {
  incrIfBelow(key: string, amount: bigint, limit: bigint, ttlSeconds: number): Promise<boolean>
  decr(key: string, amount: bigint): Promise<void>
  reset(key: string): Promise<void>
}
```

### 15.2 Store error mapping (official Prisma adapter)

| Store condition | Library behavior |
| --- | --- |
| Unique violation on `(tenantId, idempotencyKey)` (P2002) | Fetch existing; payload hash equal → return it (replay); different → `AI_TOKENS_IDEMPOTENCY_CONFLICT` (409) |
| Unique violation on wallet entry idempotency key | Same replay-or-conflict rule |
| Conditional debit/consume affected 0 rows | `AI_TOKENS_INSUFFICIENT_CREDITS` / `AI_TOKENS_BUDGET_EXCEEDED` / `_QUOTA_EXCEEDED` (never a store error) |
| `transition()` from-state mismatch | Returns null → caller resolves (idempotent capture returns the posted record; reaper skips) |
| Connection/timeout/unknown Prisma errors | `AI_TOKENS_STORE_ERROR` (502) with the driver code in `details` |
| `Prisma.Decimal` ↔ `number` (markupMultiplier) | Converted at the adapter boundary; exact by construction (4-dp rule, §7.2) |

### 15.3 Prisma schema (the seven tables)

Shipped in `./prisma` as a schema fragment plus SQL migrations. **Merge mechanics (normative):** the supported path is Prisma's multi-file schema — copy `schema.prisma.fragment` into the host's `prisma/schema/ai-tokens.prisma` and run `prisma migrate dev`; hosts managing SQL manually apply the shipped `migrations/*.sql` instead. Library upgrades that change the models ship new incremental SQL files and a documented fragment diff per release.

All money is `BigInt` nano-USD; every table carries `tenantId`.

```prisma
model AiUsageRecord {
  id                  String    @id @default(uuid())
  tenantId            String
  scopeType           String    // tenant | team | user | key   (the payer)
  scopeId             String
  beneficiaryType     String?
  beneficiaryId       String?
  requestedBy         String?
  provider            String
  model               String
  requestedModel      String?
  operation           String
  serviceTier         String    @default("standard")
  feature             String
  tags                String[]  @default([])
  inputTokens         Int       @default(0)
  outputTokens        Int       @default(0)
  cacheReadTokens     Int       @default(0)
  cacheWrite5mTokens  Int       @default(0)
  cacheWrite1hTokens  Int       @default(0)
  reasoningTokens     Int       @default(0)
  audioInTokens       Int       @default(0)
  audioOutTokens      Int       @default(0)
  imageInTokens       Int       @default(0)
  imageOutTokens      Int       @default(0)
  totalTokens         Int
  extraUnits          Json?     // Record<string, number>
  priceVersionId      String?   // no FK by design: records outlive price-row lifecycle; see index below
  rawCostNanoUsd      BigInt
  surchargeNanoUsd    BigInt    @default(0)
  billedCostNanoUsd   BigInt
  markupMultiplier    Decimal   @db.Decimal(10, 4)
  currency            String    @default("USD")
  priceMissing        Boolean   @default(false)
  status              String    @default("posted")   // record() fast path; holds insert 'pending'
  reversedByRecordId  String?
  reversesRecordId    String?
  idempotencyKey      String
  payloadHash         String
  correlationId       String?
  requestId           String?
  isSystemCost        Boolean   @default(false)
  systemCostCategory  String?
  enforced            Boolean   @default(false)
  prevHash            String?
  hash                String?
  occurredAt          DateTime
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  @@unique([tenantId, idempotencyKey])
  @@index([tenantId, occurredAt])
  @@index([tenantId, scopeType, scopeId, occurredAt])
  @@index([tenantId, feature, occurredAt])
  @@index([tenantId, provider, model])
  @@index([tenantId, systemCostCategory])
  @@index([tenantId, beneficiaryType, beneficiaryId])
  @@index([priceVersionId])
  @@index([status, createdAt])          // reaper scan; Postgres partial index (WHERE status = 'pending') in the shipped SQL
  @@map("ai_usage_records")
}

model AiModelPrice {
  id                            String    @id @default(uuid())
  provider                      String
  model                         String
  operation                     String
  serviceTier                   String    @default("standard")
  inputNanoUsdPerMillion        BigInt    @default(0)
  outputNanoUsdPerMillion       BigInt    @default(0)
  cacheReadNanoUsdPerMillion    BigInt    @default(0)
  cacheWrite5mNanoUsdPerMillion BigInt    @default(0)
  cacheWrite1hNanoUsdPerMillion BigInt    @default(0)
  reasoningNanoUsdPerMillion    BigInt    @default(0)
  audioInNanoUsdPerMillion      BigInt    @default(0)
  audioOutNanoUsdPerMillion     BigInt    @default(0)
  imageInNanoUsdPerMillion      BigInt    @default(0)
  imageOutNanoUsdPerMillion     BigInt    @default(0)
  tierThresholdTokens           Int?
  tierInputNanoUsdPerMillion    BigInt?
  tierOutputNanoUsdPerMillion   BigInt?
  unitRates                     Json?     // Record<string, string> — nano-USD per unit as decimal strings
  currency                      String    @default("USD")
  effectiveFrom                 DateTime  @default(now())
  effectiveTo                   DateTime?
  source                        String    @default("snapshot")
  @@index([provider, model, operation, serviceTier, effectiveFrom])
  // Shipped SQL adds: CREATE UNIQUE INDEX ... ON ai_model_prices (provider, model, operation, service_tier)
  //                   WHERE effective_to IS NULL;   -- exactly one open row per key (seed/upsert race guard)
  @@map("ai_model_prices")
}

model AiWallet {
  id             String   @id @default(uuid())
  tenantId       String
  ownerType      String   // tenant | team | user
  ownerId        String
  balanceNanoUsd BigInt   @default(0)   // materialized; source of truth = Σ entries (§9.4)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  entries        AiWalletEntry[]
  @@unique([tenantId, ownerType, ownerId])
  @@map("ai_wallets")
}

model AiWalletEntry {
  id             String   @id @default(uuid())
  walletId       String
  type           String   // grant | debit | refund | adjustment | expiry
  amountNanoUsd  BigInt
  priority       Int      @default(0)
  effectiveAt    DateTime @default(now())
  expiresAt      DateTime?
  usageRecordId  String?
  idempotencyKey String
  reason         String?
  createdAt      DateTime @default(now())
  wallet         AiWallet @relation(fields: [walletId], references: [id])
  allocationsAsDebit AiWalletDebitAllocation[] @relation("debit")
  allocationsAsGrant AiWalletDebitAllocation[] @relation("grant")
  @@unique([walletId, idempotencyKey])
  @@index([walletId, effectiveAt])
  @@index([walletId, type, expiresAt])
  @@map("ai_wallet_entries")
}

model AiWalletDebitAllocation {
  id            String        @id @default(uuid())
  debitEntryId  String
  grantEntryId  String
  amountNanoUsd BigInt
  debitEntry    AiWalletEntry @relation("debit", fields: [debitEntryId], references: [id])
  grantEntry    AiWalletEntry @relation("grant", fields: [grantEntryId], references: [id])
  @@index([grantEntryId])
  @@index([debitEntryId])
  @@map("ai_wallet_debit_allocations")
}

model AiBudget {
  id             String   @id @default(uuid())
  tenantId       String
  scopeType      String
  scopeId        String
  features       String[] @default([])
  limitNanoUsd   BigInt?
  limitTokens    BigInt?
  limitCount     Int?
  window         String   // day | week | month | total | custom:<seconds>
  anchorAt       DateTime?
  expiresAt      DateTime?
  softThresholds Json     // number[]
  policy         String   @default("block")
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  windows        AiBudgetWindow[]
  @@index([tenantId, scopeType, scopeId])
  @@map("ai_budgets")
}

model AiBudgetWindow {
  id           String   @id @default(uuid())
  budgetId     String
  windowStart  DateTime
  spentNanoUsd BigInt   @default(0)
  spentTokens  BigInt   @default(0)   // BigInt: 'total' windows on busy tenants exceed int4
  spentCount   Int      @default(0)
  updatedAt    DateTime @updatedAt
  budget       AiBudget @relation(fields: [budgetId], references: [id])
  @@unique([budgetId, windowStart])
  @@map("ai_budget_windows")
}
```

(An optional eighth table — the content sidecar — exists only when a host implements `IContentStore` over Postgres; its schema is host-defined, the library only defines the port.)

### 15.4 Multi-tenancy

Every table is keyed by `tenantId`; the subject hierarchy (`scopeType`/`scopeId`) supports tenant → team → user → key rollups directly in SQL — a capability `bymax-fitness` lacked (its per-user ledger had no tenant key). The host resolves tenant/scope from its auth layer (`scopeResolver` or explicit `MeteringContext`); the library never guesses it.

### 15.5 BigInt at the JSON boundary

`bigint` fields do not survive `JSON.stringify`. Normative rule: **the library's HTTP-facing helpers serialize bigint as decimal strings** (`"5000000"`), and the docs direct hosts returning `UsageRecord`/`AccessStatus` from controllers to a provided `toJsonSafe()` helper (or class-transformer). `formatNanoUsd()` renders display values. TS `number` is used for token counts (< 2^53 per record is guaranteed); Prisma `BigInt` columns guard the aggregate tables.

---

## 16. Error Code Catalog

### 16.1 `AiTokensException` class

```typescript
export interface AiTokensErrorResponse {
  error: {
    code: keyof typeof AI_TOKENS_ERROR_CODES
    message: string
    details?: Record<string, unknown>
  }
}

export class AiTokensException extends HttpException {
  constructor(
    code: keyof typeof AI_TOKENS_ERROR_CODES,
    statusCode: HttpStatus = AI_TOKENS_ERROR_STATUS[code],
    details?: Record<string, unknown>,
  ) {
    super({ error: { code, message: AI_TOKENS_ERROR_MESSAGES[code], details } }, statusCode)
  }
}
```

`AI_TOKENS_ERROR_MESSAGES` and `AI_TOKENS_ERROR_STATUS` are internal exhaustive maps (`Record<keyof typeof AI_TOKENS_ERROR_CODES, …>` so the compiler enforces coverage); `AI_TOKENS_ERROR_CODES`, `AiTokensException`, and `AiTokensErrorResponse` are public.

### 16.2 Code table

| Code                              | HTTP | When it occurs                                                                          |
| --------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `AI_TOKENS_NOT_CONFIGURED`        | 503  | A service was invoked before async options/store initialization completed (§4.6)         |
| `AI_TOKENS_INVALID_CONFIG`        | 500  | Options validation failed at init (bad markup, negative limits, missing port methods, missing fx) |
| `AI_TOKENS_UNKNOWN_PROVIDER`      | 400  | Raw usage passed without a `preset`/`normalizer` and it is not already a `NormalizedUsage` |
| `AI_TOKENS_USAGE_MALFORMED`       | 422  | The normalizer could not read required token fields from the raw usage                    |
| `AI_TOKENS_PRICE_NOT_FOUND`       | 422  | No effective-dated rate after §6.6 resolution, in strict mode (incl. missing tier row for a batch/flex/priority call) |
| `AI_TOKENS_FX_REQUIRED`           | 500  | `currency !== 'USD'` with no `fx` resolver (raised at init)                               |
| `AI_TOKENS_BUDGET_EXCEEDED`       | 402  | A hard spend budget blocks the call                                                       |
| `AI_TOKENS_QUOTA_EXCEEDED`        | 429  | A hard token/count quota blocks the call                                                  |
| `AI_TOKENS_INSUFFICIENT_CREDITS`  | 402  | Wallet conditional debit failed (balance + overdraft below the amount)                    |
| `AI_TOKENS_HOLD_NOT_FOUND`        | 404  | `capture()`/`release()` on an unknown hold — or one from another tenant (§14.4)           |
| `AI_TOKENS_HOLD_EXPIRED`          | 410  | `capture()` on a hold the reaper already swept (retryable via `record()`)                 |
| `AI_TOKENS_HOLD_ALREADY_SETTLED`  | 409  | `capture()` after `release()` (conflicting settlement; repeat `capture()` is idempotent — §11.1) |
| `AI_TOKENS_IDEMPOTENCY_CONFLICT`  | 409  | Same idempotency key with a different payload hash; or reversing an already-reversed record |
| `AI_TOKENS_STREAM_USAGE_MISSING`  | 422  | Stream ended without provider usage and no tokenizer fallback was available               |
| `AI_TOKENS_STORE_ERROR`           | 502  | The persistence adapter raised an unmapped error                                          |

---

## 17. What is NOT in the package

Deliberate scope decisions — each belongs to another lib, an external platform, or the consumer app:

- **Making the LLM call.** The library is normalizer-first; the host calls its provider SDK and hands over the `usage`. Optional thin typed wrappers are a v0.2 evaluation, not the core.
- **Invoicing / payment collection.** No Stripe/PayPal/MercadoPago charge is created. The library produces the metered usage + billable amount; connectors to Stripe Billing / Lago / OpenMeter are v0.2 adapters. (`bymax-fitness` likewise has no payment-gateway integration — intentional separation.)
- **Subscription / seat / plan management.** Plan definitions, seats, entitlement flags (e.g. `canGenerateWithAI`), and recurring fiat billing belong to the host's billing layer; the library owns the **usage/consumption** half and composes with it (a plan flag becomes a host guard before `BudgetGuard`).
- **Renewal scheduling.** The library provides `rotateWindow()` and `grant()`; *when* to call them (subscription renewed, plan changed) is the host's billing-cycle event.
- **A tokenizer implementation.** The host plugs `tiktoken` / `@dqbd/tiktoken` / provider count-tokens endpoints in via `ITokenizer`; the library ships no WASM tokenizer.
- **A dashboard UI.** Query surface only; the reference dashboard lives in `nest-ai-tokens-example`.
- **Prompt/response content storage by default.** Opt-in, redacted, short-TTL sidecar only.
- **Non-AI operation counting.** `maxWorkoutsPerMonth`-style caps that count *manual* (non-AI) actions are host domain logic — a count budget only counts AI usage records.
- **Web3 / gamification "tokens."** The `bymax-fitness` `web3-tokens` concept (earn tokens by completing workouts) is unrelated to AI cost and out of scope.
- **RAG / embeddings orchestration.** Vector search and prompt construction are app logic; the library only meters the embeddings `usage` they produce.
- **Rate limiting of raw HTTP.** Use `@nestjs/throttler`; the library enforces spend/token/count budgets, not request rates.
- **LLM retry/backoff.** The host owns retries; each attempt's usage is `record()`ed individually (`isSystemCost` for absorbed attempts), sharing a `correlationId`.

---

## 18. Dependencies (peer deps)

### 18.1 Strategy

Following the family (`@bymax-one/nest-storage`, `nest-queue`): the target is `"dependencies": {}`. Everything is `peerDependencies` — the consumer app controls versions. **No provider SDKs are peers at all**: the normalizers consume plain `usage` objects, so `openai`/`@anthropic-ai/sdk`/etc. never appear in this package's dependency graph — a deliberate authority point (zero coupling to SDK release cadence).

### 18.2 Peer dependencies

```json
{
  "peerDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "reflect-metadata": "^0.2.0",
    "@prisma/client": ">=6.0.0",
    "ioredis": "^5.0.0",
    "@nestjs/event-emitter": ">=2.0.0",
    "@opentelemetry/api": "^1.9.0"
  },
  "peerDependenciesMeta": {
    "@nestjs/common": { "optional": false },
    "@nestjs/core": { "optional": false },
    "reflect-metadata": { "optional": false },
    "@prisma/client": { "optional": true },
    "ioredis": { "optional": true },
    "@nestjs/event-emitter": { "optional": true },
    "@opentelemetry/api": { "optional": true }
  }
}
```

### 18.3 Rationale

- `@nestjs/common` + `@nestjs/core` + `reflect-metadata` — the only required peers.
- `@prisma/client` — only for the `./prisma` adapter; custom-store hosts omit it.
- `ioredis` — only for the `./redis` counter.
- `@nestjs/event-emitter` — only for the emitter event channel; absent → silent no-op (§12.1).
- `@opentelemetry/api` — only when `telemetry` is configured.

### 18.4 Dev dependencies

`jest`, `tsup`, `typescript`, `@nestjs/testing`, `@testcontainers/postgresql` (+ redis container for counter e2e), `@stryker-mutator/core`, `eslint`, `prettier`, `prisma`, `fast-check` (property-based money-math tests).

---

## 19. Implementation Phases

> **Testing strategy:** TDD per phase. Each phase delivers services + unit tests with **100% line/branch coverage on every file implemented in the phase** (Bymax lib floor); the published artifact is additionally gated at 100% global by `jest.coverage.config.ts` (run via `prepublishOnly`). Phase 4 adds e2e against real PostgreSQL (+ Redis) via Testcontainers; Phase 5 runs mutation testing (Stryker, break 95). All money math is bigint — property-based tests (`fast-check`) assert no drift across large accumulations and that markup/tier/surcharge composition is exact.

### 19.1 Overview

> The authoritative phase sequencing and per-phase task files live in `docs/development_plan.md` (status dashboard) and `docs/tasks/` (one file per phase). This section mirrors that 5-phase breakdown.

| Phase | Effort | Focus | Main deliverables |
| ----- | ------ | ----- | ----------------- |
| 1 | MEDIUM | Foundation + Normalizers + Pricing | Scaffold **+ the four CI workflows** (`ci`/`codeql`/`scorecard`/`release`, green from the first PR), `./shared` + `./prices`, all normalizers with reconciliation-invariant tests, catalogs, money utils, tier+surcharge-aware `computeCostNanoUsd` + `applyMarkup`, `PricingService` (resolution chain §6.6, idempotent seed), error catalog, ports, `forRoot()` |
| 2 | HIGH | Ledger + Markup + Events + Prisma store | `LedgerService` (state machine, payload-hash idempotency, compensation, opt-in hash chain), `record()` (+ `enforce`), markup engine, event catalog + emitter bridge + `IEventSink`, `PrismaAiTokensStore` (ledger + pricing halves), schema fragment + migrations |
| 3 | HIGH | Wallets + Budgets + Enforcement | `WalletService` (materialized balance, conditional debit, allocations/burn-down, adjust/entries/reconcile), `BudgetService` (multi-dimension limits, feature filters, anchored windows, status, rotate/reconcile), `BudgetGuard` + `@RequireBudget`, `onThrottle`, `RedisBudgetCounterStore` (`./redis`), Prisma wallet+budget halves |
| 4 | HIGH | Metering lifecycle + Streaming + Telemetry + Reporting + E2E | `meter()`/`hold()`/`capture()`/`release()`/`reverse()`/`getStatus()`, **hold reaper**, `StreamUsageCollector`, `MeteringInterceptor` + `@Meter` (+ headers), OTel emission, `UsageReportService` (summarize incl. cache savings, CSV/JSON export), `forRootAsync()`, the §19.2 e2e suite |
| 5 | LOW | Release v0.1.0 | README/CHANGELOG/SECURITY/CLAUDE/AGENTS, bundle budgets, final mutation run, tag + `npm publish --provenance`; `nest-ai-tokens-example` skeleton |

**Bundle-size budgets (`scripts/check-size.mjs`):** `dist/server` < 40 KB brotli, `dist/shared` < 10 KB, `dist/prisma` < 15 KB, `dist/redis` < 5 KB. `dist/prices` is data (no budget; documented size in the README).

### 19.2 E2E scenarios (Phase 4, Testcontainers)

1. **Hold → capture under concurrency:** two parallel `meter()` calls against a budget with headroom for one — exactly one proceeds, the other gets 402/429; ledger, window, and wallet agree afterward.
2. **Idempotent retry:** same `idempotencyKey` + payload replayed → one ledger row, identical response; changed payload → 409.
3. **Stream abort:** collector without a final usage chunk bills the tokenizer-counted partial via `capture()`; input tokens follow the §5.6 fallback order.
4. **Reversal restores headroom:** debit → `reverse()` → wallet balance, window counters (cost/tokens/count) and a subsequent blocked call all recover.
5. **Renewal-anchored window:** budget with `anchorAt` mid-month rotates on the anchor day, not the calendar 1st; `rotateWindow()` forces an immediate fresh window.
6. **Count quota:** `limitCount: 2` with a feature filter blocks the third matching generation while a non-matching feature (embeddings) passes.
7. **Alias resolution:** price row for `gpt-5.2` rates a response reporting `gpt-5.2-2026-03-14`; Azure deployment name resolves via `baseModel`.
8. **Seed idempotence:** two module boots against one database seed exactly once (advisory lock).
9. **Wallet burn-down:** two grants with different expiries; debits allocate to the soonest-expiring first; expiry entry negates the remainder.
10. **Reaper:** a crashed hold (TTL elapsed) is swept exactly once across two replicas; wallet/budget restored; `capture()` afterward → 410.

### 19.3 Executed by AI agents

No estimates in human days/weeks; relative complexity per phase is in the table above and the plan's complexity matrix.

---

## 20. Known Limitations

### 20.1 Framework and scope

- **NestJS only.** The pure `./shared` normalizers and cost math are framework-free and usable anywhere; the module/guard/interceptor surface is NestJS 11+.
- **Postgres is the only official store.** Other stores require implementing the ports (MySQL/SQLite adapters: evaluate on demand).
- **The library does not call the LLM.** It cannot capture usage the host never hands it; a host that forgets to `record()`/`capture()` bills nothing. (The interceptor pattern minimizes this risk for HTTP handlers.)
- **OpenAI/Gemini server-side tool counts are host-supplied.** Their usage objects do not carry tool-call counts; the host counts response items into `extraUnits` (Anthropic's are read automatically from `usage.server_tool_use`).

### 20.2 Accounting correctness

- **Estimates are not actuals.** Holds cannot predict reasoning tokens or provider-injected tool prompts; capture reconciles, but a host using only `record()` (no hold) forgoes pre-call enforcement.
- **`record({ enforce: true })` charges after the fact** — it can throw `AI_TOKENS_INSUFFICIENT_CREDITS` for a call that already ran. Use holds where that matters.
- **Aborted streams depend on the tokenizer fallback** (§5.6); without an `ITokenizer`, an aborted stream with all-zero provider usage cannot bill its partial output.
- **The hash chain serializes posted writes per tenant** (advisory lock) — measurable throughput cost on hot tenants; leave `ledger.hashChain` off unless tamper evidence is required.
- **Cross-replica enforcement is strongest with the Redis counter.** The DB conditional consume is correct but contends on the window row under high concurrency.
- **Budget windows and the live counter are caches** over the ledger; crash-window drift heals via `reconcileWindow()`/rotation (§10.7), not instantly.

### 20.3 Pricing freshness

- **The seed snapshot ages.** Provider prices and model IDs change frequently; the pinned dataset must be refreshed (CLI, v0.2). Point-in-time correctness of past records is unaffected.
- **Rate-cache staleness:** `upsertPrice()` takes up to `pricing.cacheTtlMs` to affect new calls across replicas.
- **Tier modeling is coarse:** one long-context threshold per price row; providers with multiple tiers need multiple rows or custom `unitRates`.
- **Mistral normalization is minimal** (prompt/completion only); its audio/cache detail fields ride in `raw` pending a verified mapping.

### 20.4 Features outside v0.1 (roadmap)

Typed provider call wrappers · Stripe/Lago/OpenMeter invoice connectors · `refresh-prices` CLI (LiteLLM + genai-prices sources) · OpenRouter async generation reconciliation · tag-scoped budgets · `IExportSink` (S3/GCS/BigQuery spend export) · cost-anomaly alerts (event contract is the prerequisite, shipped in v0.1) · spend forecasting beyond `projected_exceeded` · wallet `reserve()`/`releaseReservation()` earmarks · crypto-shredding helper · full media metering (video/audio second-based operations beyond `unitRates`) · MySQL/SQLite adapters.

---

## 21. Example Integration

### 21.1 Post-hoc metering (the `bymax-fitness` style, generalized)

```typescript
import { MeteringService, providerPresets } from '@bymax-one/nest-ai-tokens'
import { deriveIdempotencyKey } from '@bymax-one/nest-ai-tokens/shared'
import OpenAI from 'openai'

@Injectable()
export class WorkoutAiService {
  constructor(private readonly metering: MeteringService, private readonly openai: OpenAI) {}

  async generate(tenantId: string, userId: string, prompt: string, jobId: string) {
    const res = await this.openai.chat.completions.create({
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: prompt }],
    })
    await this.metering.record({
      usage: res.usage,
      preset: providerPresets.openaiChat,
      context: {
        tenantId,
        scope: { type: 'user', id: userId },
        feature: 'workout.generate',
        idempotencyKey: deriveIdempotencyKey({ jobId }),   // retry-safe
      },
    })
    return res.choices[0]?.message.content
  }
}
```

### 21.2 Enforced metering with a budget (hold → capture)

```typescript
async chat(tenantId: string, userId: string, prompt: string, requestId: string) {
  const { result, usage } = await this.metering.meter(
    () => this.openai.chat.completions.create({ model: 'gpt-5.4', messages: [{ role: 'user', content: prompt }] }),
    {
      tenantId,
      scope: { type: 'user', id: userId },
      feature: 'chat.reply',
      preset: providerPresets.openaiChat,
      idempotencyKey: deriveIdempotencyKey({ requestId }),
    },
    (res) => res.usage,
    { provider: 'openai', model: 'gpt-5.4', operation: 'chat', inputTokens: 800, maxOutputTokens: 1024 },
  )
  return { reply: result.choices[0]?.message.content, costUsd: Number(usage.billedCostNanoUsd) / 1e9 }
}
```

### 21.3 Declarative controller-level metering + status endpoint

```typescript
@Controller('ai')
export class AiController {
  constructor(private readonly metering: MeteringService) {}

  @Post('summarize')
  @UseGuards(BudgetGuard)
  @RequireBudget({ scope: 'tenant', estimate: { tokens: 3_000 } })
  @Meter({ feature: 'doc.summarize', scope: 'tenant', preset: providerPresets.anthropic, exposeHeaders: true })
  @UseInterceptors(MeteringInterceptor)
  async summarize(@Body() dto: SummarizeDto) {
    // returns { summary, usage } — the interceptor captures the guard's hold with `usage`
  }

  /** The frontend usage meter — bymax-fitness's aiTokensRemaining/aiGenerationsRemaining DTOs. */
  @Get('me/usage')
  async myUsage(@Req() req: AuthedRequest) {
    const status = await this.metering.getStatus(req.user.tenantId, { type: 'user', id: req.user.id })
    return toJsonSafe(status)   // bigint → decimal strings (§15.5)
  }
}
```

### 21.4 OpenRouter (provider-reported cost — no price table)

```typescript
await this.metering.record({
  usage: openRouterResponse.usage,               // carries usage.cost
  preset: providerPresets.openrouter,            // ratingMode: 'provider-reported'
  context: { tenantId, scope: { type: 'user', id: userId }, feature: 'chat.reply',
             idempotencyKey: deriveIdempotencyKey({ requestId }) },
})
```

### 21.5 Reselling with markup + prepaid credits + count quotas

```typescript
BymaxAiTokensModule.forRootAsync({
  imports: [PrismaModule],
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => ({
    store: new PrismaAiTokensStore(prisma),
    markup: 4.0,                                       // end-users pay 4× provider cost
    wallets: { creditRateNanoUsd: 5_000_000_000n },    // sell credits at $5 each
    budgets: { defaultPolicy: 'block', alertThresholds: [0.8, 1.0] },
  }),
})

// On subscription creation/renewal (host billing event):
await this.budgets.upsertBudget({
  tenantId, scope: { type: 'user', id: userId },
  features: ['workout.generate'],
  limitCount: plan.maxAIGenerationsPerMonth ?? undefined,   // count quota
  limitTokens: plan.aiTokensMonthly ?? undefined,           // token quota
  window: 'month',
  anchorAt: subscription.renewalDate,                       // renewal-anchored, not calendar
  softThresholds: [0.8, 1.0], policy: 'block',
})
await this.wallets.grant(
  { tenantId, ownerType: 'user', ownerId: userId },
  { amountNanoUsd: 25_000_000_000n, expiresAt: nextRenewal,
    idempotencyKey: `allowance:${userId}:${cycle}`, reason: 'monthly plan allowance' },
)
```

### 21.6 Streaming with abort-safe capture

```typescript
const ctx = { tenantId, scope: { type: 'user', id: userId }, feature: 'chat.stream',
              preset: providerPresets.openaiChat,
              idempotencyKey: deriveIdempotencyKey({ requestId }) } satisfies MeteringContext

const hold = await this.metering.hold(ctx, {
  provider: 'openai', model: 'gpt-5.4', operation: 'chat',
  inputTokens: estimatedInput, maxOutputTokens: 1024,
})
const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5.4', preset: providerPresets.openaiChat })
try {
  const stream = await this.openai.chat.completions.create({
    model: 'gpt-5.4', messages, stream: true, stream_options: { include_usage: true },
  })
  for await (const chunk of stream) {
    collector.push(chunk)                       // watches for the final usage chunk
    res.write(chunk.choices[0]?.delta?.content ?? '')
  }
} catch (err) {
  // Client aborted / provider error mid-stream: bill the partial the client received.
  // capture() is IDEMPOTENT — safe even if the try block reached its natural end (§11.1).
  await this.metering.capture(hold, collector)
  throw err
}
await this.metering.capture(hold, collector)    // settle with provider-final actuals
```

### 21.7 Trainer pays for client (payer ≠ beneficiary)

```typescript
await this.metering.record({
  usage: res.usage,
  preset: providerPresets.openaiChat,
  context: {
    tenantId,
    scope: { type: 'user', id: trainerId },           // the PAYER — quota/wallet charged here
    beneficiary: { type: 'user', id: clientId },      // reporting dimension
    requestedBy: trainerId,
    feature: 'workout.generate',
    idempotencyKey: deriveIdempotencyKey({ workoutJobId }),
  },
})
// Later: "which clients consumed this trainer's tokens?"
await this.reports.summarize({ tenantId, scope: { type: 'user', id: trainerId },
  from, to, groupBy: ['beneficiary'] })
```

### 21.8 Production considerations

- **Always pass a content-derived `idempotencyKey`** — it is the retry-safety contract (§8.4).
- **Never store prompt text in the ledger.** Use the opt-in `content` sidecar with masking + TTL only when debugging requires it.
- **Set a markup deliberately.** `markup: 1.0` bills at cost (internal FinOps); a resale SaaS sets a multiplier or a credit exchange rate. Pure pass-through markup is a race to the bottom — position it atop differentiated value.
- **Anchor plan budgets to the subscription renewal date** (`anchorAt`) and add a daily cap alongside the monthly one to bound spikes.
- **Prefer holds/guard** over bare `record()` when overspend must be stopped before the call, not observed after.
- **Restrict the admin plane** (grants, price changes, reversals, exports) to privileged roles (§14.4).
- **Serialize bigint at controller boundaries** with `toJsonSafe()` (§15.5).
- **Keep the price snapshot fresh**, but rely on effective-dated rows for historical correctness — never re-rate past usage.

---

## 22. Migration from bymax-fitness

This library replaces the bespoke AI cost layer in `bymax-fitness` (`_commons_/ai/*`). Verified against the production code, the mapping is:

| bymax-fitness today | nest-ai-tokens equivalent |
| --- | --- |
| `AITokenTransaction` (Int `amount`, cost/model/flags inside `metadata` JSON) | `AiUsageRecord` — typed, indexed columns for every token category, `rawCostNanoUsd`/`billedCostNanoUsd`, `feature`, `systemCostCategory` |
| `ModelPricing` (`effectiveFrom`/`effectiveTo`, USD Decimal) | `AiModelPrice` — same effective-dated model, bigint nano-USD/million, + `serviceTier` + `unitRates` dimensions |
| `PricingService.calculateCost()` | `PricingService.resolveRate()` + pure `computeCostNanoUsd()` (+ alias resolution §6.6) |
| Two divergent write paths (`SubscriptionsService` `$transaction` vs bare `createTransaction`) | One unified path: `record()` / `meter()` — the counter-update inconsistency disappears |
| `Subscription.aiTokensUsed` + pre-check with heuristic estimate (check-only, racy) | Token budget (`limitTokens`) + `hold()` with a caller-supplied `HoldEstimate` (`{ amountNanoUsd }` accepts the existing `WorkoutTokenEstimator` output) — a real race-safe reservation |
| `Subscription.aiGenerationsUsed` / `Plan.maxAIGenerationsPerMonth` (operation counts) | **Count budget**: `limitCount` + `features: ['workout.generate']` (§10.1) — decision-assist stays outside via its own feature name |
| `Plan.maxWorkoutsPerMonth` (counts manual, non-AI workouts too) | **Stays host-owned** — not AI usage (§17) |
| Billing-cycle reset ("tokens reset on renewalDate" — today a promise without a scheduler) | `anchorAt: renewalDate` windows + `rotateWindow()` on the host's renewal event — the missing primitive, provided |
| `TrialPlan.aiTokensTotal` / `maxAIGenerationsTotal` | `window: 'total'` budgets (+ `limitCount`) with `expiresAt` = trial end |
| `isUnlimited`: `null \|\| 0 → unlimited` (and `0 → blocked` on one path — a live production bug) | Normative §10.2: unlimited = **no budget row**; `0` = hard block. **Migration rule: fitness `0`/`null` limits ⇒ do not create a budget row** |
| Trainer-pays-for-client (`tokenPayerId` role logic) | Host resolves the payer into `scope`; the client goes in `beneficiary`; `requestedBy` = the actor (§21.7) — payer-side enforcement + beneficiary-side reporting |
| `AIGenerationGuard` (blocks + enriches `request.tokensRemaining`/`estimatedTokens`) | `BudgetGuard` + `@RequireBudget` — attaches `request.aiTokens = { status, hold?, context }` (§11.3) |
| `aiTokensRemaining`/`aiGenerationsRemaining`/`workoutsRemaining` DTOs | `MeteringService.getStatus()` → `AccessStatus`/`BudgetStatus` (§10.6), exposed via a host `GET /me/ai-usage` |
| `Plan.canGenerateWithAI`, `priorityAI` | **Stay host-side**: entitlement guard before `BudgetGuard`; queue priority in the host's BullMQ options |
| Refund-on-failure (`refundAITokenInTransaction`: decrement counters + `refund` row) | `MeteringService.reverse()` — ledger compensation + wallet refund + budget release (cost/tokens/**count**) in one transaction (§8.5) |
| Debit failure swallowed after success (revenue leak by design) | Idempotent `record()` retries safely — a behavior improvement, not just parity |
| Per-service copy-pasted retry/backoff; **every failed attempt** charged as system cost | Host owns retries; each attempt is `record()`ed individually (`isSystemCost: true`, `systemCostCategory: 'workout_generation_retry'`), sharing a `correlationId` |
| `systemCostCategory` strings (`workout_generation_retry`, `guideline_setup`, `system_config`, `admin_ai_command`, `admin_text_translation`, `exercise_setup`) | `systemCostCategory` column, preserved verbatim + `groupBy: ['systemCostCategory']` (§13.1) — the boolean flag alone is NOT sufficient |
| `getSystemCosts` by category/user/total (in-memory JSON filtering) | `summarize()` with `isSystemCost`/`systemCostCategory` filters — real SQL |
| Embeddings recorded but never hitting user quota (by design) | `record()` **without** `enforce` — observed in reports, invisible to budgets (§10.7); RAG-query embeddings attributed to the payer via `scope` + `feature: 'rag.query'` |
| `type 'monthly_allocation'` credits (decorative — enforcement never read them) | Either a real wallet `grant()` (money model) or — recommended for fitness, since plan limits don't roll over — plain budgets; pick ONE, not both |
| `Tenant.aiTokenBalance` (prepaid **token** pool) + `TenantAITokenTransaction` (purchase/manual_adjustment/refund…) | `AiWallet` (`ownerType: 'tenant'`) + `grant`/`adjust`/`refund`/`getEntries`. **Denomination change: tokens → nano-USD.** Convert at a fixed board-approved rate (e.g. `balanceNanoUsd = aiTokenBalance × flatNanoUsdPerToken`) and update tenant-facing UI copy from "tokens" to "credits" |
| Voucher mint: debit `tokensReserved = maxRedemptions × perRedemption` upfront; pro-rata refund on delete | `WalletService.debit()` (no `usageRecordId`, `reason: 'voucher:<code>'`) at mint + `refund()` on delete — same economics; a true `reserve()` earmark is v0.2 |
| `PlatformAITokenCost` (platform liability for global vouchers/trials) | A platform-owned wallet (`ownerType: 'tenant'`, the platform tenant) or `isSystemCost` records with `systemCostCategory: 'voucher_*'` — one mechanism, not two tables |
| Prompt text in ledger metadata (`queryText` first 200 chars) | **Forbidden in the ledger** (§14.2). Migrating call sites move it to the `content` sidecar or logs |
| Three model configs (embedding/command/workout) wired through one module | No special wiring — every call is independently `(provider, model, operation)`-keyed; embedding rows are `operation: 'embeddings'` with output rate 0 |

### 22.1 Backfill notes

A one-off host-owned script can replay historical `AITokenTransaction` rows into `AiUsageRecord`:

- Rate each row against the `AiModelPrice` version effective at its `createdAt` (point-in-time preserved).
- **Degraded mapping is unavoidable for most rows:** `amount` is a single total (no input/output split except on decision-assist rows) → map `inputTokens = |amount|`, other categories 0, and set `priceMissing`-style provenance in `tags: ['backfill:v1']`.
- **Strip `queryText`/`reasoning`** and any prompt fragments from `metadata` — they must not enter the ledger (§14.2).
- Translate `type` → `feature` (`generation → workout.generate`, `embedding_generation → embedding.generate`, `agent_decision_assist → agent.decision_assist`, `purchase`/`refund`/`monthly_allocation`/`trial_allocation` → wallet entries, not usage records).
- Set `enforced: false` on all backfilled rows — they must not retro-consume budget windows (§10.7).
- Plan limits: `0`/`null` ⇒ **no budget row** (§10.2 warning).

---

_End of the `@bymax-one/nest-ai-tokens` technical specification._
