# AGENTS.md — @bymax-one/nest-ai-tokens Architecture

Deep-dive for AI agents and engineers working on this library. Read CLAUDE.md first for the critical rules; this file covers the architecture.

---

## Module wiring

`BymaxAiTokensModule.forRootAsync(options)` is a global dynamic module. On bootstrap it:

1. Validates `BymaxAiTokensModuleOptions` (throws `AI_TOKENS_INVALID_CONFIG` on bad options).
2. Applies defaults (`applyDefaults()` in `server/config/`).
3. Wires services: `PricingService` → `LedgerService` → `MarkupResolver` → `MeteringService` (+ `WalletService`, `BudgetService`, `UsageReportService`, `ContentCapture`, `TelemetryEmitter`).
4. Registers `EventDispatcher` and `HoldReaper` as lifecycle-aware providers.
5. Exports all public services + constants + DI tokens as module exports (so other modules can inject them without re-importing the root module).

`PricingService.onModuleInit()` seeds the price registry from `MODEL_PRICES_SEED` when `pricing.seedFromSnapshot: true`.

`EventDispatcher.onModuleInit()` lazily discovers the optional `@nestjs/event-emitter` instance via `ModuleRef` — the emitter is absent without error when the peer is not installed.

`HoldReaper` sweeps expired holds on the configurable interval (`holds.sweepIntervalSeconds`, default 60 s) starting from `onApplicationBootstrap()` and stopping at `onApplicationShutdown()`.

---

## Rating flow

### Rate-table mode (default)

```
raw response usage
       ↓
  normalizer  (provider-specific pure function → NormalizedUsage)
       ↓
  PricingService.resolveRate()  (§6.6 six-step chain: exact → tier-wildcard → canonical-alias → modelId-normalize → prefix-match → not-found)
       ↓
  computeCostNanoUsd(usage, rate)  (bigint nano-USD, token + surcharge breakdown)
       ↓
  MarkupResolver.resolve()  (fixed multiplier or IMarkupPolicy)
       ↓
  applyMarkup(rawCostNanoUsd, multiplier)  (→ billedCostNanoUsd, persisted as Decimal(20,0))
       ↓
  LedgerService.append()  (idempotency + hash-chain + DB write)
```

### Provider-reported mode

When `ratingMode: 'provider-reported'`, `NormalizedUsage.providerReportedCostNanoUsd` is used directly as `rawCostNanoUsd`. Markup still applies. The price registry is not consulted. This mode is primarily for OpenRouter where the upstream cost is available.

---

## Hold lifecycle (spend reservation)

```
hold(ctx, estimate)
  → PENDING record in ledger (excluded from hash chain and spend aggregates)
  → Optional wallet reserve (balance − estimate.amountNanoUsd)
  → Optional budget counter increment (Redis or DB)
  → Returns Hold { holdId, tenantId, ... }

capture(hold, usage | collector)
  → Resolve NormalizedUsage from the collector if needed
  → Rate the actual usage
  → Transition PENDING → POSTED with actual amounts
  → Wallet debit = actual billedCostNanoUsd (not the estimate)
  → Budget counter adjust (delta = actual − estimate)
  → IDEMPOTENT: a second capture returns the already-settled record

release(hold)
  → Transition PENDING → RELEASED
  → Restore wallet reserve
  → Release budget counter (decrement by estimate)
  → Emits ai_tokens.hold.released

HoldReaper (periodic sweep)
  → Queries PENDING records older than holds.ttlSeconds
  → Runs the same restoration path as release()
  → Emits ai_tokens.hold.released with { expired: true }
```

---

## Enforcement ports

### BudgetGuard (CanActivate)

Runs BEFORE the handler. Steps:
1. Read `@RequireBudget` / `@Meter` / `@AiFeature` metadata via `Reflector`.
2. Call `scopeResolver(ctx)` to get the `MeteringContext` (TRUSTED INPUT — from verified auth).
3. Call `BudgetService.getStatus()` to check all matching budgets.
4. If any HARD budget is `exhausted` → throw `AI_TOKENS_BUDGET_EXCEEDED` or `AI_TOKENS_QUOTA_EXCEEDED`.
5. Enrich `request.aiTokens = { status, context, hold? }`.
6. If `@RequireBudget.estimate` → call `metering.hold()` and attach the `Hold` to `request.aiTokens.hold`.

