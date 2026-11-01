# Changelog

All notable changes to `@bymax-one/nest-ai-tokens` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

**Apply:** `record()` and `meter()` now treat a second call with an `idempotencyKey` the ledger already
holds as a replay of the first when the request is the same: it returns the stored record and does
nothing else. A retry that used to fail with `AI_TOKENS_IDEMPOTENCY_CONFLICT` only because its
defaulted `occurredAt` or the price had changed now returns the stored record, so code that handled
that conflict by recording again no longer reaches that branch. A request that differs still fails
with the conflict. The effects of a replay are not repeated: if the first call stopped after writing
the record and before its budget or wallet movement, the retry will not make it.

**Apply:** a host that seeded its own price rows under `azure-openai` or `vertex` and relied on a
hold (`hold()` or `meter()` with a `{ tokens }` estimate) to price through them must re-key those
rows to `openai` or `gemini`, or pass the provider in the estimate (`{ provider, model, ... }`).
`record()` never read those rows, and the `azureOpenai` and `vertex` presets now carry the provider
their records already had.

### Fixed

- **A retry of `record({ enforce: true })` consumed the budget a second time.** Every published
  version from 1.0.0 to 1.1.4 runs the same sequence after the ledger write: the events, the
  telemetry, the content capture, then the budget consume and the wallet debit. When the retry
  repeated the stored request exactly (the same `idempotencyKey` and the same `occurredAt`, which is
  how a backfill or a job-start timestamp retries), the ledger returned the stored row and the whole
  sequence ran again. Measured on the code after 1.1.4, which leaves this path as it was, with budgets, wallets, an event sink, a telemetry
  sink and a content store attached: the budget spend, call count and token count doubled
  (1,250,000 nano-USD, 1 call, 1,500 tokens became 2,500,000, 2 calls, 3,000 tokens), a second
  `usage.recorded` event, a second usage measurement and a second content capture were produced,
  and the wallet balance did not move again because its debit is keyed by the record. A host that
  passes `occurredAt` and enables budgets was affected on any retry. A retry now returns the stored
  record and runs none of it, `meter()` records no duration for it, and a test pins every one of
  those counts.
- **A retry that left out `occurredAt`, or came after a price change, failed with a conflict.**
  `occurredAt` defaults to the current time and the ledger's payload hash included it, together with
  the price version and the costs, so a retry made a moment later was a different payload. The
  README Quick Start's `idempotencyKey: deriveIdempotencyKey({ jobId })` therefore did not make the
  retry return the stored record. A retry is now compared on what the caller supplied and the
  provider reported (every request field, and `occurredAt` only when the retry passes one), not on
  what was computed while serving the call, and returns the stored record at its original cost.
- **A hold and a record made from the same preset used different providers.** `record()` stamped the
  provider its normalizer returned (`openai` for `azureOpenai`, `gemini` for `vertex`), while
  `hold()` stamped `preset.provider` (`azure-openai`, `vertex`) and `capture()` priced with that. No
  seeded row exists under those ids, so a held Azure or Vertex call threw
  `AI_TOKENS_PRICE_NOT_FOUND` with `pricing.strict` on and was settled at cost 0 with it off. The two
  presets now carry `openai` and `gemini`, and a test pins that every preset's `provider` equals the
  one its normalizer stamps.
- **`providerPresets.openaiCompatible(id)` now records `id`.** Its normalizer cannot know the id, so
  the record's provider was `''`: a call threw `AI_TOKENS_PRICE_NOT_FOUND` with `pricing.strict` on
  and was stored with provider `''` at cost 0 with it off, whatever seeded rows existed for
  `deepseek`, `xai` or `groq`.
- **`record()` names the model after `baseModel` when the response carries none.** A Bedrock Converse
  response has no model id, so the record's model was `''` while the same call through `hold()` and
  `capture()` stored `baseModel`. A model the response did carry is never replaced. The
  idempotency payload keeps hashing the model the response carried, so a retry of a Bedrock call
  whose first attempt an earlier version stored with the empty model still returns that stored
  record, and a different call under the same key still conflicts.
