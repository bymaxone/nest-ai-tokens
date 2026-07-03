# Development Plan — @bymax-one/nest-ai-tokens

> **Version:** 1.0.0
> **Last updated:** 2026-07-02
> **Status:** Draft for execution
> **Reference spec:** [`docs/technical_specification.md`](./technical_specification.md) (v0.2.0, post-audit)
> **Persistence targets:** Prisma ≥ 6 / PostgreSQL (official store), ioredis ^5 (optional budget counter)
> **Derived documents:** `docs/tasks/phase-NN-<slug>.md` (Layer 3 — one file per phase, generated from this plan via `/bymax-workflow:phase-tasks`) + `docs/tasks/README.md` (folder index)

---

## Table of Contents

1. [Plan Overview](#1-plan-overview)
2. [Phase 1 — Foundation + Shared Core + Pricing](#2-phase-1--foundation--shared-core--pricing)
3. [Phase 2 — Ledger + Markup + Events + Prisma Store](#3-phase-2--ledger--markup--events--prisma-store)
4. [Phase 3 — Wallets + Budgets + Enforcement](#4-phase-3--wallets--budgets--enforcement)
5. [Phase 4 — Metering Lifecycle + Streaming + Telemetry + Reporting + E2E](#5-phase-4--metering-lifecycle--streaming--telemetry--reporting--e2e)
6. [Phase 5 — Release v0.1.0](#6-phase-5--release-v010)
7. [Appendix A — Dependency Graph](#appendix-a--dependency-graph)
8. [Appendix B — Complexity Matrix](#appendix-b--complexity-matrix)
9. [Appendix C — Reference Configs (mirror of nest-storage)](#appendix-c--reference-configs-mirror-of-nest-storage)
10. [Appendix D — Glossary and Term Mapping](#appendix-d--glossary-and-term-mapping)

---

## 1. Plan Overview

### 1.1 Development strategy

The implementation follows the **TDD red-green-refactor** protocol with vertically sliced phases:

- Each phase delivers **usable functionality** (not just "ready code") — at the end of each phase, the lib can be installed in a NestJS fixture app and exercised (Phase 1: rate any provider usage to an exact nano-USD cost; Phase 2: write idempotent marked-up ledger records to Postgres; Phase 3: enforce wallet/budget limits race-safely; Phase 4: full hold→capture lifecycle incl. streaming; Phase 5: published package).
- **Tests precede implementation** in every file with non-trivial logic (normalizers, cost engine, services, guard/interceptor, store adapters).
- **Money math is property-tested**: `fast-check` suites assert no drift across large accumulations, exact markup/tier/surcharge composition, and normalizer reconciliation invariants (spec §5.5) against generated provider payloads.
- **Per-phase coverage gate:** **100% line/branch on every file implemented in the phase** (Bymax lib floor), with extra mutation focus on critical paths (cost engine, model resolution, ledger state machine, conditional debit/consume, window anchoring). The published artifact is gated at 100% global by `jest.coverage.config.ts` (`prepublishOnly`).
- **Mutation testing** runs as a **pre-release gate** only (Stryker takes 10–20 min); release gate is mutation score **≥ 95% (break 95)**.
- **Refactor pass** at the end of each phase, with `/bymax-quality:code-review` + `/security-review` before marking the phase as done.
- **Real E2E (Testcontainers + PostgreSQL, plus Redis for the counter)** kicks in at Phase 4 — before that, the store ports are exercised with in-memory fakes and the Prisma adapter with mocked `PrismaClient` (Phase 2 adds a thin Testcontainers smoke for migrations only).

The phase order respects the dependency graph (Appendix A): shared types before normalizers, pricing before the ledger (records reference price versions), ledger before wallets/budgets (both hang off usage records), all three before the hold→capture lifecycle, everything before release.

### 1.2 Guiding principles

| Principle | Practical application |
|---|---|
| **TS strict, zero `any`** | Compiler in `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Provider `usage` objects enter as `unknown` and are narrowed by normalizers — never cast. |
| **Money is an integer** | Every persisted monetary value is bigint nano-USD (spec §7.1, §7.4). No `number` arithmetic on money anywhere; `fast-check` guards it. |
| **Normalizer-first, zero provider SDKs** | No provider SDK peer deps at all (spec §18.1). Normalizers are pure functions over plain objects; reconciliation invariants (spec §5.5) are hard test requirements. |
| **Point-in-time pricing** | Rates resolved by `(provider, model, operation, serviceTier, occurredAt)` via the §6.6 resolution chain. Past records are never re-rated. |
| **Append-only ledger** | No `UPDATE`/`DELETE` of posted amounts; corrections are compensating records (spec §8.5); the only permitted post-posting mutation is the `reversedByRecordId` annotation. |
| **Exactly-once accounting** | Content-derived idempotency keys + payload-hash replay detection (spec §8.4). Every example and fixture passes a key. |
| **JSDoc on every exported symbol** | Every `export` carries JSDoc with `@example` where applicable; every file has `@fileoverview` + `@layer`. |
| **English in code and comments** | Identifiers, messages, comments, JSDoc, docs — all in English. |
| **Zero `dependencies`** | `package.json` ships `"dependencies": {}`. Everything via peer dep (only `@nestjs/common`, `@nestjs/core`, `reflect-metadata` required). |
| **PII discipline** | No prompt/completion text in the ledger (spec §14.2). Tests assert the ledger row shape has no text fields. |
| **Fail-closed enforcement** | Budget checks fail closed by default when counter/store degrade (spec §10.8). |
| **Conventional Commits** | `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:` — scope `(ai-tokens)`; no `Co-Authored-By` trailers. |

### 1.3 Status legend

| Symbol | Meaning |
| --- | --- |
| 📋 | ToDo |
| 🔄 | In Progress |
| 👀 | Review |
| ✅ | Done |
| ⛔ | Blocked |
| 🟡 | Partial |

### 1.4 Progress

- **Overall progress:** 🔄 3 / 5 phases done (60%) — 28 / 47 sub-steps
- **Active phase:** Phase 4 — Metering Lifecycle + Streaming + Telemetry + Reporting + E2E
- **Blocked:** none

### 1.5 Phase dashboard

| ID | Phase | Status | Progress | Complexity | Last updated |
| --- | --- | --- | --- | --- | --- |
| 1 | [Foundation + Shared Core + Pricing](./tasks/phase-01-foundation-shared-core-pricing.md) | ✅ Done | 11/11 | MEDIUM | 2026-07-03 |
| 2 | [Ledger + Markup + Events + Prisma Store](./tasks/phase-02-ledger-markup-events-prisma.md) | ✅ Done | 7/7 | HIGH | 2026-07-03 |
| 3 | [Wallets + Budgets + Enforcement](./tasks/phase-03-wallets-budgets-enforcement.md) | ✅ Done | 10/10 | HIGH | 2026-07-03 |
| 4 | [Metering Lifecycle + Streaming + Telemetry + Reporting + E2E](./tasks/phase-04-metering-streaming-telemetry-reporting.md) | 🔄 In Progress | 5/12 | HIGH | 2026-07-03 |
| 5 | [Release v0.1.0](./tasks/phase-05-release.md) | 📋 ToDo | 0/7 | LOW | 2026-07-02 |
| | **Total** | 🔄 **3 / 5 phases** | **28 / 47 sub-steps** | — | — |

> Each phase links to its (future) task file in [`docs/tasks/`](./tasks/) (one file per phase, generated by `/bymax-workflow:phase-tasks`). Per-sub-step detail is in §2–§6; dependency graph in Appendix A, complexity matrix in Appendix B. Task files may expand one sub-step into several executable tasks (§1.9), so task counts in the dashboard are updated when each phase's task file is scaffolded.

> **Phase mapping to spec §19.** The spec's §19 "Implementation Phases" mirrors this exact 5-phase split (P1 Foundation+Normalizers+Pricing · P2 Ledger+Markup+Events+Prisma · P3 Wallets+Budgets+Enforcement · P4 Metering lifecycle+Streaming+Telemetry+Reporting+E2E · P5 Release). `forRootAsync()` ships in **Phase 4** in both documents; the **hold reaper** is a Phase 4 v0.1 requirement in both.

> **No time estimate** — this plan is intended for execution by AI agents. Duration in human days does not apply. Use the per-phase **Complexity** signal to prioritize more careful human review on HIGH phases (Phase 2 — ledger state machine and idempotency; Phase 3 — race-safe money movement; Phase 4 — hold lifecycle and streaming).

### 1.6 Update protocol

When a phase or sub-step changes state, keep the dashboard consistent:

1. Set the phase row's **Status** emoji + **Last updated** date and bump its **Progress** (`X/Y` sub-steps or tasks) in the §1.5 dashboard.
2. Recompute **Overall progress** (`N / 5` phases + percentage, `M / 47` sub-steps) and update **Active phase** / **Blocked** in §1.4.
3. Mirror the per-task status inside the phase's task file (`docs/tasks/phase-NN-*.md` — task index row + completion log), once that file exists.
4. Never mark a phase ✅ while any §1.7 Done-criteria bullet is unmet — use 🟡 Partial until all are satisfied.
5. If a phase becomes ⛔ Blocked, record the blocker inline under the phase heading and in §1.4.
6. Commit the update with a `docs(plan): …` Conventional Commit (no `Co-Authored-By` trailer).

### 1.7 Global per-phase Done criteria

A phase is only marked **Done** (✅) when, **cumulatively**:

- [ ] `pnpm typecheck` passes without errors
- [ ] `pnpm lint` passes without warnings (no `eslint-disable`, no `@ts-ignore`)
- [ ] `pnpm test:cov` passes with **100% line/branch coverage on every file implemented in the phase** (Bymax lib floor)
- [ ] `pnpm build` produces `dist/` with `.mjs`, `.cjs`, `.d.ts` for every declared subpath (5 subpaths from Phase 1 on)
- [ ] CI is green on the PR (the `ci`/`codeql`/`scorecard` workflows created in Phase 1)
- [ ] All sub-step acceptance criteria checked off
- [ ] JSDoc present on all new exports; every new file has an `@fileoverview` + `@layer` header
- [ ] Clean Code sizing respected (no function > 50 lines, no file > 800 lines)
- [ ] Official docs re-verified (context7) for every library touched this phase (NestJS, Prisma, ioredis, tsup, Stryker, Testcontainers)
- [ ] `git status` clean (commits made with Conventional Commits, no `Co-Authored-By` trailer)
- [ ] `/bymax-quality:code-review` executed and findings applied; `/security-review` clean on money-moving phases (2–4)

> The published artifact is additionally gated at **100% global** coverage by `jest.coverage.config.ts` (run via `prepublishOnly`) and **mutation score ≥ 95% (break 95)** at release. The per-phase 100%-per-file gate above is the development-time floor; both must hold before v0.1.0 ships.

### 1.8 Expected end file structure (after Phase 5)

Mirrors the canonical layout of the sibling libs (`bymax-one/nest-storage`, `bymax-one/nest-queue`); source tree per spec §3.1.

```
nest-ai-tokens/
├── .github/workflows/      # ci.yml, codeql.yml, release.yml, scorecard.yml  (created in Phase 1)
├── docs/
│   ├── technical_specification.md
│   ├── development_plan.md          ← this file
│   ├── tasks/                       ← one file per phase (phase-01-*.md … phase-05-*.md) + README.md
│   ├── mutation_testing_plan.md
│   └── mutation_testing_results.md
├── scripts/check-size.mjs
├── src/server/              # main entry — module, services, enforcement, streaming, events, telemetry, errors, utils
├── src/shared/              # zero deps — normalizers, pure cost math, types, catalogs
├── src/prices/              # data-only — MODEL_PRICES_SEED
├── src/prisma/              # PrismaAiTokensStore + schema.prisma.fragment + migrations/
├── src/redis/               # RedisBudgetCounterStore
├── test/e2e/                # e2e specs with Testcontainers + PostgreSQL (+ Redis)
├── package.json
├── tsup.config.ts
├── tsconfig.json (+ build / server / e2e / jest variants)
├── jest.config.ts (+ coverage / e2e / stryker variants)
├── stryker.config.json
├── eslint.config.mjs
├── README.md / CHANGELOG.md / SECURITY.md / LICENSE / CLAUDE.md / AGENTS.md
```

### 1.9 How this plan feeds `docs/tasks/`

The executable tasks live in [`docs/tasks/`](./tasks/) — **one file per phase** (`phase-NN-<slug>.md`), generated from this plan via `/bymax-workflow:phase-tasks`. Each numbered **sub-step** in this plan (§2.X, §3.X, …) becomes **one or more executable tasks**. The derivation rule:

- Sub-step with **a single file + logic < 100 LoC** → **1 task**
- Sub-step with **multiple related files** → **grouped task** with a per-file checklist
- Sub-step with **logic > 200 LoC** → **task split** into red (test), green (impl), refactor

Each task carries the full self-contained prompt for AI agent execution (Role / PROJECT / CURRENT PHASE / PRECONDITIONS / REQUIRED READING / TASK / DELIVERABLES / Constraints / Verification / Completion Protocol — `/bymax-workflow:phase-tasks` standard). The **canonical phase status lives in the §1.5 dashboard above**; each task's Completion Protocol updates that dashboard and the task file's own index/completion log.

**Required reading for every task of every phase:** the spec sections referenced by the sub-step (this plan cites them per sub-step — the spec is the canonical source of every interface, schema, and normative rule; this plan intentionally does **not** duplicate them), plus `/bymax-workflow:standards`.

### 1.10 Cross-cutting normative rules (bind every phase)

These spec rules apply to multiple phases and MUST be enforced in every task that touches them:

| Rule | Spec | Applies to |
|---|---|---|
| Output-side reconciliation invariant (`totalOutput = outputTokens + reasoningTokens`; OpenAI subtracts, Gemini maps, Anthropic zero) | §5.5 | P1 normalizers, P4 collector |
| All persisted money = nano-USD bigint; FX/presentation only at read time | §7.4 | P2 ledger, P3 wallets/budgets, P4 reporting |
| Markup applies in BOTH rating modes, 4-dp multiplier, truncation-toward-zero division | §7.2 | P1 cost engine, P2 record, P4 capture |
| Ledger state machine: `pending → posted \| released`; `posted → reversed` annotation-only | §8.3, §8.5 | P2 ledger, P4 lifecycle |
| Idempotency: upsert on `(tenantId, idempotencyKey)` + payload-hash replay-or-conflict | §8.4, §15.2 | P2 ledger, P3 wallet entries |
| Budget consumption predicate (enforced ∧ ¬system ∧ feature-match ∧ posted/reversed ∧ in-window) | §10.7 | P3 budgets, P4 capture/reverse, P4 reporting |
| Unlimited = no row/null; `0` = hard block; negatives rejected | §10.2 | P3 budgets |
| All matching budgets across the scope hierarchy are checked and consume independently | §10.3 | P3 budgets, P4 guard |
| `isSystemCost` rows never touch wallet/budget/counter | §11.2 | P2–P4 |
| Side-effect matrix is normative for record/hold/capture/release/reverse | §11.2 | P2–P4 |
| bigint never crosses a JSON boundary raw — `toJsonSafe()` / decimal strings | §15.5 | P2 events, P4 reporting/interceptor |
| Admin-plane mutations emit `ai_tokens.audit` | §14.4 | P2–P4 |

---

## 2. Phase 1 — Foundation + Shared Core + Pricing

> **Phase objective:** Establish the full project scaffold with the four CI workflows, implement the entire zero-dependency `./shared` core (catalogs, types, money utils, all nine normalizers, tier+surcharge-aware cost engine), the `./prices` seed dataset, the error catalog, every port interface, options validation, `PricingService` with the model-resolution chain, and the synchronous `BymaxAiTokensModule.forRoot()`. **At the end of the phase, given any provider's raw `usage` object, the lib produces a correct, exact `rawCostNanoUsd` and `billedCostNanoUsd`** in a NestJS fixture app (no persistence yet — pricing store backed by an in-memory fake).
>
> **Complexity:** MEDIUM (broad but mostly pure functions; no concurrency, no persistence).
>
> **Critical paths for mutation focus:** `shared/pricing/compute-cost.ts`, `shared/pricing/apply-markup.ts`, every `shared/normalizers/*.ts`, `server/utils/model-id.ts`, `server/services/pricing.service.ts`, `server/config/validate-options.ts`.

### 2.1 Project scaffold + CI workflows

**Objective:** Create the folder structure, configuration files, and the four CI workflows (front-loaded so every PR is gated from the first one), mirroring the canonical sibling configs (Appendix C).

**Files to create:** `.github/workflows/{ci,codeql,scorecard,release}.yml`, `.gitignore`, `.prettierrc`, `.npmignore`, `.npmrc`, `eslint.config.mjs`, `jest.config.ts`, `jest.coverage.config.ts`, `jest.e2e.config.ts`, `jest.stryker.config.ts`, `stryker.config.json`, `tsconfig.json` + `tsconfig.{build,server,e2e,jest,eslint}.json`, `tsup.config.ts` (**five entries**: `server`, `shared`, `prices`, `prisma`, `redis`), `package.json`, `scripts/check-size.mjs`, empty `src/{server,shared,prices,prisma,redis}/index.ts` placeholders.

**Key decisions (from spec):** package name/exports/peers per spec §3.2 + §18.2 (`@prisma/client`, `ioredis`, `@nestjs/event-emitter`, `@opentelemetry/api` all optional peers; version `0.1.0-alpha.0` until release); `moduleNameMapper` for the five subpaths; devDeps add `fast-check`, `@testcontainers/postgresql`, `prisma`; size budgets per spec §19.1 (server < 40 KB, shared < 10 KB, prisma < 15 KB, redis < 5 KB brotli; prices exempt).

**Acceptance criteria:**

- [ ] `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass on the empty skeleton
- [ ] `pnpm build` produces `dist/{server,shared,prices,prisma,redis}/index.{mjs,cjs,d.ts}`
- [ ] The four workflows are valid (actionlint) and incremental-safe (`passWithNoTests`); `release.yml` inert until a `v*.*.*` tag
- [ ] `package.json` matches spec §3.2 exports and §18.2 peers exactly; `"dependencies": {}`
- [ ] eslint flat v9 with `strictTypeChecked` + `stylisticTypeChecked` + prettier; zero warnings

**Validation commands:** `pnpm install && pnpm typecheck && pnpm lint && pnpm build && ls dist/*/index.mjs`

**Dependencies:** none — phase entry point.

**Risks/Notes:** five tsup entries (vs 2 in nest-storage) — verify no cross-entry chunk splitting (`splitting: false`); `./prisma` entry must externalize `@prisma/client`; `./redis` externalizes `ioredis`.

### 2.2 Shared catalogs and canonical types

**Objective:** Implement the entire `./shared` type surface — the catalogs and every canonical type the rest of the library consumes.

**Files to create:** `src/shared/constants/{provider-ids,operations,service-tiers,token-categories,wallet-entry-types,error-codes}.constants.ts`, `src/shared/types/{catalogs,normalized-usage,usage-record,price-version,wallet,budget,report,events,error-types}.ts`, `src/shared/index.ts` (barrel).

**Canonical definitions (do not re-derive — copy from spec):** `ProviderId`/`AiOperation`/`ServiceTier`/`RatingMode`/`TokenCategory`/`MeteringScope`/`UsageNormalizer` — spec §5.1; `NormalizedUsage` — §5.2; `UsageRecord`/`UsageStatus` — §8.2; `PriceVersion` — §6.2; `Wallet`/`WalletRef`/`WalletEntry`/`WalletEntryType` — §9.1; `Budget`/`BudgetWindowKind`/`BudgetPolicy`/`BudgetStatus`/`AccessStatus` — §10.1 + §10.6; `LedgerFilter`/`ReportFilter`/`UsageSummary` — §13.1 + §15.1; `AiTokensEvent` + per-event payloads — §12; `AI_TOKENS_ERROR_CODES` — §16.2; `ProviderPreset` — §4.3.

**Acceptance criteria:**

- [ ] Every symbol listed in spec §3.3 "Shared" exists and is exported from the barrel
- [ ] Zero imports of `@nestjs/*`, `@prisma/*`, `ioredis` anywhere under `src/shared/` (grep-verified)
- [ ] Constants `as const`; types via `import type`; `(string & {})` trick on `ProviderId` preserves literal autocomplete
- [ ] `pnpm typecheck` passes; no `any`

**Validation commands:** `pnpm typecheck && grep -rn '@nestjs\|@prisma\|ioredis' src/shared/ ; pnpm build && node -e "import('./dist/shared/index.mjs').then(m => console.log(Object.keys(m).length))"`

**Dependencies:** §2.1.

**Risks/Notes:** `UsageRecord` uses `bigint` fields — the shared barrel must not include any JSON-serialization helper that would drag Node-isms in; `toJsonSafe` lives server-side.

### 2.3 Money and idempotency utilities

**Objective:** The exact-arithmetic foundation: nano-USD bigint helpers, presentation formatting, and the idempotency-key derivation helper.

**Files to create:** `src/shared/pricing/money.ts` (`formatNanoUsd`, per-million multiply helper, float→nano round-half-up conversion for OpenRouter costs), `src/shared/utils/idempotency.ts` (`deriveIdempotencyKey(payload)` — stable canonical-JSON sha256).

**Spec references:** §7.1 (integer math), §7.4 (presentation rule + `formatNanoUsd`), §8.4 (key derivation, host-supplied), §5.3 OpenRouter row (float→nano conversion).

**Acceptance criteria:**

- [ ] `fast-check` property suite: `formatNanoUsd` round-trips against known values; float→nano conversion is round-half-up and exact for costs < $1,000; no `number` intermediate on any money path
- [ ] `deriveIdempotencyKey` is stable under key order (`{a:1,b:2}` ≡ `{b:2,a:1}`), distinct for distinct payloads
- [ ] Pure — works in a browser/edge bundle (no `node:crypto` hard dependency; use WebCrypto-compatible hashing or a pure implementation)

**Validation commands:** `pnpm test -- --testPathPattern='money|idempotency'`

**Dependencies:** §2.2.

**Risks/Notes:** sha256 in zero-dep shared code — either a small pure TS implementation or `globalThis.crypto.subtle` (async); decide once, document in the file header. `deriveIdempotencyKey` may be async if WebCrypto is chosen — the spec's call sites accept that; keep the signature `Promise<string> | string` consistent with the examples (prefer sync pure implementation to match spec §21 usage).

### 2.4 Usage normalizers (all nine)

**Objective:** One pure normalizer per provider shape, each satisfying the input-side and output-side reconciliation invariants.

**Files to create:** `src/shared/normalizers/{openai-chat,openai-responses,openai-compatible,anthropic,gemini,bedrock-converse,mistral,openrouter,vercel-ai-sdk}.normalizer.ts` + `index.ts`.

**Spec references:** §5.2 (`NormalizedUsage`), §5.3 (per-provider field table — the normative mapping, including the OpenAI reasoning **subtraction**, Gemini `thoughtsTokenCount → reasoningTokens` + `toolUsePromptTokenCount → inputTokens`, Anthropic `server_tool_use → serverToolUse` + cache TTL split, Bedrock `cacheDetails` mapping, OpenRouter `cost` → `providerReportedCostNanoUsd`, Vercel AI SDK v5+v6 dual shape), §5.5 (invariants — hard test requirements).

**Acceptance criteria:**

- [ ] Each normalizer has fixture tests with realistic provider payloads (streaming-final and non-streaming variants where shapes differ)
- [ ] Property tests assert both §5.5 invariants per adapter against generated payloads
- [ ] Malformed input throws a plain `Error` with a stable message (the server layer wraps into `AI_TOKENS_USAGE_MALFORMED` — shared code never imports the exception)
- [ ] `serviceTier` read from the response where the provider reports it (OpenAI `service_tier`, Anthropic `usage.service_tier`)
- [ ] Unknown fields preserved in `raw`

**Validation commands:** `pnpm test -- --testPathPattern='normalizers'`

**Dependencies:** §2.2, §2.3 (float→nano for OpenRouter).

**Risks/Notes:** the OpenAI reasoning-subtraction is the audit's #1 billing bug — its test must include a payload where `completion_tokens_details.reasoning_tokens > 0` and assert `outputTokens + reasoningTokens === completion_tokens`. Mistral: map prompt/completion only; extra fields to `raw` (spec §20.3).

### 2.5 Pure cost engine

**Objective:** `computeCostNanoUsd` (tier + surcharge aware) and `applyMarkup` (4-dp exact).

**Files to create:** `src/shared/pricing/compute-cost.ts`, `src/shared/pricing/apply-markup.ts`.

**Spec references:** §7.1 (the reference implementation — including all-or-nothing long-context tier and `unitRates` surcharge loop; token part and surcharge part separately retrievable), §7.2 (`applyMarkup` signature, validation, rounding rule).

**Acceptance criteria:**

- [ ] Worked examples from spec §7.1 pass exactly (1,000 Opus input tokens → 5_000_000n)
- [ ] Tier boundary tests: at, below, and above `tierThresholdTokens` (threshold counts ALL input-side categories)
- [ ] Surcharge tests: units present in `serverToolUse` but missing from `unitRates` are ignored (not an error); the reverse too
- [ ] `applyMarkup` property tests: `m=1.0` is identity; 4-dp rounding of the multiplier; truncation-toward-zero; rejects non-finite/≤0
- [ ] Return shape exposes `{ totalNanoUsd, tokenNanoUsd, surchargeNanoUsd }`

**Validation commands:** `pnpm test -- --testPathPattern='compute-cost|apply-markup'`

**Dependencies:** §2.2.

### 2.6 Price seed dataset (`./prices`)

**Objective:** The pinned `MODEL_PRICES_SEED` snapshot in its own data-only subpath.

**Files to create:** `src/prices/index.ts` (+ generated `model-prices.seed.ts`), `scripts/convert-litellm-prices.mjs` (offline conversion script, committed for provenance but not shipped).

**Spec references:** §6.4 (source: LiteLLM `model_prices_and_context_window.json` incl. `*_batches`/`*_flex`/`*_priority` tier fields and per-query unit rates, converted to nano-USD-per-million integers), §6.2 (target `PriceVersion`-shaped rows with `serviceTier` + `unitRates`).

**Acceptance criteria:**

- [ ] Seed covers at minimum: current OpenAI GPT-5.x family (+ embeddings small/large), Anthropic Opus/Sonnet/Haiku current family (incl. cache write/read rates as 1.25×/2×/0.1× of input), Gemini Pro/Flash (incl. long-context tier rows), Mistral Large/Medium/Small, DeepSeek/xAI/Groq headline models
- [ ] Every seed entry validates against the `PriceVersion` row schema (typed, no floats)
- [ ] Snapshot date + source commit recorded in the file header (`source: 'snapshot'`)
- [ ] `dist/prices` is tree-shakeable data (no runtime imports); `./shared` does NOT import it

**Validation commands:** `pnpm test -- --testPathPattern='prices' && pnpm build && du -h dist/prices/`

**Dependencies:** §2.2.

**Risks/Notes:** prices are point-in-time by design — the conversion script re-run is a v0.2 CLI concern; do not wire live fetching. Rates in the seed must be spot-checked against provider pricing pages during review (audit caveat: aggregator data drifts).

### 2.7 Error catalog

**Objective:** `AiTokensException` + exhaustive code/message/status maps.

**Files to create:** `src/server/errors/{ai-tokens-error-codes,ai-tokens-exception,ai-tokens-error-messages,ai-tokens-error-status}.ts` (codes re-exported from shared constants).

**Spec references:** §16.1 (class shape — mirrors `StorageException`), §16.2 (the 15-code table with HTTP statuses — including `AI_TOKENS_HOLD_EXPIRED` 410 distinct from `HOLD_ALREADY_SETTLED` 409).

**Acceptance criteria:**

- [ ] Message/status maps typed `Record<keyof typeof AI_TOKENS_ERROR_CODES, …>` (compiler-enforced exhaustiveness)
- [ ] Only `AI_TOKENS_ERROR_CODES`, `AiTokensException`, `AiTokensErrorResponse` public; maps internal
- [ ] Response body shape `{ error: { code, message, details? } }` snapshot-tested

**Validation commands:** `pnpm test -- --testPathPattern='errors'`

**Dependencies:** §2.2.

### 2.8 Port interfaces

**Objective:** Every port contract the module wires — storage, counter, tokenizer, telemetry, events, content, markup.

**Files to create:** `src/server/interfaces/{ai-tokens-store,ledger-store,pricing-store,wallet-store,budget-store,budget-counter-store,tokenizer,telemetry-sink,event-sink,content-store,markup-policy,metering-context,hold,module-options}.interface.ts` + `index.ts`.

**Spec references:** §15.1 (the four storage ports + counter port — normative signatures incl. `transition(from, to)` null-on-mismatch and multi-dimension `conditionalConsume`), §4.1 (`BymaxAiTokensModuleOptions`, `IAiTokensStore` with `Partial<>` wallet/budget halves), §11.1 (`MeteringContext`, `Hold`, `HoldEstimate`, `MeterResult`), §7.2 (`IMarkupPolicy`), §14.1 (`ITelemetrySink`), §14.2 (`IContentStore`), §12.1 (`IEventSink`).

**Acceptance criteria:**

- [ ] Every port interface from spec §3.3 exists with complete JSDoc lifted from the spec's normative text
- [ ] `BymaxAiTokensModuleAsyncOptions` follows the NestJS async dynamic-module pattern (useFactory/useClass/useExisting) mirroring nest-storage
- [ ] No `any`; discriminated unions for `HoldEstimate`

**Validation commands:** `pnpm typecheck && grep -n ': any\b' src/server/interfaces/`

**Dependencies:** §2.2, §2.7.

### 2.9 DI tokens, options validation, defaults

**Objective:** `Symbol()` tokens, `validateOptions()`, `applyDefaults()` → `ResolvedAiTokensOptions`.

**Files to create:** `src/server/bymax-ai-tokens.constants.ts`, `src/server/config/{validate-options,apply-defaults,resolved-options,default-options.constants}.ts`.

**Spec references:** §4.5 (the 11 tokens), §4.2 (defaults table), §4.6 (validation rules: enabled-feature port checks, `AI_TOKENS_FX_REQUIRED` at init when `currency !== 'USD'` without `fx`, markup validation via `applyMarkup`'s rules, negative-limit rejection), §16.2 (`AI_TOKENS_INVALID_CONFIG` semantics).

**Acceptance criteria:**

- [ ] Every invalid-config case from spec §4.6 throws `AI_TOKENS_INVALID_CONFIG` with an actionable `details.reason`
- [ ] `wallets: {}` with a store missing `conditionalDebit` fails at init (feature-port validation)
- [ ] Defaults exactly match spec §4.2 (holds TTL 3600, reaper 300, thresholds [0.8, 1.0], burnOrder 'expiry', failClosed true, …)

**Validation commands:** `pnpm test -- --testPathPattern='config'`

**Dependencies:** §2.7, §2.8.

### 2.10 `PricingService`

**Objective:** Effective-dated rate resolution with the §6.6 model-resolution chain, in-memory TTL cache, `upsertPrice`, `getPriceHistory`, and the idempotent snapshot seed.

**Files to create:** `src/server/services/pricing.service.ts`, `src/server/utils/model-id.ts` (normalization: strip `models/` prefix, date suffixes, Bedrock region prefixes, lowercase).

**Spec references:** §6.3 (resolution semantics; tier fallback ONLY standard→standard — batch/flex/priority never silently fall back), §6.6 (six-step resolution chain, `baseModel`, `pricing.modelAliases`, `requestedModel` vs `model`), §6.4 (seed on first boot — idempotent + advisory-locked via the store), §16.2 (`AI_TOKENS_PRICE_NOT_FOUND`), §20.3 (cache staleness — documented behavior).

**Acceptance criteria:**

- [ ] Resolution-chain tests: exact hit; `baseModel` override; alias map; `gpt-5.2-2026-03-14` → `gpt-5.2` (date strip); `models/gemini-2.5-flash` → prefix strip; `us.anthropic.claude…` → region strip; longest-`startsWith`; strict miss throws / non-strict returns null
- [ ] Tier resolution: `flex` call with no flex row → strict miss (never standard rates); `standard` call resolves standard row
- [ ] `upsertPrice` closes the open row and inserts a new one (verified against the in-memory fake store); history returns both
- [ ] Cache: hit within TTL, refresh after TTL, keyed by full resolution tuple
- [ ] Seed runs once across two concurrent module inits (fake store records seed-lock acquisitions)

**Validation commands:** `pnpm test -- --testPathPattern='pricing|model-id'`

**Dependencies:** §2.5, §2.6, §2.8, §2.9.

### 2.11 `BymaxAiTokensModule.forRoot()` + provider presets

**Objective:** The synchronous dynamic module wiring (token fan-out, feature gating, precedence rules) and the `providerPresets` object.

**Files to create:** `src/server/bymax-ai-tokens.module.ts`, `src/server/config/provider-presets.ts`, `src/server/index.ts` (barrel — server re-exports every `./shared` symbol per spec §3.3).

**Spec references:** §2.1 (`@Global()` + justification), §4.6 (store fan-out under per-port tokens; option-vs-token precedence; feature-gated provider registration — unconfigured features register nothing), §4.3 (the 11 presets incl. `openaiCompatible(id)` factory and `azureOpenai`), §3.3 (public export surface + re-export rule).

**Acceptance criteria:**

- [ ] Fixture app boots with only `store` configured; `PricingService` injectable; `WalletService`/`BudgetService` NOT registered (container resolution fails cleanly)
- [ ] With `wallets: {}`/`budgets: {}` present, the corresponding services register
- [ ] A host-bound `BYMAX_AI_TOKENS_PRICING_STORE` token overrides the bundle's pricing half (precedence test)
- [ ] Every preset produces the right `{ provider, normalizer, ratingMode }`; `openaiCompatible('deepseek')` yields a working preset
- [ ] End-to-end fixture: raw OpenAI usage fixture → preset normalizer → `PricingService` → exact expected nano-USD cost (the phase's Definition of Done demo)

**Validation commands:** `pnpm test -- --testPathPattern='module|presets' && pnpm build`

**Dependencies:** §2.9, §2.10; presets need §2.4.

---

## 3. Phase 2 — Ledger + Markup + Events + Prisma Store

> **Phase objective:** Implement the immutable ledger (state machine, payload-hash idempotency, compensation, opt-in hash chain), the markup engine wired into rating, the post-hoc `MeteringService.record()` path, the typed event system, and the official `PrismaAiTokensStore` (ledger + pricing halves) with the schema fragment and SQL migrations. **At the end of the phase, `record()` writes a correct, idempotent, marked-up, event-emitting ledger entry to a real PostgreSQL database.**
>
> **Complexity:** HIGH (state machine correctness, exactly-once semantics, first persistence).
>
> **Critical paths for mutation focus:** `server/services/ledger.service.ts`, `server/utils/hash-chain.ts`, `prisma/` adapter transaction paths, `server/services/metering.service.ts` (record path).

### 3.1 `LedgerService` — append, idempotency, query

**Objective:** The append/replay/query core over `ILedgerStore`.

**Files to create:** `src/server/services/ledger.service.ts`, `src/server/utils/payload-hash.ts`; in-memory `ILedgerStore` fake under `test/fakes/`.

**Spec references:** §8.2 (`UsageRecord` — every column), §8.4 (upsert on `(tenantId, idempotencyKey)`; replay iff payload hash matches, else `AI_TOKENS_IDEMPOTENCY_CONFLICT`; random-UUID fallback when the key is omitted), §15.1 (`append(record, payloadHash)`, `findByIdempotencyKey`, `query`, `sumCost`), §15.5 (bigint boundary; `toJsonSafe()` helper lives here).

**Acceptance criteria:**

- [ ] Replay with same key + same payload returns the identical record (same `id`), writes nothing
- [ ] Same key + different payload → 409 `AI_TOKENS_IDEMPOTENCY_CONFLICT`
- [ ] `sumCost` over a seeded fixture matches hand-computed totals (posted + reversed statuses only, per §8.3)
- [ ] `query` honors every `LedgerFilter` field (spec §15.1)
- [ ] `toJsonSafe()` serializes every bigint as a decimal string, round-trip tested

**Dependencies:** Phase 1 complete.

### 3.2 Ledger state machine + compensation

**Objective:** `transition()` semantics and `LedgerService.reverse()` (ledger-only primitive).

**Files to modify:** `src/server/services/ledger.service.ts`.

**Spec references:** §8.3 (four statuses; balance math sums `posted`+`reversed`), §8.5 (compensating record with negated amounts + `reversesRecordId`; original annotated `posted → reversed` + `reversedByRecordId` — the ONE permitted mutation; idempotency key `reverse:<originalId>`; double-reverse → 409; reversing pending/released → invalid), §15.1 (`transition(id, from, to, patch)` returns null on from-state mismatch — the atomic claim primitive).

**Acceptance criteria:**

- [ ] Every legal transition tested; every illegal transition rejected (posted→pending, released→posted, amount patch on posted→reversed, …)
- [ ] `reverse()` produces a compensating record whose amounts exactly negate the original (property test over generated records)
- [ ] After reverse, `sumCost` nets to zero for that pair
- [ ] `transition` from-state mismatch returns null (no throw) — race-claim contract verified with two concurrent calls on the fake store

**Dependencies:** §3.1.

### 3.3 Opt-in hash chain

**Objective:** Per-tenant tamper-evident chain + `verifyChain()`.

**Files to create:** `src/server/utils/hash-chain.ts`; wiring in `LedgerService`.

**Spec references:** §8.6 (hash only at settlement; pending/released outside the chain; per-tenant serialization via store-provided advisory lock; replays never re-hash; `verifyChain(tenantId, from?, to?)` reports first break + audit event), §20.2 (throughput caveat).

**Acceptance criteria:**

- [ ] Chain off by default — zero hash computation when disabled (perf assertion: no `lastHash` store calls)
- [ ] Enabled: `record → capture → reverse` sequence yields a verifiable chain; tampering any posted row makes `verifyChain` report exactly that row
- [ ] Settling a hold does not invalidate the chain (pending excluded)

**Dependencies:** §3.2.

### 3.4 Markup engine wiring

**Objective:** Resolve `markup` (number | `IMarkupPolicy`) per call and apply it in both rating modes.

**Files to create:** `src/server/services/markup.resolver.ts` (internal).

**Spec references:** §7.2 (policy resolution context incl. `serviceTier`; resolved 4-dp value persisted on the record), §2.3 (markup on top of provider-reported cost too), §4.1 (validation at init for the static number; per-call validation for policy returns).

**Acceptance criteria:**

- [ ] Static multiplier and async policy both resolve; policy receives the full context
- [ ] Policy returning `1.23456` → applied as `1.2346` (4-dp) and persisted as such
- [ ] Provider-reported mode: OpenRouter cost × markup verified
- [ ] Policy throwing → the metering call fails (no silent 1.0 fallback) with a wrapped error

**Dependencies:** Phase 1 (§2.5).

### 3.5 `MeteringService.record()` (post-hoc path)

**Objective:** The observe-only metering facade path: normalize → rate → markup → ledger append → events/telemetry hooks.

**Files to create:** `src/server/services/metering.service.ts` (record + estimateCost; the hold lifecycle lands in Phase 4).

**Spec references:** §11.1 (`record()` input incl. `preset`/`normalizer` alternative, `occurredAt` for backfills; `estimateCost()`), §11.2 (side-effect matrix row for `record()` default — ledger + events only; `enforce: true` is **deferred to Phase 3+4** and throws `AI_TOKENS_INVALID_CONFIG` until wallets/budgets exist), §16.2 (`AI_TOKENS_UNKNOWN_PROVIDER` when raw usage arrives with no preset/normalizer and is not already normalized — detection: presence of `provider` + numeric token fields).

**Acceptance criteria:**

- [ ] Raw usage + preset → posted record with correct provider/model/tier/tokens/costs/markup/`enforced: false`
- [ ] Already-`NormalizedUsage` input accepted without preset
- [ ] Raw input without preset → 400 `AI_TOKENS_UNKNOWN_PROVIDER`
- [ ] `isSystemCost` + `systemCostCategory` + `beneficiary` + `requestedBy` + `tags` + `extraUnits` all land on the record
- [ ] `priceMissing` path (non-strict) records cost 0 + flag + `ai_tokens.price.missing` event
- [ ] `estimateCost()` returns raw+billed for a hypothetical call, no side effects

**Dependencies:** §3.1, §3.4; presets from Phase 1.

### 3.6 Typed events

**Objective:** The event catalog, envelope, EventEmitter2 bridge (optional peer), and `IEventSink` delivery.

**Files to create:** `src/server/events/{event-types,event-emitter.bridge,event-dispatcher}.ts`.

**Spec references:** §12.1 (envelope with UUID dedupe id; at-least-once; sink failures logged never thrown), §12.2 (the 11-event catalog with payload fields; bigint-as-string at the out-of-process boundary), §4.1 (`events.emitter` default true, no-op when the peer is absent — dynamic import guarded).

**Acceptance criteria:**

- [ ] `record()` emits `ai_tokens.usage.recorded` with the documented payload
- [ ] Emitter absent (peer not installed) → no crash, sink still delivers
- [ ] Sink throwing → error logged, metering call unaffected
- [ ] Envelope ids unique; `occurredAt` set; payload types exported from `./shared`

**Dependencies:** §3.5.

### 3.7 `PrismaAiTokensStore` (ledger + pricing) + schema + migrations

**Objective:** The official adapter's ledger and pricing halves, the full 7-table schema fragment, and the SQL migrations (all tables ship now; wallet/budget halves of the adapter land in Phase 3).

**Files to create:** `src/prisma/index.ts`, `src/prisma/schema.prisma.fragment`, `src/prisma/migrations/0001_init.sql`, `test/e2e/prisma-migrations.e2e-spec.ts` (Testcontainers smoke: apply migrations + append/replay round-trip).

**Spec references:** §15.3 (the seven models verbatim — incl. the partial unique index on open price rows and the partial pending-status index, shipped in raw SQL; merge mechanics: multi-file schema copy OR raw SQL), §15.2 (error mapping table — P2002 replay-or-conflict, 0-row conditional ops → domain errors, unknown → `AI_TOKENS_STORE_ERROR`; `Prisma.Decimal ↔ number` at the boundary), §6.4 (seed advisory lock lives here: `pg_advisory_xact_lock`).

**Acceptance criteria:**

- [ ] Migrations apply cleanly on a fresh Postgres container; both partial indexes verified via `pg_indexes`
- [ ] `append` + replay + conflict + `transition` race (two connections) behave per §15.2 against the real database
- [ ] `resolveRate`/`upsertPrice` honor the open-row unique index (concurrent upsert test)
- [ ] Advisory-locked seed: two concurrent seeds → one seed pass
- [ ] `unitRates` JSON round-trips bigint-as-decimal-string correctly

**Dependencies:** §3.1–§3.5 (contracts stable).

**Risks/Notes:** this is the first Testcontainers usage — keep it to a migrations + adapter smoke here; the full e2e suite is Phase 4 (§5.11). Prisma multi-file schema requires the host on Prisma ≥ 6 — document in the fragment header.

---

## 4. Phase 3 — Wallets + Budgets + Enforcement

> **Phase objective:** Implement prepaid wallets (materialized balance, atomic conditional debit, grant burn-down with allocations, adjust/entries/reconcile), multi-dimension feature-scoped budgets (spend/tokens/count) with renewal-anchored windows, the status API, the enforcement predicate, the `BudgetGuard` (check-only mode), the Redis counter, and the Prisma wallet/budget halves. **At the end of the phase, spend can be blocked before it happens, race-safely, under concurrency, at every scope level.**
>
> **Complexity:** HIGH (concurrent money movement — the riskiest code in the library).
>
> **Critical paths for mutation focus:** `wallet.service.ts` debit/allocation paths, `budget.service.ts` window anchoring + predicate, both `conditional*` store implementations, `window-anchor.ts`.

### 4.1 Wallet core — `WalletService` (balance, grant, debit, refund, adjust, entries)

**Objective:** The full §9.2 service surface over `IWalletStore`.

**Files to create:** `src/server/services/wallet.service.ts`; in-memory `IWalletStore` fake.

**Spec references:** §9.1 (types; auto-create on first grant/positive adjust; `'key'` cannot own money), §9.2 (all six methods — `debit` with optional `usageRecordId` requiring `reason` when absent [voucher-reservation support], `adjust` as the admin-plane signed correction), §14.4 (admin-plane audit events for grant/adjust).

**Acceptance criteria:**

- [ ] Grant/debit/refund/adjust each append entries with per-wallet idempotency (replay-or-conflict like the ledger)
- [ ] `getBalance` excludes future-`effectiveAt` and expired grants (§9.3 rules)
- [ ] Debit without `usageRecordId` and without `reason` → validation error
- [ ] `getEntries` pagination + type/date filters
- [ ] `grant`/`adjust` emit `ai_tokens.wallet.granted`/`ai_tokens.audit`

**Dependencies:** Phase 2 (events, error catalog).

### 4.2 Grant burn-down + allocations + expiry

**Objective:** Burn order, the debit-allocation trail, lazy expiry entries.

**Files to modify:** `wallet.service.ts`; fake store gains `openGrants` ordering.

**Spec references:** §9.3 (burn orders 'expiry'/'priority'/'fifo'; allocation table = audit trail; grant remaining = amount − Σ allocations; lazy `expiry` entries at next debit or reaper sweep; rollover formula is host guidance, not lib code), §15.3 (`AiWalletDebitAllocation`).

**Acceptance criteria:**

- [ ] Two grants, different expiries: debit allocates to soonest-expiring first ('expiry'); 'priority' and 'fifo' orders verified
- [ ] A debit spanning two grants creates two allocations summing to the debit
- [ ] Expired grant with remainder: next debit writes the `expiry` entry negating exactly the unspent remainder and excludes it from allocation
- [ ] Refund restores the balance but never resurrects an expired grant

**Dependencies:** §4.1.

### 4.3 Race-safe conditional debit + reconcile

**Objective:** The §9.4 materialized-balance conditional update and balance reconciliation.

**Files to modify:** `wallet.service.ts`; contract tests reused later against Prisma (§4.10).

**Spec references:** §9.4 (the conditional `UPDATE … WHERE balance − cost ≥ −overdraft`; entries remain source of truth; `reconcile(ref)` recomputes), §9.5 (overdraft), §16.2 (`AI_TOKENS_INSUFFICIENT_CREDITS`).

**Acceptance criteria:**

- [ ] Two concurrent debits against balance for one → exactly one succeeds (contract test, run against fake AND Prisma in §4.10)
- [ ] Overdraft honored: balance may go to exactly `−overdraft`, not below
- [ ] `reconcile` detects and repairs a manually-skewed materialized balance
- [ ] Depletion emits `ai_tokens.wallet.depleted`

**Dependencies:** §4.2.

### 4.4 Budget model + windows + anchoring

**Objective:** `BudgetService` CRUD + the window-anchor engine (calendar UTC and per-subject `anchorAt`, month-end clamping, `total`, `custom:<seconds>`, `expiresAt`).

**Files to create:** `src/server/services/budget.service.ts`, `src/server/utils/window-anchor.ts`; in-memory `IBudgetStore` fake.

**Spec references:** §10.1 (`Budget` — features filter, three limit dimensions, `anchorAt`, `expiresAt`), §10.2 (unlimited semantics — normative), §10.3 (multi-level: ALL matching budgets checked and consumed independently), §10.5 (upsert/remove/list/rotateWindow/reconcileWindow), §16.2 (`AI_TOKENS_INVALID_CONFIG` for negative limits).

**Acceptance criteria:**

- [ ] Window-anchor table tests: Jan 31 anchor → Feb 28/29 → Mar 31 (clamping); week/day anchors; calendar-UTC defaults when `anchorAt` absent; `total` never rotates; `custom:86400`
- [ ] `limit: 0` blocks; absent limit dimension = unlimited on that dimension; negative rejected
- [ ] `rotateWindow` starts a fresh window now and re-anchors subsequent windows
- [ ] Expired budgets (`expiresAt` past) are ignored by enforcement and excluded from `findMatching` results
- [ ] `upsertBudget`/`removeBudget` emit `ai_tokens.audit`

**Dependencies:** Phase 2.

### 4.5 Enforcement predicate + conditional consume

**Objective:** The §10.7 predicate and the §10.8 multi-dimension atomic consume + `adjustWindow` (signed release).

**Files to modify:** `budget.service.ts`; fake store implements `conditionalConsume`/`adjustWindow`/`getWindow`.

**Spec references:** §10.7 (the five-clause predicate — enforced ∧ ¬system ∧ feature-match ∧ posted/reversed ∧ in-window; `reconcileWindow` recomputes with the SAME predicate), §10.8 (multi-dimension conditional SQL semantics; count consumes 1 per record), §16.2 (402 vs 429 mapping by dimension).

**Acceptance criteria:**

- [ ] Predicate truth-table tests (each clause independently flips consumption)
- [ ] Cost-limited, token-limited, and count-limited budgets each block on their own dimension with the right error code
- [ ] Feature filter: `features: ['workout.generate']` consumes for that feature only; embeddings pass through
- [ ] `reconcileWindow` recomputed from a seeded ledger equals live counters (including after a reversal)
- [ ] Two concurrent consumes with headroom for one → exactly one passes (contract test)

**Dependencies:** §4.4, Phase 2 ledger (predicate reads records).

### 4.6 Budget status API

**Objective:** `BudgetService.status()` → `BudgetStatus[]` (the user-facing remaining query).

**Files to modify:** `budget.service.ts`.

**Spec references:** §10.6 (shapes — `limit`/`spent`/`remaining` per dimension, `resetsAt`, `usedFraction` = max across limited dimensions; absent dimension = unlimited), §15.5 (bigint serialization guidance for host controllers).

**Acceptance criteria:**

- [ ] Status reflects live windows across all matching scopes; `resetsAt` correct for anchored/calendar/total windows
- [ ] Unlimited dimensions absent from `remaining` (not zero)
- [ ] `usedFraction` correct with mixed dimensions

**Dependencies:** §4.5.

### 4.7 Soft thresholds, projections, throttle policy

**Objective:** Threshold-crossing detection, projected-spend events, `onThrottle` dispatch.

**Files to modify:** `budget.service.ts` (+ event wiring).

**Spec references:** §10.4 (soft thresholds fire events not blocks; `throttle` → `budgets.onThrottle` else allow+warn; `allow` alert-only; projection = current burn rate vs reset), §12.2 (`threshold_crossed`/`exceeded`/`projected_exceeded` payloads).

**Acceptance criteria:**

- [ ] Crossing 80% then 100% emits exactly one event per threshold per window (no re-fire on every call)
- [ ] `policy: 'throttle'` invokes the callback with `{ context, budget, status }`; absent callback → warn + allow
- [ ] Projection event fires when burn rate projects crossing before `resetsAt`

**Dependencies:** §4.5, §4.6.

### 4.8 `BudgetGuard` + `@RequireBudget` (check-only mode)

**Objective:** The `CanActivate` gate over `scopeResolver` + status; request enrichment. (Hold-placing mode arrives with holds in Phase 4.)

**Files to create:** `src/server/enforcement/{budget.guard,decorators}.ts` (`@RequireBudget`, `@AiFeature`; `@Meter` metadata-only — interceptor lands in Phase 4).

**Spec references:** §11.3 (guard resolves context via `scopeResolver`, merges decorator config, blocks on exhausted hard budgets, attaches `request.aiTokens = { status, hold?, context }`), §11.4 (decorator configs; `@Meter.feature` wins over `@AiFeature`), §4.1 (`scopeResolver` required for decorator use).

**Acceptance criteria:**

- [ ] Guard blocks with 402/429 pre-handler when a hard budget is exhausted; passes otherwise
- [ ] `request.aiTokens.status` populated on pass (fitness `AIGenerationGuard` request-enrichment parity)
- [ ] Missing `scopeResolver` with guard in use → clear `AI_TOKENS_INVALID_CONFIG` at init
- [ ] Decorator metadata merge precedence tested

**Dependencies:** §4.6.

### 4.9 `RedisBudgetCounterStore` (`./redis`)

**Objective:** The optional live cross-replica counter.

**Files to create:** `src/redis/index.ts` (`RedisBudgetCounterStore`), counter wiring in `budget.service.ts` (fast path + `failClosed` fallback).

**Spec references:** §10.8 (key scheme `ai_tokens:budget:{budgetId}:{windowStartISO}:{dimension}`, TTL = window + 1h grace, int64-string values, Lua/atomic `incrIfBelow`), §15.1 (`IBudgetCounterStore`), §4.1 (`budgets.counter` option ↔ token precedence), §20.2 (fallback semantics).

**Acceptance criteria:**

- [ ] `incrIfBelow` is atomic (Lua script or WATCH-free single command); unit-tested against ioredis-mock, e2e against real Redis in Phase 4
- [ ] Counter unavailable + `failClosed: true` → falls back to DB conditional consume; DB also down → blocks (fail closed)
- [ ] `decr`/`reset` used by capture-delta/release/rotate paths

**Dependencies:** §4.5.

### 4.10 Prisma wallet + budget halves

**Objective:** Complete `PrismaAiTokensStore` with `IWalletStore` + `IBudgetStore`, re-running the Phase 3 contract tests against real Postgres.

**Files to modify:** `src/prisma/index.ts` (+ migration already shipped in §3.7).

**Spec references:** §15.2 (error mapping incl. wallet-entry idempotency), §9.4 (conditional debit SQL), §10.8 (conditional consume SQL).

**Acceptance criteria:**

- [ ] The §4.3 and §4.5 concurrency contract tests pass against Testcontainers Postgres (real row-level behavior)
- [ ] Allocation queries (`openGrants` with remaining) correct under concurrent debits
- [ ] All wallet/budget error mapping rows from §15.2 verified

**Dependencies:** §4.3, §4.5, §3.7.

---

## 5. Phase 4 — Metering Lifecycle + Streaming + Telemetry + Reporting + E2E

> **Phase objective:** Complete the metering lifecycle (`hold`/`capture`/`release`/`meter`/`reverse`/`getStatus` + the hold reaper), streaming-safe capture, the declarative surface (`MeteringInterceptor` + `@Meter`, guard hold mode), OpenTelemetry emission, the reporting/export service, `forRootAsync()`, and the full e2e suite against real PostgreSQL + Redis. **At the end of the phase, `meter(fn, ctx)` works end-to-end — including aborted streams, concurrent enforcement, and reversal — verified by the ten e2e scenarios.**
>
> **Complexity:** HIGH (cross-store orchestration with compensation; streaming edge cases; the e2e suite).
>
> **Critical paths for mutation focus:** `metering.service.ts` hold/capture/release/reverse orchestration, `hold-reaper.ts`, `stream-usage-collector.ts`, `metering.interceptor.ts`.

### 5.1 `hold()` — estimate, rate, reserve

**Objective:** The auth-hold entry point: rate a `HoldEstimate`, consume counter → budget → wallet with compensation, write the pending record.

**Files to modify/create:** `src/server/services/metering.service.ts`, `src/server/interfaces/hold.interface.ts` (already typed in P1 — wire it).

**Spec references:** §11.1 (`HoldEstimate` three variants — full call shape / bare tokens / pre-rated `amountNanoUsd`), §11.2 (hold row of the side-effect matrix + the normative failure ordering: counter → window → wallet → pending insert, compensating backwards), §2.2 (lifecycle), §8.3 (pending state, TTL).

**Acceptance criteria:**

- [ ] All three `HoldEstimate` variants rate correctly (`{ tokens }` rates against the context preset's model; `{ amountNanoUsd }` used as-is — the fitness estimator path)
- [ ] Failure injection at each step (counter ok/window fails; window ok/wallet fails) → all prior steps compensated, correct domain error
- [ ] Hold is a plain serializable object (JSON round-trip preserves capture-ability)
- [ ] `isSystemCost` holds skip wallet/budget/counter entirely
- [ ] Multi-hold composition: two holds for one logical feature both reserve independently

**Dependencies:** Phases 2–3 complete.

### 5.2 `capture()` and `release()`

**Objective:** Settlement with actuals + delta adjustment; void with full restoration; idempotency contracts.

**Files to modify:** `metering.service.ts`.

**Spec references:** §11.1 (capture idempotent — repeat returns the posted record; capture-after-release → 409 `HOLD_ALREADY_SETTLED`; release no-op-with-warn after capture; release never bills), §11.2 (capture/release matrix rows — wallet `adjustment` for the ±delta, window/counter ±delta), §14.4 (cross-tenant hold validation → `HOLD_NOT_FOUND`), §16.2 (`HOLD_EXPIRED` 410).

**Acceptance criteria:**

- [ ] Capture below/above/equal to the estimate adjusts wallet + window + counter by the exact delta (property test)
- [ ] Double capture → same record, no double side effects; capture after release → 409; capture after reaper sweep → 410
- [ ] Release restores wallet/budget/counter in full; release twice → single restoration
- [ ] Hold from tenant A captured with tenant B context → 404
- [ ] Markup re-resolved at capture against actuals; `priceVersionId` from `occurredAt`

**Dependencies:** §5.1.

### 5.3 Hold reaper

**Objective:** The periodic sweep restoring expired pending holds — a v0.1 correctness requirement.

**Files to create:** `src/server/enforcement/hold-reaper.ts` (interval via `setInterval` under `onModuleInit`/`onApplicationShutdown` lifecycle — no `@nestjs/schedule` dependency).

**Spec references:** §8.3 (TTL semantics; multi-replica: `transition(pending→released)` atomic claim — one replica wins), §4.1 (`holds.ttlSeconds`/`reaperIntervalSeconds`), §12.2 (`ai_tokens.hold.released` with `expired: true`).

**Acceptance criteria:**

- [ ] Expired holds swept exactly once with two reaper instances racing (fake-store race test; real-DB race in §5.11)
- [ ] Sweep performs the same restoration as `release()` (shared code path, not a copy)
- [ ] Reaper interval starts on module init, clears on shutdown (no open handles in Jest)
- [ ] Non-expired pending holds untouched

**Dependencies:** §5.2.

### 5.4 `meter()` wrapper + `reverse()` orchestrator + `getStatus()`

**Objective:** The three remaining facade methods.

**Files to modify:** `metering.service.ts`.

**Spec references:** §11.1 (`meter(fn, ctx, extract, estimate?)` — with estimate: hold→fn→capture, release on fn error; without: post-hoc + enforce), §8.5 (`reverse()` = ledger compensation + wallet refund + budget/counter release in one transaction — only when the original was `enforced`), §10.6 (`getStatus` combines wallet + all matching budgets into `AccessStatus`; `blockedBy`).

**Acceptance criteria:**

- [ ] `meter` happy path returns `{ result, usage }`; fn throwing → hold released, error re-thrown
- [ ] `meter` without estimate → `record({ enforce: true })` semantics (now enabled — Phase 3 delivered wallets/budgets; remove the P2 stub error)
- [ ] `reverse` on an enforced record restores wallet + all three window dimensions + counter; on a non-enforced record touches ledger only
- [ ] `getStatus` reflects wallet + budgets; `hasAccess: false` + `blockedBy` when either is exhausted; wallet section absent when wallets disabled
- [ ] `record({ enforce: true })` post-hoc consume can throw AFTER the ledger write — documented behavior verified (record persists, error propagates)

**Dependencies:** §5.2; §4.6.

### 5.5 `StreamUsageCollector`

**Objective:** Streaming-safe usage capture with tokenizer fallback.

**Files to create:** `src/server/streaming/stream-usage-collector.ts`.

**Spec references:** §5.6 (constructor options; `push()`; `finalize()` precedence: provider-final usage → tokenizer count of accumulated output → `AI_TOKENS_STREAM_USAGE_MISSING`; aborted-stream input-token fallback order: collector prompt count → hold estimate → 0), §11.1 (`capture(hold, collector)` accepts the collector).

**Acceptance criteria:**

- [ ] OpenAI stream fixture (with `stream_options.include_usage` final chunk) → provider-final usage wins
- [ ] Anthropic fixture (cumulative `message_delta` + `message_stop`) → finalized correctly
- [ ] Aborted stream (no final usage) + tokenizer → partial output billed; input per the fallback order
- [ ] No tokenizer + no final usage → 422 `STREAM_USAGE_MISSING`
- [ ] Exported from the server entry (public class)

**Dependencies:** §5.2; normalizers from Phase 1.

### 5.6 `MeteringInterceptor` + `@Meter` + guard hold mode

**Objective:** The declarative capture path and the guard↔interceptor hold hand-off.

**Files to create:** `src/server/enforcement/metering.interceptor.ts`; extend `budget.guard.ts` (hold mode when `@RequireBudget.estimate` present) and `decorators.ts` (`@Meter` full config).

**Spec references:** §11.3 (interceptor: extract via `@Meter.extract` default `result.usage`, capture the request's hold or `record({enforce:true})`; release on handler error; `exposeHeaders` → the three `x-ai-tokens-*` headers), §11.4 (`@Meter` config; precedence over `@AiFeature`), §15.5 (headers carry decimal strings).

**Acceptance criteria:**

- [ ] Guard(estimate) + interceptor: hold placed pre-handler, captured with the handler's usage, released when the handler throws
- [ ] Interceptor without guard hold → `record({ enforce: true })`
- [ ] Headers present and correct when `exposeHeaders: true` (values as decimal strings)
- [ ] Handler returning no extractable usage → `AI_TOKENS_USAGE_MALFORMED` (not a silent skip)
- [ ] Fixture controller e2e-lite (supertest against a Nest testing module)

**Dependencies:** §5.1, §5.2, §4.8.

### 5.7 OpenTelemetry emission

**Objective:** `gen_ai.*` spans/metrics via `ITelemetrySink`.

**Files to create:** `src/server/telemetry/{otel-emitter,no-op-telemetry}.ts`.

**Spec references:** §14.1 (attribute set: `gen_ai.usage.input_tokens`/`output_tokens`, `request.model`/`response.model`, `operation.name`, `provider.name`, `token.type`; `gen_ai.client.token.usage` histogram + `operation.duration`; no content capture), §4.1 (`telemetry.metrics` default).

**Acceptance criteria:**

- [ ] Every posted record triggers `recordUsage` with the documented attributes; duration recorded on `meter()` paths
- [ ] No sink configured → no-op (zero overhead assertion: no attribute objects built)
- [ ] No prompt/completion text in any attribute (grep-style test on emitted attributes)

**Dependencies:** §5.4.

### 5.8 `UsageReportService`

**Objective:** SQL aggregation (`summarize` incl. `cacheSavingsNanoUsd`), CSV/JSON streaming export, audit events, FX presentation.

**Files to create:** `src/server/services/usage-report.service.ts`.

**Spec references:** §13.1 (`ReportFilter`/`UsageSummary`; the 12 groupBy dimensions; empty groupBy = grand total; default statuses posted+reversed), §13.2 (export field set — all columns), §7.4 (FX at presentation; `fx` applied per row date), §14.4 (`ai_tokens.audit` per export), §4.1 (`reporting.maxExportRows`).

**Acceptance criteria:**

- [ ] `summarize` groupBy tests per dimension incl. `day` (UTC bucketing), `tag` (unnest), `beneficiary`, `systemCostCategory`; grand-total row on empty groupBy
- [ ] `cacheSavingsNanoUsd = Σ cacheReadTokens × (inputRate − cacheReadRate)` verified against seeded records with known price versions
- [ ] CSV export streams (Readable), field set complete, bigints as decimal strings; JSON export line-delimited
- [ ] `includeSystemCost`-style filtering via `isSystemCost`/`systemCostCategory` (the fitness admin reports)
- [ ] Export emits an audit event; `maxExportRows` enforced with a clear error
- [ ] Non-USD `currency` + `fx` adds converted presentation columns

**Dependencies:** Phase 2 ledger; runs parallel to §5.1–§5.6 (see Appendix A).

### 5.9 `forRootAsync()`

**Objective:** Async module configuration (useFactory/useClass/useExisting) with identical wiring to `forRoot()`.

**Files to modify:** `bymax-ai-tokens.module.ts`.

**Spec references:** §4.4 (canonical example), §4.6 (same validation + fan-out; `AI_TOKENS_NOT_CONFIGURED` for pre-init calls), nest-storage precedent (both paths wire identical providers).

**Acceptance criteria:**

- [ ] All three async styles boot the fixture app; wiring parity with `forRoot()` (same provider set, snapshot-compared)
- [ ] Factory rejection → clean bootstrap failure with `AI_TOKENS_INVALID_CONFIG`

**Dependencies:** §2.11 (Phase 1 module), stable service set (§5.1–§5.8).

### 5.10 Content sidecar wiring (opt-in)

**Objective:** The `content` option: masked, TTL'd prompt/completion capture through `IContentStore` — OFF by default.

**Files to create:** `src/server/services/content-capture.ts` (internal helper called by record/capture when configured).

**Spec references:** §4.1 (`content` block: store/mask/ttlSeconds), §14.2 (ledger never stores text; sidecar is separate and purgeable), §14.3 (erasure via `purge`).

**Acceptance criteria:**

- [ ] Disabled (default): no content-store calls ever (spy assertion)
- [ ] Enabled: mask applied before `put`; TTL propagated; failures logged, never break metering
- [ ] Ledger row still contains zero text either way

**Dependencies:** §5.4.

### 5.11 E2E suite (Testcontainers: PostgreSQL + Redis)

**Objective:** The ten e2e scenarios from spec §19.2, against the real stack.

**Files to create:** `test/e2e/{concurrency,idempotency,stream-abort,reversal,anchored-window,count-quota,alias-resolution,seed-idempotence,wallet-burndown,reaper}.e2e-spec.ts` + shared fixture harness.

**Spec references:** §19.2 (the scenario list is normative — each maps 1:1 to a spec behavior), §15.2/§15.3 (real-DB behaviors under test).

**Acceptance criteria:**

- [ ] All ten scenarios green against Testcontainers Postgres; scenarios 1 and 10 also exercise the Redis counter path
- [ ] Suite runs in CI's e2e job (Docker-in-Docker per the Phase 1 workflow) under 10 minutes
- [ ] No test order dependence (fresh schema per suite via migrations)

**Dependencies:** everything above.

### 5.12 Phase-4 integration review

**Objective:** Cross-cutting verification pass before the release phase.

**Checks:** side-effect matrix (§11.2) audited cell-by-cell against the implementation; §1.10 normative-rule sweep; `/security-review` on the full money-movement surface; dead-code/exports audit (`ts-prune`-style) — everything in spec §3.3 exported, nothing extra.

**Acceptance criteria:**

- [ ] Matrix audit documented in the PR description (each cell → test reference)
- [ ] `/bymax-quality:code-review` + `/security-review` clean
- [ ] Export surface exactly matches spec §3.3

**Dependencies:** §5.1–§5.11.

---

## 6. Phase 5 — Release v0.1.0

> **Phase objective:** Documentation, budgets, mutation gate, provenance publish, and the example-app skeleton. **At the end of the phase, `@bymax-one/nest-ai-tokens@0.1.0` is live on npm with provenance.**
>
> **Complexity:** LOW (mechanical, but gate-heavy).

### 6.1 JSDoc + file-header audit

**Objective:** Every export documented; every file carries `@fileoverview` + `@layer`; examples compile.

**Acceptance criteria:** doc-coverage sweep (no exported symbol without JSDoc); `@example` blocks type-check via a docs-fixture tsconfig; no phase/task references in committed comments (timeless rule).

**Dependencies:** Phase 4 done.

### 6.2 README

**Objective:** The public front page, matching the family structure (badges → centered tagline → Overview → Features → Subpath Exports table → Quick Start → Configuration → per-feature sections → Error Codes → Testing → Contributing → License).

**Content requirements:** provider matrix (the §5.3 table condensed); a 60-second quick start (record + meter + guard); markup/resale positioning ("the SaaS profit lever" — the differentiator vs LiteLLM/Helicone/calculators, per spec §2.5); bigint/JSON note; migration pointer to spec §22.

**Acceptance criteria:** every code sample in the README compiles against the built package (README-fixture test); badge URLs point at bymaxone/nest-ai-tokens.

**Dependencies:** §6.1.

### 6.3 SECURITY.md / CHANGELOG.md / CLAUDE.md / AGENTS.md / LICENSE

**Objective:** The family's supporting docs. SECURITY.md covers the §14.4 threat model (admin vs data plane, scope-resolver trust, hash-chain verification); CLAUDE.md carries the critical rules (money-integer, ledger immutability, side-effect matrix, no text in ledger); AGENTS.md the architecture deep-dive.

**Acceptance criteria:** SECURITY.md lists sensitive code paths + disclosure contact (security@bymax.one); CLAUDE.md ≤ ~150 lines, rule-dense per family convention.

**Dependencies:** §6.1.

### 6.4 Bundle-size budgets + `pnpm size`

**Objective:** Enforce spec §19.1 budgets (server < 40 KB, shared < 10 KB, prisma < 15 KB, redis < 5 KB brotli; prices documented, exempt).

**Acceptance criteria:** `scripts/check-size.mjs` covers the five entries; CI fails over budget; actual sizes recorded in the README.

**Dependencies:** Phase 4 done.

### 6.5 Mutation testing (release gate)

**Objective:** Full Stryker run — high 100 / low 95 / **break 95** — plus `docs/mutation_testing_plan.md` and `docs/mutation_testing_results.md` (family convention).

**Acceptance criteria:** score ≥ 95%; surviving equivalent mutants documented with `// Stryker disable next-line` + justification (never by lowering the gate); results doc committed.

**Dependencies:** §6.1–§6.4.

### 6.6 Publish v0.1.0

**Objective:** Version bump `0.1.0-alpha.0 → 0.1.0`, tag, `npm publish --provenance` via the Phase 1 `release.yml`.

**Acceptance criteria:** `prepublishOnly` chain green (clean → typecheck → lint → test:cov:all 100% → build); provenance attestation visible on npm; install smoke (`npm i` in a scratch app, `forRoot` boots) — **the tag push itself awaits the human** (family convention).

**Dependencies:** §6.5.

### 6.7 `nest-ai-tokens-example` skeleton

**Objective:** Scaffold the sibling reference app (family convention: `<lib>-example`) — NestJS 11 + Prisma + the lib, demonstrating: record + meter + guard/interceptor, a `GET /me/ai-usage` status endpoint, a minimal usage dashboard, and the fitness-style plan-budget setup (spec §21.5).

**Acceptance criteria:** separate repo `bymaxone/nest-ai-tokens-example` initialized with the working skeleton and a README linking back; not a blocker for §6.6 (may land immediately after publish).

**Dependencies:** §6.6 (consumes the published package).

---

## Appendix A — Dependency Graph

### A.1 Phase-level DAG

```
P1 ──► P2 ──► P3 ──► P4 ──► P5
       │             ▲
       └── (4.8 Reporting depends only on P2's ledger ──┘
            and may start in parallel with P3)
```

Phases are strictly sequential at the merge level (each phase's PR lands before the next starts). The one sanctioned overlap: **§5.8 `UsageReportService`** depends only on Phase 2's ledger + pricing and may be developed in parallel with Phase 3 on a separate branch, landing inside the Phase 4 PR.

### A.2 Sub-step DAG (within-phase parallel lanes)

```
Phase 1:
  2.1 ──► 2.2 ──┬─► 2.3 ──► 2.4 ─────────────┐
                ├─► 2.5 ◄─────────────────────┤ (2.4 feeds presets only)
                ├─► 2.6                        │
                ├─► 2.7 ──► 2.8 ──► 2.9 ──► 2.10 ──► 2.11
                └──────────────────────────────┘
  Parallel lanes after 2.2: {2.3→2.4}, {2.5}, {2.6}, {2.7→2.8→2.9}

Phase 2:
  3.1 ──► 3.2 ──► 3.3
   │       │
   │       └────► 3.5 ──► 3.6
   └─► 3.4 ──────┘
  3.7 (Prisma) after 3.1–3.5 contracts stabilize
  Parallel lanes: {3.3} ∥ {3.4→3.5→3.6}

Phase 3:
  Wallet lane:  4.1 ──► 4.2 ──► 4.3 ─────────┐
  Budget lane:  4.4 ──► 4.5 ──► 4.6 ──► 4.7 ─┼─► 4.10
                        └─► 4.8    4.9 ◄─────┘
  The two lanes are fully parallel until 4.10 (Prisma halves).

Phase 4:
  5.1 ──► 5.2 ──► 5.3
           │
           ├─► 5.4 ──► 5.7, 5.10
           ├─► 5.5 ──► 5.6 (needs 4.8's guard)
  5.8 (reporting) independent — may predate the phase (A.1)
  5.9 after the service set stabilizes
  5.11 after all; 5.12 last
```

### A.3 Cross-document dependency

Every sub-step's canonical contract lives in the spec (cited inline). If implementation reveals a spec defect, **fix the spec first** (with a `docs(spec):` commit), then the code — the spec remains the single source of truth.

---

## Appendix B — Complexity Matrix

| Sub-step | Complexity | Risk driver |
| --- | --- | --- |
| 2.1 Scaffold + CI | MEDIUM | 5-entry tsup; CI front-loading |
| 2.2 Catalogs/types | LOW | Breadth only |
| 2.3 Money/idempotency utils | MEDIUM | Zero-dep sha256 decision; exactness |
| 2.4 Normalizers ×9 | **HIGH** | Reasoning subtraction; per-provider fixtures; invariants |
| 2.5 Cost engine | **HIGH** | Tier all-or-nothing; surcharge loop; billing-correctness core |
| 2.6 Price seed | MEDIUM | Data conversion fidelity |
| 2.7 Errors | LOW | Mechanical |
| 2.8 Ports | LOW–MEDIUM | Contract fidelity to spec §15.1 |
| 2.9 Tokens/validation | MEDIUM | Feature-port validation matrix |
| 2.10 PricingService | **HIGH** | 6-step resolution chain; tier fallback rules; seed idempotence |
| 2.11 Module forRoot | MEDIUM | Fan-out + precedence + feature gating |
| 3.1 Ledger append/query | **HIGH** | Exactly-once core |
| 3.2 State machine + reverse | **HIGH** | Transition legality; compensation math |
| 3.3 Hash chain | MEDIUM | Serialization + settlement-only hashing |
| 3.4 Markup wiring | LOW–MEDIUM | 4-dp resolution |
| 3.5 record() | MEDIUM | Facade composition |
| 3.6 Events | MEDIUM | Optional-peer bridge |
| 3.7 Prisma ledger+pricing | **HIGH** | First real-DB semantics; migrations; race tests |
| 4.1 WalletService | MEDIUM | Surface breadth |
| 4.2 Burn-down | **HIGH** | Allocation correctness; lazy expiry |
| 4.3 Conditional debit | **HIGH** | The race-safety core |
| 4.4 Budget model/windows | **HIGH** | Anchor math incl. month-end clamping |
| 4.5 Predicate + consume | **HIGH** | Five-clause predicate; multi-dimension atomicity |
| 4.6 Status API | MEDIUM | Aggregation shape |
| 4.7 Thresholds/throttle | MEDIUM | Once-per-window event dedupe |
| 4.8 Guard (check mode) | MEDIUM | ExecutionContext plumbing |
| 4.9 Redis counter | MEDIUM–HIGH | Atomic Lua; fail-closed fallback |
| 4.10 Prisma wallet+budget | **HIGH** | Concurrency contract tests on real DB |
| 5.1 hold() | **HIGH** | Compensation ordering |
| 5.2 capture/release | **HIGH** | Idempotency contracts; delta math |
| 5.3 Reaper | MEDIUM–HIGH | Multi-replica claim |
| 5.4 meter/reverse/getStatus | **HIGH** | Cross-store orchestration |
| 5.5 StreamUsageCollector | **HIGH** | Provider stream shapes; abort fallbacks |
| 5.6 Interceptor + @Meter | MEDIUM–HIGH | Guard hand-off |
| 5.7 OTel | LOW–MEDIUM | Attribute mapping |
| 5.8 Reporting | MEDIUM–HIGH | SQL groupBy dimensions; cache savings |
| 5.9 forRootAsync | LOW | Pattern copy |
| 5.10 Content sidecar | LOW | Opt-in hook |
| 5.11 E2E suite | **HIGH** | Ten scenarios; containers in CI |
| 5.12 Integration review | MEDIUM | Audit discipline |
| 6.x Release steps | LOW | Mechanical + gates |

---

## Appendix C — Reference Configs (mirror of nest-storage)

Tooling configs are copied from `../nest-storage/` (the family's most recent release) and adapted — same pattern nest-storage used from nest-auth:

| Source (nest-storage) | Adaptation for nest-ai-tokens |
| --- | --- |
| `tsconfig*.json` (6 variants) | Path aliases for **5** subpaths (`.`, `/shared`, `/prices`, `/prisma`, `/redis`) |
| `jest.config.ts` + coverage/e2e/stryker variants | `moduleNameMapper` ×5; e2e `testTimeout: 90_000` (Postgres + Redis containers) |
| `stryker.config.json` | Same thresholds (high 100 / low 95 / break 95) |
| `eslint.config.mjs` | Same flat v9 stack; keep `eslint-plugin-security` |
| `tsup.config.ts` | **Rewrite** — 5 entries; externals: `/^@nestjs\//`, `reflect-metadata`, `@prisma/client`, `ioredis`, `@nestjs/event-emitter`, `@opentelemetry/api` |
| `scripts/check-size.mjs` | **Rewrite** — 5 entries with §19.1 budgets |
| `.github/workflows/*` (4 files) | e2e job spins Postgres+Redis (Testcontainers handles it — needs Docker runner) |
| `.prettierrc`, `.gitignore`, `.npmignore`, `.npmrc` | Identical |
| `package.json` | Name/description/exports/peers per spec §3.2 + §18.2; devDeps add `fast-check`, `prisma`, `@testcontainers/postgresql` |

Canonical `package.json` fields, scripts block, and publishConfig: identical to nest-storage (Appendix of its plan / spec §14) — including `prepublishOnly` chain and `release: pnpm publish --provenance`.

---

## Appendix D — Glossary and Term Mapping

| Term | Meaning here | bymax-fitness equivalent |
| --- | --- | --- |
| **Usage record** | One immutable ledger row for one AI call (or its hold) | `AITokenTransaction` row |
| **Normalizer** | Pure function: provider `usage` → `NormalizedUsage` | (none — OpenAI shape read inline) |
| **Rating** | Resolving a price version + computing nano-USD cost | `PricingService.calculateCost` |
| **Markup** | Multiplier turning raw provider cost into billed customer price | (none) |
| **Hold → capture** | Reserve on estimate, settle on actuals (auth-hold model) | pre-check + post-success debit (non-atomic) |
| **Wallet** | Prepaid nano-USD balance (grants/debits/refunds/adjustments) | `Tenant.aiTokenBalance` (token-denominated) |
| **Grant** | A credit entry with priority/expiry, burned by debits | `monthly_allocation` / `purchase` transactions |
| **Budget** | A cap (spend/tokens/count) per scope per window | `Plan.aiTokensMonthly` / `maxAIGenerationsPerMonth` + `Subscription.*Used` counters |
| **Window anchor** | Per-budget cycle start (`anchorAt`) with month-end clamping | `renewalDate` (reset promise) |
| **Enforcement predicate** | The 5-clause rule deciding which records consume budgets | (implicit, inconsistent across two write paths) |
| **System cost** | Platform-absorbed usage, never billed to a customer | `isSystemCost` + `systemCostCategory` metadata |
| **Beneficiary** | The subject who received the value when ≠ payer | client in trainer-generates-for-client |
| **Scope** | `{ type: tenant\|team\|user\|key, id }` — the payer subject | `tokenPayerId` |
| **Provider-reported rating** | Trusting the gateway's dollar cost (OpenRouter `usage.cost`) | (none) |
| **Reaper** | Sweep that releases expired holds | (none — debits were post-hoc) |

---

_End of the `@bymax-one/nest-ai-tokens` development plan._