The guard is **check-only** (no consumption) unless `estimate` is present. The §10.8 atomic consume still protects the actual charge at record/capture time.

### MeteringInterceptor (NestInterceptor)

Runs AFTER the handler. Steps:
1. Read `@Meter` metadata.
2. Extract usage from the handler's return value (via `Meter.extract`, default `result.usage`).
3. If a hold is on `request.aiTokens.hold` → call `metering.capture(hold, usage)`.
4. Otherwise → call `metering.record({ usage, context, enforce: meter.enforcing })`.
5. Optionally set `X-AI-Tokens-*` response headers (`exposeHeaders: true`).

---

## Streaming capture (StreamUsageCollector)

Accumulates chunks by feeding each SSE chunk to `collector.push(chunk)`. At `collector.finalize()`:
- If a final usage chunk was seen → return the normalized provider usage.
- If no final chunk (aborted) → tokenize the accumulated output text and return estimated counts.
- If neither → throw `AI_TOKENS_STREAM_USAGE_MISSING`.

Pass a `StreamUsageCollector` instance directly to `capture()` instead of a resolved `NormalizedUsage` — the metering service calls `finalize()` internally.

---

## Event system

Two composable channels (spec §12.1):

1. **`@nestjs/event-emitter` bridge** — lazy: discovered at `onModuleInit`. Absent = silent no-op.
2. **`IEventSink` port** — injected via `events.sink` in module options. Failures are logged, never thrown.

`EventDispatcher` multiplexes all domain events to both channels. Domain hooks (`createMeteringEventHooks`, `createBudgetEventHooks`, `createWalletEventHooks`) are plain function objects injected into services — no direct EventEmitter dependency in service code.

---

## Telemetry

`ITelemetrySink` is injected via `telemetry.sink`. The library ships `OtelTelemetrySink` (wraps `@opentelemetry/api`) and `NoOpTelemetrySink`. Every `meter()` / `record()` / `hold()` / `capture()` / `release()` creates a span. Missing peer → automatic no-op.

---

## Testing strategy

- **Unit:** Jest, 100% line/branch per implemented file (655 tests). Pure functions tested with `fast-check` property tests (money math, markup composition, normalizer invariants). Services tested with in-memory fakes implementing the storage ports.
- **E2E:** Testcontainers (PostgreSQL 16 + Redis 7). 10 scenarios: record/hold/capture/release, streaming, wallets, budgets, reporting, multi-tenant isolation. One `GenericContainer` set at a time — never concurrent.
- **Mutation:** Stryker (break 95). Critical paths: cost engine, model resolution, ledger state machine, conditional debit/consume, window anchoring.

---

## File layout

```
src/
  prices/          MODEL_PRICES_SEED (data-only, ./prices subpath)
  prisma/          PrismaAiTokensStore + SQL helpers (./prisma subpath)
  redis/           RedisBudgetCounterStore (./redis subpath)
  server/          NestJS module + services + enforcement (. subpath)
    bymax-ai-tokens.module.ts    Root dynamic module
    bymax-ai-tokens.constants.ts DI token symbols
    config/          Option validation + defaults
    enforcement/     BudgetGuard, MeteringInterceptor, decorators, HoldReaper
    errors/          AiTokensException + error code/message/status maps
    events/          EventDispatcher + EventEmitter bridge
    interfaces/      Port interfaces (IAiTokensStore, ILedgerStore, ...)
    services/        PricingService, LedgerService, WalletService, BudgetService,
                     MeteringService, UsageReportService, MarkupResolver, ContentCapture
    streaming/       StreamUsageCollector
    telemetry/       OtelTelemetrySink, NoOpTelemetrySink
    utils/           hash-chain, model-id, payload-hash, scope-wallet, to-json-safe, window-anchor
  shared/          Zero-dep layer (./shared subpath)
    constants/       PROVIDER_IDS, AI_OPERATIONS, SERVICE_TIERS, ...
    normalizers/     9 provider normalizers (pure functions)
    pricing/         computeCostNanoUsd, applyMarkup, money utilities
    types/           Canonical TypeScript types (NormalizedUsage, UsageRecord, Budget, ...)
    utils/           deriveIdempotencyKey, sha256Hex
test/
  contracts/       Port contract tests (any adapter must pass)
  docs-fixtures/   Type-check-only fixtures for JSDoc @example blocks and README samples
  e2e/             Testcontainers end-to-end scenarios
  fakes/           In-memory store implementations for unit tests
```