- `providerPresets.openaiCompatible(id)` stamps `id` into the idempotency payload, which earlier
  versions left empty. A retry, with the same `idempotencyKey`, of a call that an earlier version
  stored with `pricing.strict: false` (provider `''`, cost 0, `priceMissing`) now fails with
  `AI_TOKENS_IDEMPOTENCY_CONFLICT` instead of returning the stored record. Under the default
  `pricing.strict` such a call threw and stored nothing.
- The `vercelAiSdk` preset still records no provider on purpose (the SDK does not say which vendor
  served the call), so such a record fails loudly instead of being priced from the wrong vendor's
  rows. Its documentation said the context could override the provider; nothing does, and the text now
  says so. A test pins that a held non-OpenAI model is never priced from an `openai` row.

### Changed

- The `server` bundle size budget in `scripts/check-size.mjs` is 41,000 B brotli (it was 40,000 B).
  The idempotent replay path in `record()` (per-key serialization, request-field matching, the
  shared field-role table) outgrew the previous budget. The other budgets are unchanged.
- The declaration build strips members tagged `@internal`, and the published-surface gate fails when a
  name tagged `@internal` in `src` reaches a built `.d.ts` or `.d.cts`.

### Documentation

- The README says what a retry with the same `idempotencyKey` returns and what it leaves alone, that
  calls with one key run one at a time within one service instance, and that two simultaneous calls
  with one key on different instances can still both run their effects. A test runs the Quick Start
  twice, also after a price change, and pins that it stores one record.
- The Quick Start passed `res.usage` to `record()` with the OpenAI preset, which throws
  `AI_TOKENS_USAGE_MALFORMED` because the normalizer reads `model` and `usage` from the whole
  response; it now passes `res`. The examples also used `gpt-4o`, which the price seed does not
  cover, so under the default `pricing.strict` they threw `AI_TOKENS_PRICE_NOT_FOUND`; they now use
  the seeded `gpt-5-mini`. A unit test runs the Quick Start flow so the example cannot drift again.
- The README now says which presets are priced from which seeded rows. The `azureOpenai` and
  `vertex` presets record provider `openai` and `gemini`. It
  also says that a Bedrock Converse response carries no model id, so the record's model is
  `baseModel` when the caller passes one and `''` otherwise, and it explains the `vercelAiSdk` and
  `openaiCompatible(id)` providers.

## [1.1.4] - 2026-11-01

**Apply:** `verifyChain` has a new result, `{ valid: false, status: 'never-enabled' }`, which has no
`brokenAtRecordId`; handle it wherever you read that field. Enable `ledger.hashChain` before the
first write: records written earlier are reported as unchained and are not protected.

### Fixed

- **Enabling `ledger.hashChain` on a ledger that already has records no longer makes `verifyChain`
  report the oldest record as tampered.** `verifyChain` required every settled record to carry a
  hash, so the first record written before the chain was enabled failed verification and ended the
  walk, and the chained records after it were never checked. It now follows the chain by its links:
  records without a hash are counted in the new `unchainedCount` and reported as not protected, the
  hashed records must start at one genesis with no gap in the links, and a record whose hash was
  removed while its `prevHash` stayed is reported as broken. A ledger with settled records and no
  hashed one returns `{ valid: false, status: 'never-enabled' }`. The result type gains
  `unchainedCount` and an optional `chainStartsAtRecordId`; the new `never-enabled` variant has no
  `brokenAtRecordId`. A `from`/`to` call still checks each record's own hash only. A record that no other
  record names as its predecessor (the newest one, and a hold that settled while a later-created record
  was already hashed) can be deleted without detection, and the chain is unkeyed; both limits are in the README.

  **Apply:** code that reads `brokenAtRecordId` after `valid === false` must also handle the
  `never-enabled` variant, which has none. Enable the chain before the first write; a rise in
  `unchainedCount` after enabling is worth investigating.

