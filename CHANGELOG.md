# Changelog

All notable changes to `@bymax-one/nest-ai-tokens` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

- **BREAKING: `ioredis` peer moved to `^6.0.0`** (was `^5.0.0`; the ranges are disjoint, so an
  ioredis 5 consumer no longer satisfies the contract). It aligns the `./redis` budget counter
  with `@bymax-one/nest-queue@1.2.0`, so a backend that consumes both resolves one shared `ioredis`.
  ioredis 6 defaults to RESP3 but keeps `replyMapping: "legacy"`, leaving reply shapes unchanged at
  runtime; the store's URL-only `new Redis(url)` construction is untouched by the RESP3 options
  typing break, so no source changed.
- **Mutation gate raised to a perfect score.** `stryker.config.json` now breaks below 100 (`break`,
  `high` and `low` are all 100), so no surviving mutant can pass the gate.

## [1.0.4] - 2026-08-10

Remediation of a local audit's settlement findings (merged in #65). No API changed.

### Fixed

- **Negative usage can no longer credit the wallet or budget.** `clampUsageCounts` floors every
  token count — and the provider-reported cost (`providerReportedCostNanoUsd`) — at zero before the
  signed settlement leg. A normalizer that computes a field by subtraction (OpenRouter's
  `prompt - cached`), or a provider that reports a negative `usage.cost`, would otherwise credit
  back more than was reserved and drive budget consumption negative.
- **Streaming captures are clamped like non-stream captures.** `finalizeCaptureUsage` now routes
  the `StreamUsageCollector` final through `normalizeCaptureUsage`, so a provider-final stream
  carrying negative counts or cost no longer bypasses the floor and reaches settlement raw.

### Documentation

- `RecordInput.occurredAt` documents its trust model: it is a deliberate backfill feature, honoured
  as given because `record()`'s input is trusted host input, and a host that forwards a value an
  untrusted end user controls must validate it first — a back-dated timestamp selects a historical
  price and an earlier budget window.

## [1.0.3] - 2026-08-06

### Fixed

- **Every suppression reason was dropped from the mutation report.** All 249 `// Stryker
disable` directives in the source wrote their justification after `--`. Stryker reads a
  directive with one regular expression, `/^\s?Stryker (disable|restore)(?: (next-line))?
([a-zA-Z, ]+)(?::(.+)?)?/`, whose mutator list accepts letters, commas and spaces only
  and which captures the reason exclusively after a colon. A `-` therefore closed the
  mutator list and left the reason unmatched, so each directive still silenced its mutant
  but the report recorded Stryker's fallback text, `Ignored using a comment`. The README
  claimed the opposite — that every suppression carries its reason — and documented the
  broken separator as the convention. The directives now use `<Mutator>: <reason>`, which
  is the grammar the parser accepts, and the reasons reach the report.

### Added

- `check:mutants` gate (`scripts/check-mutation-directives.mjs`) — validates every
  `// Stryker` comment against the parser's own regular expression, rejecting a reason
  written after `--`, a reason wrapped onto a second comment line (the report keeps only
  the first fragment), and a mutator name Stryker does not know, which would silence
  nothing at all. Wired into CI and `prepublishOnly`. Stryker warns about the last case,
  but only during a mutation run, which on this repo happens post-merge.

### Changed

- No runtime behaviour changed. `dist/` differs only in the text of those comments; the
  server bundle moved from 38,096 to 38,145 B brotli, well inside its 40,000 B budget.

## [1.0.2] - 2026-08-05

### Fixed

- **The module could not be initialised by a consumer at all.** `MeteringInterceptor` is
  registered as a plain class provider, so Nest resolves its constructor — but only the
  third parameter carried a token. Nest reads two separate metadata keys for this:
  `self:paramtypes`, written by `@Inject()`, and `design:paramtypes`, written by
  TypeScript. The published bundle is built by tsup/esbuild, and esbuild states it cannot
  implement `emitDecoratorMetadata` because it does not replicate TypeScript's type
  system — so the second key was never there. The first two parameters had neither, and
  the container threw `Nest can't resolve dependencies of the MeteringInterceptor
(?, +, Symbol(BYMAX_AI_TOKENS_OPTIONS))` before any provider was created. Both now
  carry `@Inject`.

### Changed

- `emitDecoratorMetadata` is `false` in `tsconfig.json`. It was `true`, which was never
  true of the artifact: tsup prints `You have emitDecoratorMetadata enabled but
@swc/core was not installed, skipping swc plugin` on every build, and that warning had
  been printed on every build of this package. Turning it off makes the source compile
  the way the bundle is built, so a parameter that depends on reflected types now fails
  where it is cheap to see.
- The imports that existed only to feed that metadata are `import type` again. The lint
  rule reported each one the moment the flag went off, which makes it a precise detector
  for this defect: an import that is value-only because a constructor parameter needs its
  type is an import that will not survive the bundle.

## [1.0.1] - 2026-08-04

### Removed

- The README's `Migration` section, which described migrating an AI cost layer out of a
  named private monorepo. It reached the npm page of a public package, where it named a
  repository its readers cannot see and cannot act on. The normative rule it carried —
  translate `0`/`null` limits to no budget row — is already stated under the budget
  semantics and is unchanged.

### Security

- The Redis credentials are no longer disclosed when `RedisBudgetCounterStore` is
  serialized. The store kept the live client — or the connection URL it is opened from —
  in a TypeScript `private` property, which is erased at runtime and leaves an enumerable
  own property. A connection URL carries the password inline and an ioredis instance
  carries `options.password` as a plain field, so `JSON.stringify`, object spread and
  `util.inspect` emitted the password in plaintext, which is what a structured logger does
  when it renders its arguments and what an error reporter does when it captures the scope
  of a throw. The source and the in-flight lazy connection both move to ECMAScript private
  fields.

Reading on purpose is unchanged and no public type or export moved.

## [1.0.0] - 2026-08-03

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
  asserts in ESM _and_ CommonJS that an error thrown by `PrismaAiTokensStore`
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

[1.0.0]: https://github.com/bymaxone/nest-ai-tokens/releases/tag/v1.0.0
[1.0.1]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.0...v1.0.1
[1.0.2]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.1...v1.0.2
[1.0.4]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.2...v1.0.3
[Unreleased]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.4...HEAD