---

## DI tokens

| Token | Resolves to |
|---|---|
| `BYMAX_AI_TOKENS_OPTIONS` | `ResolvedAiTokensOptions` |
| `BYMAX_AI_TOKENS_LEDGER_STORE` | `ILedgerStore` |
| `BYMAX_AI_TOKENS_PRICING_STORE` | `IPricingStore` |
| `BYMAX_AI_TOKENS_WALLET_STORE` | `IWalletStore` |
| `BYMAX_AI_TOKENS_BUDGET_STORE` | `IBudgetStore` |
| `BYMAX_AI_TOKENS_BUDGET_COUNTER` | `IBudgetCounterStore` |
| `BYMAX_AI_TOKENS_TOKENIZER` | `ITokenizer` |
| `BYMAX_AI_TOKENS_TELEMETRY` | `ITelemetrySink` |
| `BYMAX_AI_TOKENS_EVENT_SINK` | `IEventSink` |
| `BYMAX_AI_TOKENS_CONTENT_STORE` | `IContentStore` |
| `BYMAX_AI_TOKENS_LOGGER` | `LoggerService` |

---

## Reference

Full spec: `docs/technical_specification.md`  
Critical rules: `CLAUDE.md`  
Security threat model: `SECURITY.md`

<!-- shared:begin -->
<!--
  CANONICAL COPY: bymaxone/.github → agents/code-review-rules.md
  Do not edit this block in a consuming repository. It is replaced wholesale by
  the `agents-sync` reusable workflow, so a local edit is reverted on the next
  run. Change it here, cut a release, and every repository is offered the update.

  Repository-specific rules go OUTSIDE this block, below the closing marker.

  FOR WHOEVER EDITS THIS FILE, not for the reviewer who reads it:

  Codex reads one AGENTS.md per directory, root to nested, within
  project_doc_max_bytes (32 KiB default). Never name a template or fixture
  AGENTS.md below the root: a change under it is read as the repo's guidance.

  This block is charged against every consumer's budget. A rule added here must
  be worth the bytes in the smallest-headroom repository, not only in this one;
  agents-sync reports each consumer's headroom and fails when it is exceeded.

  When you scope a rule, scope every rule in its paragraph or split the
  paragraph -- an unscoped neighbour reads as deliberate.
-->

These rules hold in every Bymax repository. What is specific to this one is written after this
block, and the two are read together.

The pipeline already enforces formatting, linting, dependency policy, coverage and — where the
repository has one — the mutation gate. Do not spend a review on a **violation** of one of those: it
is a red check, not a comment. What follows is what CI cannot see.

A violation of a rule in this block is reported at **P1** at minimum. Codex surfaces only P0 and P1
on a pull request, so a rule whose violations land at P2 is a rule nobody sees.

**When a rule moves from here into a check, it leaves here.** A red check is proportionate to a
correctness failure that is invisible without it, and disproportionate to style enforced at an
inconvenient moment. Never carry both: a rule stated here _and_ enforced by CI spends a reviewer's
attention on what a gate already reports.

**A change to the enforcing configuration is the opposite case, and it is in scope.** Every gate runs
the configuration from the branch under review — that branch's lint config, its coverage thresholds,
its mutation thresholds. So a pull request that deletes a rule, lowers a threshold or widens an
ignore glob turns the check **green**, because a gate reports on the rules it was handed. For those
diffs the review is the only independent check there is, and a weakened gate needs the same
justification a suppression does.

### A finding names what it read

Every factual claim in a review — about a library's API, about this repository's history, about what
a file contains — has to come from something read in the tree under review, and the finding should
say which. A claim assembled from recollection is likely to describe a previous version of whatever
it is about.

**Safe path**, by the kind of claim:

| Claim about                             | Read this                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| A library's API **shape**               | `node_modules/<pkg>/dist/**/*.d.ts` in this tree                               |
| A library's **runtime behaviour**       | that version's changelog entry, its documentation, or a test that exercises it |
| A commit's author or committer identity | out of scope: it is not text a change introduces                               |
| What a file contains                    | the file at the revision under review, not an earlier one                      |