### Changed

- The GitHub Release body is now the tag's own `CHANGELOG.md` section instead of the generated
  pull-request list, and the release stops before publishing when the version has no section.
  No change to the package.
- The release-notes step starts the section only at a line that begins `## [<version>]`, so a
  version token elsewhere in a heading, such as `## [Unreleased] [1.1.1]`, no longer selects the
  wrong body.
- The unused optional peer `@opentelemetry/api` is removed from `peerDependencies` and
  `peerDependenciesMeta`. The package imports nothing from it; telemetry goes through the
  `ITelemetrySink` you implement. Consumers lose only an install hint.

### Documentation

- The README says that `MODEL_PRICES_SEED` has no rows for `azure-openai`, `vertex`, `bedrock` or
  `openrouter`, so with `pricing.strict` on a call through the first three presets throws
  `AI_TOKENS_PRICE_NOT_FOUND` until the host adds a price (the `openrouter` preset rates from the
  provider-reported cost), and shows a minimal `upsertPrice` call.

## [1.1.3] - 2026-10-31

**Billing:** if you set prices with `upsertPrice` for a model the snapshot also prices while
`pricing.seedFromSnapshot` was on, a restart of an earlier version could replace them with the
snapshot. Run the two queries under the seed entry below to look for affected rows.

### Fixed

- **`forRootAsync({ useFactory })` accepts a factory with typed parameters.** The declared
  signature `(...args: unknown[]) => ...` rejected the form Nest code normally writes,
  `useFactory: (config: ConfigService) => ...`, so every consumer had to take `unknown` and cast.
  The member is now declared with method syntax, which makes its parameters bivariant, and the
  variadic form still compiles. No runtime change.

  **Apply:** no action required. A cast such as `(prisma: unknown) => ... prisma as PrismaService`
  can be replaced by a typed parameter.

- **A disabled wallet, budget or guard service no longer injects as `null` with `forRootAsync`.**
  `forRootAsync` resolves its options after the providers are declared, so it registers
  `WalletService`, `BudgetService` and `BudgetGuard` even when the options leave them out, and it
  used to inject `null`: a consumer got `TypeError: Cannot read properties of null` at its first
  call, with a type that said `WalletService`. It now injects a stand-in whose methods throw
  `AI_TOKENS_INVALID_CONFIG`; the reason names the missing options block, `wallets` or
  `budgets`. The stand-in is an instance of the service's class. `forRoot` is unchanged: it does not register a disabled service.

  **Apply:** code that tested the injected service for `null` to detect a disabled feature must
  check its own options instead.

- **`AI_TOKENS_NOT_CONFIGURED` is documented as reserved.** Nest finishes resolving the async
  options before it builds any service, so nothing raises it.

