# Changelog

All notable changes to `@bymax-one/nest-ai-tokens` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-07-03

Initial public release.

### Added

- **Nine provider normalizers** — OpenAI Chat Completions, OpenAI Responses API, OpenAI-compatible (DeepSeek, xAI, Groq, Azure OpenAI), Anthropic Messages, Google Gemini / Vertex AI, AWS Bedrock Converse, Mistral, OpenRouter, Vercel AI SDK v5/v6. All are pure functions over plain objects; no provider SDK peer dependency.
- **Versioned effective-dated pricing** — `PricingService` with a six-step model-resolution chain, in-memory TTL cache, `upsertPrice()`, and idempotent `MODEL_PRICES_SEED` snapshot seed. Rates are bigint nano-USD per million tokens; past records are never re-rated.
- **Immutable append-only ledger** — `LedgerService` with content-derived idempotency (`deriveIdempotencyKey`), exactly-once semantics (payload-hash replay detection), lifecycle transitions (pending → posted → reversed/released), filtered queries, and optional per-tenant tamper-evident hash chain (`verifyChain()`).
- **First-class markup / margin** — `MarkupResolver` with a fixed multiplier or a per-call `IMarkupPolicy`. Every record stores both `rawCostNanoUsd` (provider cost) and `billedCostNanoUsd` (after markup). The resale lever is a first-class configuration option, not application code.
- **Prepaid wallets** — `WalletService` with grant/debit/refund/adjust entries, configurable burn order (expiry/priority/FIFO), overdraft support, and debit-allocation tracking.
- **Multi-dimension budgets** — `BudgetService` with per-scope, per-feature, per-window (daily/weekly/monthly/total) caps on spend, token count, and operation count. Hard block (`policy: 'block'`) or soft alert with threshold events. Renewal-anchored windows via `anchorAt`.
- **Optional Redis budget counter** — `RedisBudgetCounterStore` with a single atomic Lua `incrIfBelow` script for sub-ms cross-replica enforcement.
- **Full hold → capture lifecycle** — `MeteringService.hold()` / `capture()` / `release()` / `meter()` for pre-flight spend reservation. `capture()` is idempotent.
- **Streaming capture** — `StreamUsageCollector` accumulates SSE chunks, prefers provider-final usage, falls back to tokenizer on abort.
- **NestJS enforcement** — `BudgetGuard` (CanActivate), `MeteringInterceptor` (NestInterceptor), and the `@Meter`, `@RequireBudget`, `@AiFeature` decorators for declarative controller-level metering.
- **Usage reporting** — `UsageReportService` with SQL-aggregated `summarize()`, CSV/JSON `export()`, paginated history, per-model analytics, and currency conversion.
- **Events** — Typed domain events (`ai_tokens.*`) delivered to `@nestjs/event-emitter` (optional peer) and/or an `IEventSink` port.
- **OpenTelemetry** — Optional `ITelemetrySink` / `OtelTelemetrySink` via `@opentelemetry/api` (optional peer).
- **PostgreSQL adapter** — `PrismaAiTokensStore` (`./prisma` subpath) implementing all four storage ports via parameterized raw SQL. Seven-table schema with migrations.
- **Five subpaths** — `.` (server), `./shared` (zero-dep), `./prices` (data-only), `./prisma` (adapter), `./redis` (counter).
- **Zero runtime dependencies** — `"dependencies": {}`. All runtime functionality via peer dependencies.
- **100% unit test coverage** — 655 tests; 10-scenario Testcontainers e2e suite; Stryker mutation gate (break 95).
