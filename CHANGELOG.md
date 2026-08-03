# Changelog

All notable changes to `@bymax-one/nest-ai-tokens` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.1.0] - 2026-08-03

First published release. Everything below ships in it.

The `Fixed` and `Security` entries record defects found and corrected before
publication, not regressions any consumer saw — there is no earlier release to
have regressed from. They are kept because the reasoning is worth having.

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
- **100% unit test coverage** — 804 tests; 10-scenario Testcontainers e2e suite; Stryker mutation gate at 100.00% (0 surviving mutants, break 95).

[Unreleased]: https://github.com/bymaxone/nest-ai-tokens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bymaxone/nest-ai-tokens/releases/tag/v0.1.0

- **Prisma 7 support, alongside Prisma 6.** The declared peer range has always
  been `>=6.0.0`, but nothing verified the claim; the end-to-end suite now runs
  against Prisma 7 and a real PostgreSQL, and it is what surfaced the conflict
  defect above. The library's own code needed no change — it reaches PostgreSQL
  exclusively through parameterized raw SQL, and every `Prisma.*` helper it uses
  is unchanged across the two majors.

  What changed is the development schema and the test harness, mirroring what a
  host application has to do: `url` left the `datasource` block for a new
  `prisma.config.ts`, and clients are opened through `@prisma/adapter-pg` rather
  than the removed `datasourceUrl`. Both setups are documented in the README.

- **`pnpm check:exports`** runs `attw --pack . --profile strict` against the packed
  tarball, which is what surfaced both resolution defects above.
- **`pnpm check:runtime`** packs the tarball, lays it out the way npm would, and
  asserts in ESM *and* CommonJS that an error thrown by `PrismaAiTokensStore`
  satisfies `instanceof AiTokensException` against the class the root exports. No
  source-based suite can observe this: the unit tests map the subpath specifiers to
  `src` and therefore see a single copy. Both gates run in CI.

### Fixed

- **Idempotency conflicts were reported as generic store errors under Prisma 7.**
  A raw-query unique violation carries the native SQLSTATE, and where it carries
  it depends on how the client reaches the database. Prisma 6 puts it flat on
  `meta.code`; a Prisma 7 driver adapter nests the driver's own error under
  `meta.driverAdapterError.cause`. `isUniqueViolation` read only the first, so on
  Prisma 7 the exactly-once replay-or-conflict path (§15.2) degraded a 409
  `AI_TOKENS_IDEMPOTENCY_CONFLICT` into a 500-class `AI_TOKENS_STORE_ERROR` —
  silently, since nothing threw. Both shapes are now read.

- **Errors thrown by `PrismaAiTokensStore` were not recognised as
  `AiTokensException`.** The store lives in the `./prisma` entry point and reached
  the class through a relative path into `../server`, so the separate bundle got
  its own copy. The copy carries the same name and the same shape, so nothing
  crashed — but the four `instanceof AiTokensException` guards in
  `bymax-ai-tokens.module.ts`, `hold-support.ts`, `wallet.service.ts` and
  `metering.service.ts` all stopped matching, silently reclassifying store errors
  such as `AI_TOKENS_INSUFFICIENT_CREDITS` and `AI_TOKENS_IDEMPOTENCY_CONFLICT` as
  unexpected failures.

  `./prisma` now imports the class by package specifier, which the bundler already
  kept external for the lazily-loaded `./prices` subpath, so one identity is shared
  in CommonJS as well as ESM. `isLedgerIdempotencyConflict` was unaffected: it is
  deliberately duck-typed rather than `instanceof`-based.

- **CommonJS consumers resolved ESM type declarations** on all five subpaths. The
  `exports` map declared a single `types` condition, so `require()` landed on
  `.d.ts` instead of `.d.cts`. Types are now declared per condition.

- **`node10` type resolution failed outright**: the manifest carried no `main`,
  `module` or `types`, and no `typesVersions`. All four are now present.

### Security

- **Peer floors raised to exclude known-vulnerable NestJS versions.** The declared
  ranges were `@nestjs/common ^11.0.0` and `@nestjs/core ^11.0.0`, and both
  admitted versions carrying published advisories:

  | Peer             | Advisory                                                                                                                                    | Vulnerable                    | New floor  |
  | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------- |
  | `@nestjs/common` | [GHSA-cj7v-w2c7-cp7c](https://github.com/advisories/GHSA-cj7v-w2c7-cp7c) — remote code execution via the `Content-Type` header              | `>= 11.0.0-next.1, < 11.0.16` | `^11.0.16` |
  | `@nestjs/core`   | [GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75) — improper neutralization of special elements in downstream output | `<= 11.1.17`                  | `^11.1.18` |

  A peer range is a statement about which versions this library supports. A floor
  below a published advisory tells a consumer that a vulnerable install is a
  supported one, and nothing in their tooling contradicts it — the install resolves
  cleanly and silently. Corrected before the first publish, so no released version
  ever carried the permissive range. No runtime behaviour changed.

---