- **A restart no longer reverts prices the host set, and the snapshot seed no longer adds rows.**
  With `pricing.seedFromSnapshot` on (the default), every boot re-ran each seed row through
  `upsertPrice`, which closes the open row of that model and inserts a new one. A second boot
  against a seeded database added one closed zero-length row and one new open row per seed row
  (34 rows after two boots, 17 closed), and a rate the host had set with `upsertPrice` was
  closed before its own start date while the snapshot row became the open row again, so the
  snapshot price silently replaced the host's price on every restart. The seed now inserts
  only the model, operation and tier combinations that have no row at all, in one transaction
  under a per-combination `pg_advisory_xact_lock`, and never touches existing history. The
  session-scoped `pg_try_advisory_lock` the seed used is no longer taken: a session lock stays
  held until its connection closes, so whether a boot seeded depended on which old connections
  were still alive. `PrismaAiTokensStore.acquireSeedLock` stays for compatibility and is
  deprecated. `IPricingStore` gains the optional method `seedPrice`; a custom store without it
  is seeded from `getPriceHistory` and `upsertPrice`, which is not atomic across replicas.

  **Apply:** a 1.1.x database may hold duplicated zero-length rows and reverted overrides. Find
  them with the queries below; deleting or re-entering rows is your call, nothing here changes
  data.

  ```sql
  -- Rows the old seed closed at the instant they began (one per extra boot).
  SELECT "provider", "model", "operation", "serviceTier", COUNT(*) AS "rows"
  FROM "ai_model_prices"
  WHERE "effectiveTo" = "effectiveFrom"
  GROUP BY 1, 2, 3, 4;

  -- Rows closed before their own start: a price set with upsertPrice that a later boot reverted.
  SELECT "provider", "model", "operation", "serviceTier", "inputNanoUsdPerMillion",
         "effectiveFrom", "effectiveTo"
  FROM "ai_model_prices"
  WHERE "effectiveTo" < "effectiveFrom";
  ```

  A row from the second query is a rate you set; re-enter it with `upsertPrice` at its original
  `effectiveFrom`.

### Added

- `ChainVerification`, the result of `LedgerService.verifyChain`, is exported by name from the
  package root (a type only).

### Documentation

- **The README says how to create the tables and what the public API is.** The SQL migration and
  the Prisma schema fragment ship in the package under `dist/prisma/` but were not mentioned; the
  setup section now names both. The API reference lists the decorators (including `@AiFeature`),
  the money and ledger helpers, the catalogs, the injection tokens and `CounterValueOutOfRangeError`.
  The `budgets.defaultPolicy` Type column read `'block' | 'alert'`; the type is
  `'block' | 'throttle' | 'allow'`. The content sidecar section states that the library ships no
  `IContentStore` implementation or table, and the configuration section describes the
  `forRootAsync` and `forRoot` behaviour for a disabled wallet or budget block. The 1.0.0 entries
  that named an `OtelTelemetrySink` and a six-step resolution chain were corrected to the code.

- **The README now matches the code.** The configuration table gave the wrong default for
  `pricing.seedFromSnapshot` (`true`, not `false`), `budgets.defaultPolicy` (`'block'`, not
  `'alert'`) and `holds.ttlSeconds` (`3600`, not `300`), and gave no default for
  `wallets.creditRateNanoUsd` (`1_000_000_000n`). It told readers to pass an
  `OtelTelemetrySink` that the library does not ship; the option is `telemetry.sink`, which
  takes your own `ITelemetrySink`, next to `telemetry.metrics`. The Bedrock preset is
  `providerPresets.bedrock`, not `providerPresets.bedrockConverse`. The artifact-size table,
  the stack list (it named a `ConfigurableModuleBuilder` the module does not use) and the
  `AI_TOKENS_PRICE_NOT_FOUND` description (it counted resolution steps) were corrected too.
- **The README examples compile.** Some examples called methods or read fields that do not
  exist: `wallets.getOrCreate` (the method is `getBalance`, and it returns `nanoUsd` and
  `credits`), `metering.summarize` (it is `UsageReportService.summarize`), `reports.export`
  with a `format` property (the format is the second argument), and a markup policy typed on
  `MeteringContext` (its `resolve` takes the narrower call context).

## [1.1.2] - 2026-10-30

### Fixed