The first two rows are separate on purpose, and the rule below says why: a field can stay optional
in the published type while becoming mandatory in behaviour. A `.d.ts` settles what a signature
accepts and nothing about what the implementation does with it, so a behavioural claim resting on
one is unfounded.

Weight the checking by what acting on the finding would cost. A comment that asks for a reworded
sentence is cheap to be wrong about; one that asks for history to be rewritten, a merge reverted, or
a release pulled is not — verify that class before raising it, and raise it at the severity the
evidence supports rather than the severity the consequence would deserve if true.

### A dependency upgrade migrates every call site, not only the ones that fail to compile

When an upgrade tightens a contract, the compiler catches only the call sites whose **shape**
changed. A field that stays optional in the published type while becoming mandatory in behaviour
compiles, passes the unit suite, and fails in production.

A `@bymax-one/*` version number carries **no compatibility information** while the libraries are
pre-stable: breaking changes ship in minor and patch releases by explicit policy, so `^` and `~`
protect against nothing. The migration note under **Apply to a derived backend** in the library's own
changelog is the compatibility contract.

**Safe path:** read **every** changelog entry from the version being replaced up to the proposed
one, not only the proposed one's, and check every call site they name — not only the ones the
compiler rejected. Upgrades routinely skip releases, and the entry that matters is often not the
last one: adopting `@bymax-one/nest-cache` 1.1.0 → 1.2.1 skipped 1.2.0, where a namespace-validation
security fix lives; 1.2.1's own entry is a field rename. Diff the `.d.ts` of the **previously adopted** version against
the **proposed** one — `npm pack` both, and name the two versions. Reaching for "the installed
declarations" is the trap: in a checkout of the branch under review the installed tree is already
the new version, so that diff compares a release with itself and shows nothing.

### Settled decisions are not review findings

Both are settled deliberately, and reopening either costs a round trip and changes nothing:

- **Do not propose a major version bump** for a breaking change in a `@bymax-one/*` library, and do
  not assert that this ecosystem follows strict SemVer. Until an API is declared stable, breaking
  changes ship in minor and patch releases; the migration note carries the compatibility information
  the number does not. If a document claims strict SemVer, the finding is that the claim is wrong —
  not that the version should be raised.
- **Do not propose pinning `bymaxone/.github` reusable workflows to a commit SHA.** They are
  referenced by the `@v1` alias on purpose: a fix has to land once and reach every repository, the
  tag is immutable and the alias moves only on a release, and pinning was measured to cost ~58
  dependency pull requests to propagate one change. Third-party actions are the opposite case and
  **are** pinned by SHA.

**Safe path:** if you believe a settled decision is now wrong, say so as a question in the pull
request rather than as a finding.

### Suppressions are refusals, not exceptions

`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable` in any form,
`as unknown as` laundering a real type error, `istanbul ignore`, and in Rust `#[allow(...)]` over a
lint gate or `unsafe` without a `// SAFETY:` comment are blocking findings.

Anything a configured gate already reports belongs to the gate, not to a review: where a repository
lints `no-explicit-any` as an error — most do — an `as any` is a red check, and raising it here only
duplicates it. Check the repository's lint configuration before reporting a suppression rather than
assuming the list is exhaustive in either direction.

A failing gate means the code is wrong, the type is wrong, or the rule is wrong. **Safe path:** fix
whichever it is. Changing a rule's configuration with a stated reason is legitimate; scattering
per-call-site silencers is not.

### Comments state constraints, never history

A comment must read as true for whoever opens the file next. Flag any comment that narrates what a
previous version did, names a phase, task, ticket or review round, or explains a change rather than
the code. **Safe path:** state the constraint that still holds, and let `git log` carry the history.

Evidence for a constraint is not history, and how the evidence was obtained does not decide which it
is. The test is whether the fact still binds the next reader. A measurement that predicts what they
will hit if they take the other path — what the alternative did when it was tried, what the cost is
in numbers — belongs beside the constraint it supports, whether it came from a deliberate trial or
from something breaking. What ages is the part that cannot recur for them: what a previous version
of this code did, a version number, a registry state, a review round, a failure that has since been
fixed. Flag those; keep the measurement.