- **`PricingService.resolveRate` no longer serves one request's price to another.** The
  resolution cache key joined provider, model, baseModel, operation, tier and time bucket
  with `|`, which can also appear inside a model id. Two different requests could spell the
  same key — `model: 'b|c'` with no `baseModel` against `model: 'b'` with `baseModel: 'c|'` —
  and the second received the first's rate from the cache. The key is now a JSON array of
  the fields, so no value can move the boundary between them. (#117)

  **Apply:** no action required. Requests whose model names contain `|` now resolve their
  own price instead of a colliding entry's.

### Security

- Advisories on transitive **dev** packages are cleared through `pnpm-workspace.yaml`
  overrides: body-parser, multer, qs and zod (#115). deepmerge GHSA-gcqx-w48m-w2h4 has no
  patched release and is reached only through `jest-config`, so it is ignored in
  `osv-scanner.toml` until 2027-01-27. None of these reach a consumer install: the package
  has no runtime dependencies.

### Documentation

- `SECURITY.md`: only the latest minor line (1.1.x) receives security fixes; 1.0.x is
  unsupported and consumers should upgrade.

## [1.1.1] - 2026-10-23

### Fixed

- **A failed expired-hold scan no longer crashes the process.** `HoldReaper` read the
  expired holds outside any `try`, and its interval callback discarded the promise
  `sweep()` returned. A database error during that read — a failover or a dropped
  connection — became an unhandled rejection, which terminates Node in every process that
  loads the module. The scan is now guarded: a failure is logged once under the stable key
  `ai_tokens.hold_reaper.scan_failed` with the error's `name`, `message` and string/number
  `code` only, and the sweep ends; the next tick retries. Every timer-driven sweep also
  carries a `catch` (logged as `ai_tokens.hold_reaper.sweep_failed`), so no rejection from
  `sweep()` can escape the interval. Per-hold isolation, the multi-replica claim, `unref()`
  and shutdown are unchanged. (#108)

  **Apply to a derived backend:** a consumer that wrapped its store's `findExpiredHolds`
  in a local guard (catching the error and returning `[]`) to survive this can drop that
  guard once it runs 1.1.1. The reaper now absorbs and logs the failure itself.

### Security

- Advisories on transitive **dev** packages are cleared through `pnpm-workspace.yaml`
  overrides: handlebars, proxy-addr, multer, undici, @grpc/grpc-js, fast-uri, js-yaml and
  brace-expansion (#109); fast-uri and qs (#87); browserslist and mysql2 (#85);
  deepmerge-ts (#80). osv-scanner reports no issues on the lockfile. None of these reach a
  consumer install: the package has no runtime dependencies.

### Changed

- The budget counter-key construction moved to its own module, and its injectivity is
  now asserted in tests: the keys are built from a caller-supplied `budgetId` and a
  caller-chosen timestamp, and the specs fail if a field is reordered or a delimiter
  changes. `COUNTER_DIMENSIONS` is the single runtime list the dimension type derives
  from. No exported type or value changed. (#91)
- Dev dependencies and CI actions updated (#79, #83, #111, and the pinned-action bumps). The
  mutation gate now runs every spec rather than only Jest's related tests, which had silently
  dropped specs reaching the code through helpers under `test/` (#112).
- Published artifact: every `.d.ts` is byte-identical to 1.1.0, and so are the `shared`,
  `prisma`, `redis` and `prices` bundles. Only the `server` bundle changed, from 38,204 to
  38,417 B brotli, inside its 40,000 B budget.

## [1.1.0] - 2026-08-11

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

Remediation of a local audit's settlement findings (merged in #65). No API changes.

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
- **Versioned effective-dated pricing** — `PricingService` with a model-resolution chain (exact, `baseModel`, alias map, normalized id, longest prefix), in-memory TTL cache, `upsertPrice()`, and idempotent `MODEL_PRICES_SEED` snapshot seed. Rates are bigint nano-USD per million tokens; past records are never re-rated.
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
- **OpenTelemetry** — The `ITelemetrySink` port, which you implement over `@opentelemetry/api` (optional peer); the library ships no sink and imports nothing from `@opentelemetry/api`.
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
[1.1.0]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.4...v1.1.0
[1.1.2]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.1...v1.1.2
[1.1.3]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.2...v1.1.3
[1.1.4]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.3...v1.1.4
[1.1.1]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.0...v1.1.1
[1.0.4]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.2...v1.0.3
[Unreleased]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.4...HEAD