### Size and layering

Functions over **50 lines** and nesting deeper than four levels are findings **for what a change
introduces** — a new function, or a change that pushes an existing one past the limit — in the
repository's own source and test directories. A test-suite grouping construct (`describe`, `context`,
`mod tests`, a table of cases) is not a function; the unit under the limit is the body of a single
`it`/`test`/`#[test]`. On the same terms, every non-trivial source file a change introduces opens
with a header stating its purpose and its layer, and every exported symbol a change introduces
carries a doc comment.

**The 800-line file limit applies to what a change introduces, not to what it inherits.** A
repository that already carries a file past the line — a generator, a long end-to-end suite — would
otherwise produce a finding on every pull request touching three lines of it, which the author
cannot act on and did not cause. Raise it for a **new** file over the limit, or when a change pushes
a file past it or materially grows one already over.

Markdown, generated output and lockfiles are **out of scope**: a changelog is an append-only log that
only grows, a lockfile is generated, and neither has layers. Reporting their length is a false
positive on every dependency bump and every release note.

**Safe path:** extract by responsibility rather than by line count — the limit is a symptom, and one
file doing two jobs is the defect.

### Language and attribution

Everything published is English — source, comments, tests, commit messages, pull request titles and
bodies, `README.md`, `CHANGELOG.md` and everything under `.github/`.

Each repository states its language policy for `docs/` below this block. Report a language finding in
`docs/` only against what the repository states; where it states nothing, `docs/` is English like
everything else. A `docs/` language other than English is a repository-owner decision recorded in the
narrowings, not a convention a contributor may introduce.

No commit, pull request, comment or code may attribute authorship to an AI assistant or coding tool,
in any form. **Only text the change introduces is in scope** — a trailer, a "generated with" line, a
signature in a comment or a description.

A commit's author and committer fields are not that: they come from the contributor's git
configuration rather than from the diff, and a review reading the diff cannot see them. Never report
an identity field, and never present a command's reconstructed output as evidence for one. Measured:
eight P1 findings in a single day across four pull requests, each naming a commit SHA that does not
exist in the repository it was reported against and quoting `git log` output no review had run. What
each one asked for was a force-push rewriting published history.

<!-- shared:end -->

## Where this repository narrows a shared rule

Only the rules a reviewer gets wrong **here**. Each is a narrowing of the block above, not a
disagreement with it.

### `scopeResolver` is trusted input — the shared rule about validating input inverts here

The shared block treats unvalidated input at a boundary as a finding. `scopeResolver` is the
exception that proves it: it MUST read from the host's verified auth context (JWT claims, a
validated session) and MUST NEVER read `request.body` or `request.query`. So the finding is not
"this input is unvalidated" — it is **"this identity was accepted rather than resolved"**.

**Safe path:** on any diff touching `BudgetGuard` or `MeteringInterceptor`, follow `scopeResolver`
to where the host supplies it. A `tenantId` reaching a budget decision from anything the caller can
influence is the defect, and it is worth a P1 even when every field is type-checked — the types are
not the control.

### Money is `bigint` nano-USD, so the usual numeric-precision advice is inverted

`parseFloat`, `toFixed`, and arithmetic on `number` are defects on money paths, not style. The only
sanctioned conversions are `floatUsdToNanoUsd` at provider ingress and `formatNanoUsd` /
`toJsonSafe` at display and JSON egress. A reviewer used to "avoid floating point where it matters"
will accept a `number` that round-trips correctly in a test; it is still a defect, because the
ledger is hash-chained and a value that differs by one nano breaks the chain rather than rounding.

### `limit = 0` and "no budget row" are opposite, not equivalent

No row means unlimited. `limit = 0` is a hard block. A diff that coalesces `null`/`undefined` to
`0` — the ordinary defensive move, and one a reviewer normally approves — converts "unlimited" into
"blocks every call". Treat any `?? 0` or `|| 0` on a limit as a finding until proven otherwise.

### `capture()` is idempotent by contract — a guard at the call site is the bug

Calling `capture(hold, usage)` twice settles with the first actuals and returns the already-settled
record. A caller that adds a "have we captured this already?" check is not being careful, it is
duplicating a guarantee and creating a second source of truth. The shared block's rule against
swallowing errors does not license the defensive check here.
