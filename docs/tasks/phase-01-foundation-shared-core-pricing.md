# Phase 1 — Foundation + Shared Core + Pricing

> **Status**: 🔄 In Progress · **Progress**: 9 / 11 tasks · **Last updated**: 2026-07-02
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § 2
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md) (v0.2.0)
> **Complexity**: MEDIUM

---

## Context

The repository is empty (only `docs/`). This phase creates the full scaffold with four CI workflows, the entire zero-dependency `./shared` core (catalogs, canonical types, money utils, all nine provider usage normalizers, the tier+surcharge-aware cost engine), the `./prices` seed dataset, the error catalog, every port interface, DI tokens + options validation, `PricingService` with the six-step model-resolution chain, and the synchronous `BymaxAiTokensModule.forRoot()` with provider presets.

**Definition of Done (demo):** in a NestJS fixture app, a raw provider `usage` object (any of the nine providers) is normalized and rated to an exact, hand-verifiable `rawCostNanoUsd` and `billedCostNanoUsd` — no persistence yet (pricing store backed by an in-memory fake).

---

## Rules-of-phase

1. **Token economy.** Never read the spec or plan whole. Each prompt's REQUIRED READING lists exact `§` sections — Grep the heading (e.g. `grep -n '^### 6.6'` or `grep -n '^## 7\.'` in the doc), then Read only that line range. Never read other phase files.
2. **Money is bigint nano-USD** — no `number` arithmetic on any monetary value, anywhere. `fast-check` property tests are mandatory on money paths (plan §1.1).
3. **`src/shared/` is zero-dependency** — no imports of `@nestjs/*`, `@prisma/*`, `ioredis`, or `node:*` beyond what works in edge runtimes. Grep-verified per task.
4. **Reconciliation invariants (spec §5.5) are hard test requirements** for every normalizer — input side AND output side (the OpenAI reasoning subtraction is the audit's #1 billing bug).
5. **No provider SDKs** — normalizers consume plain objects; fixtures are hand-written JSON payloads mirroring real provider responses.
6. **100% line/branch coverage on every file implemented in this phase**; TS strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); zero `any`; JSDoc + `@fileoverview`/`@layer` on every file.
7. **Docs update on completion** — every task ends with the Completion Protocol (task file + master plan dashboard). A task without it is not done.
8. Tooling configs are adapted from `../nest-storage/` (plan Appendix C) — copy-and-adapt, do not invent.

---

## Reference docs

- [`../technical_specification.md`](../technical_specification.md) — §3 (structure/exports), §4 (config API), §5 (normalizer + catalogs), §6 (pricing), §7 (cost engine/markup/currency), §15.1 (ports), §16 (errors). Read per-task sections only.
- [`../development_plan.md`](../development_plan.md) — §2 (this phase's sub-steps §2.1–§2.11), §1.10 (cross-cutting rules), Appendix C (reference configs).
- `/bymax-workflow:standards` skill — universal coding rules.

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1.1 | Project scaffold + 4 CI workflows (5-subpath build) | ✅ Done | P0 | M | — |
| 1.2 | Shared catalogs and canonical types | ✅ Done | P0 | M | 1.1 |
| 1.3 | Money + idempotency utilities (nano-USD, deriveIdempotencyKey) | ✅ Done | P0 | M | 1.2 |
| 1.4 | Usage normalizers ×9 with reconciliation invariants | ✅ Done | P0 | L | 1.2, 1.3 |
| 1.5 | Pure cost engine (computeCostNanoUsd + applyMarkup) | ✅ Done | P0 | L | 1.2 |
| 1.6 | Price seed dataset (`./prices`) | ✅ Done | P0 | M | 1.2 |
| 1.7 | Error catalog (AiTokensException + maps) | ✅ Done | P0 | S | 1.2 |
| 1.8 | Port interfaces (storage, counter, tokenizer, telemetry, events, content, markup) | ✅ Done | P0 | M | 1.2, 1.7 |
| 1.9 | DI tokens + options validation + defaults | ✅ Done | P0 | M | 1.7, 1.8 |
| 1.10 | PricingService (resolution chain + cache + idempotent seed) | 📋 ToDo | P0 | L | 1.5, 1.6, 1.8, 1.9 |
| 1.11 | BymaxAiTokensModule.forRoot() + provider presets + fixture demo | 📋 ToDo | P0 | M | 1.4, 1.9, 1.10 |

---

## Tasks

### Task 1.1 — Project scaffold + 4 CI workflows (5-subpath build)

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: —

#### Description

Create the folder structure, all tooling configs (adapted from `../nest-storage/`), `package.json` with the five subpath exports and peer-only dependencies, the five-entry tsup build, and the four CI workflows — front-loaded so every PR is gated from the first one.

#### Acceptance criteria

- [x] `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass on the empty skeleton
- [x] `pnpm build` produces `dist/{server,shared,prices,prisma,redis}/index.{mjs,cjs,d.ts}`
- [x] The four workflows are valid and incremental-safe (`passWithNoTests`); `release.yml` inert until a `v*.*.*` tag
- [x] `package.json` matches spec §3.2 exports and §18.2 peers exactly; `"dependencies": {}`
- [x] eslint flat v9 (`strictTypeChecked` + `stylisticTypeChecked` + prettier); zero warnings

#### Files to create / modify

`.github/workflows/{ci,codeql,scorecard,release}.yml` · `.gitignore` · `.prettierrc` · `.npmignore` · `.npmrc` · `eslint.config.mjs` · `jest.config.ts` (+ `coverage`/`e2e`/`stryker` variants) · `stryker.config.json` · `tsconfig.json` (+ `build`/`server`/`e2e`/`jest`/`eslint` variants) · `tsup.config.ts` · `package.json` · `scripts/check-size.mjs` · `src/{server,shared,prices,prisma,redis}/index.ts` (placeholders)

#### Agent prompt

````
You are a senior TypeScript infrastructure engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11 (provider usage normalizer → versioned pricing → immutable ledger → wallets/budgets
→ markup). TypeScript 5.x strict, pnpm@10, Node >= 24, tsup dual-format (ESM+CJS) build with
FIVE subpaths (".", "./shared", "./prices", "./prisma", "./redis"), Jest with a 100% coverage
floor, zero runtime dependencies (peers only). Public npm package, MIT.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.1 of 11 (FIRST)

PRECONDITIONS
- The repo contains only docs/ (spec + plan + tasks) and .git. No source, no configs yet.
- The sibling repo ../nest-storage is checked out locally and is the canonical config donor.

REQUIRED READING (only these sections — do NOT read whole files; Grep each heading, read that range):
- docs/technical_specification.md § "3.2 Subpath exports" (the exports map) and § "18.2 Peer
  dependencies" + § "18.3 Rationale" (peers: only @nestjs/common, @nestjs/core, reflect-metadata
  required; @prisma/client, ioredis, @nestjs/event-emitter, @opentelemetry/api optional).
- docs/development_plan.md § "2.1 Project scaffold + CI workflows" and § "Appendix C — Reference
  Configs" (the copy-and-adapt table from ../nest-storage).
- Donor files in ../nest-storage/: package.json, tsup.config.ts, eslint.config.mjs,
  jest.config.ts, tsconfig.json, .github/workflows/*.yml — read each donor file ONCE, adapt.

TASK
Scaffold the repository: tooling configs adapted from nest-storage, package.json for a
five-subpath peer-only package (version 0.1.0-alpha.0), a five-entry tsup config, and the four
CI workflows (ci / codeql / scorecard / release), all green on an empty skeleton.

DELIVERABLES

1. `package.json` — name @bymax-one/nest-ai-tokens, version 0.1.0-alpha.0, "type": "module",
   sideEffects false, files [dist, LICENSE, README.md, CHANGELOG.md], exports per spec §3.2
   (five subpaths), scripts identical to nest-storage's set (build/lint/test/test:cov/test:e2e/
   test:cov:all/mutation*/typecheck/size/clean/prepublishOnly/release), "dependencies": {},
   peerDependencies + peerDependenciesMeta per spec §18.2, devDependencies from nest-storage's
   list ADAPTED: drop @aws-sdk/* and @testcontainers/minio; add @prisma/client, prisma, ioredis,
   @nestjs/event-emitter, @opentelemetry/api, @testcontainers/postgresql, fast-check.
   packageManager pnpm@10.x, engines node >=24, publishConfig { access: public, provenance: true }.

2. `tsup.config.ts` — FIVE entries: server/index, shared/index, prices/index, prisma/index,
   redis/index. All: format [esm, cjs], dts true, target node24, splitting false, treeshake true.
   Externals: /^@nestjs\//, reflect-metadata, @prisma/client, ioredis, @nestjs/event-emitter,
   @opentelemetry/api.

3. `tsconfig.json` + variants (build/server/e2e/jest/eslint) — copy nest-storage's, swap path
   aliases to the five subpaths (@bymax-one/nest-ai-tokens, .../shared, .../prices, .../prisma,
   .../redis). Strict mode: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes.

4. `jest.config.ts` + coverage/e2e/stryker variants — moduleNameMapper for the five subpaths;
   coverageThreshold.global 100% (branches/functions/lines/statements); e2e variant
   rootDir test/e2e, testTimeout 90_000. `stryker.config.json` thresholds high 100/low 95/break 95.

5. `eslint.config.mjs`, `.prettierrc`, `.gitignore`, `.npmignore`, `.npmrc` — copy from
   nest-storage (eslint: flat v9, strictTypeChecked + stylisticTypeChecked + prettier; keep
   eslint-plugin-security; spec-file relaxations for *.spec.ts).

6. `scripts/check-size.mjs` — five entries with budgets (brotli): server < 40 KB,
   shared < 10 KB, prisma < 15 KB, redis < 5 KB; prices EXEMPT (data — report size only).

7. `.github/workflows/ci.yml` (verify job: dependency-review, typecheck, lint, test:cov 100%,
   build-integrity across 5 subpaths, size; e2e job: Docker for Testcontainers Postgres+Redis —
   passWithNoTests so it is green before tests exist), `codeql.yml` (per-PR + weekly),
   `scorecard.yml`, `release.yml` (tag-driven v*.*.*; npm publish --provenance; inert until tagged).

8. `src/{server,shared,prices,prisma,redis}/index.ts` — placeholder files with an @fileoverview
   header comment only, so typecheck/build pass.

Constraints:
- Copy-and-adapt from ../nest-storage — do not invent config shapes (plan Appendix C table).
- "dependencies": {} is non-negotiable.
- Follow /bymax-workflow:standards: TS strict, English comments only, no suppression comments.

Verification:
- `pnpm install && pnpm typecheck && pnpm lint && pnpm build` — expected: all pass.
- `ls dist/server/index.mjs dist/shared/index.mjs dist/prices/index.mjs dist/prisma/index.mjs dist/redis/index.mjs` — expected: all exist (+ .cjs and .d.ts).
- `node -e "console.log(require('./package.json').dependencies)"` — expected: {} or undefined.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump this file's header progress to 1/11. 5. Update the Phase 1 row in
docs/development_plan.md §1.5 (Progress 1/11, Last updated) and §1.4 overall counters — touch
nothing else there. 6. Append to Completion log: `- 1.1 ✅ <YYYY-MM-DD> — <one-line summary>`.
7. Commit `docs(plan): complete task 1.1` (no Co-Authored-By).
````

---

### Task 1.2 — Shared catalogs and canonical types

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.1

#### Description

Implement the entire `./shared` type surface — provider/operation/tier/token-category catalogs and every canonical type the rest of the library consumes (`NormalizedUsage`, `UsageRecord`, `PriceVersion`, wallet/budget/report/event types, error codes).

#### Acceptance criteria

- [x] Every symbol listed in spec §3.3 "Shared" exists and is exported from the barrel
- [x] Zero imports of `@nestjs/*`, `@prisma/*`, `ioredis` under `src/shared/` (grep-verified)
- [x] Constants `as const`; types via `import type`; `(string & {})` on `ProviderId` preserves autocomplete
- [x] `pnpm typecheck` passes; no `any`

#### Files to create / modify

`src/shared/constants/{provider-ids,operations,service-tiers,token-categories,wallet-entry-types,error-codes}.constants.ts` · `src/shared/types/{catalogs,normalized-usage,usage-record,price-version,wallet,budget,report,events,error-types}.ts` · `src/shared/index.ts`

#### Agent prompt

````
You are a senior TypeScript library engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. TypeScript 5.x strict, pnpm@10, Node >= 24, five subpaths, Jest 100% coverage floor,
zero runtime dependencies. src/shared/ must stay framework-free (usable in browsers/edge).

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.2 of 11 (MIDDLE)

PRECONDITIONS
- Task 1.1 done: scaffold builds; src/shared/index.ts is an empty placeholder.

REQUIRED READING (only these sections — do NOT read whole files; Grep each heading first):
- docs/technical_specification.md § "5.1 Catalogs" (ProviderId, AiOperation, ServiceTier,
  RatingMode, TokenCategory, MeteringScope, UsageNormalizer — copy VERBATIM), § "5.2
  NormalizedUsage" (the full interface), § "8.2 UsageRecord" (UsageStatus + every column),
  § "6.2 PriceVersion", § "9.1 Types" (WalletRef/Wallet/WalletEntryType/WalletEntry),
  § "10.1 Budget" + § "10.6 Status API" (Budget/BudgetWindowKind/BudgetPolicy/BudgetStatus/
  AccessStatus), § "13.1 UsageReportService" (ReportFilter/UsageSummary), § "15.1 Store ports"
  (LedgerFilter/NewUsageRecord/NewPriceVersion/NewWalletEntry — types only, NOT the port
  interfaces, which are Task 1.8), § "12.1 Envelope" + § "12.2 Event catalog" (AiTokensEvent +
  event type union + payload interfaces), § "16.2 Code table" (AI_TOKENS_ERROR_CODES keys),
  § "4.3 Provider presets" (the ProviderPreset interface only).
- docs/technical_specification.md § "3.3 Public exports" subsection "Shared" — your export
  checklist.

TASK
Create the complete zero-dependency shared type surface: constants files (as-const objects +
derived union types) and type files, exactly as defined in the spec sections above, with a
barrel index.ts exporting everything on the §3.3 Shared checklist.

DELIVERABLES

1. src/shared/constants/*.constants.ts — PROVIDER_IDS, AI_OPERATIONS, SERVICE_TIERS,
   TOKEN_CATEGORIES, WALLET_ENTRY_TYPES, AI_TOKENS_ERROR_CODES (all `as const`, each with a
   derived union type export, JSDoc on each entry group).
2. src/shared/types/*.ts — the canonical interfaces per the spec sections listed above. Types
   only; no logic. bigint fields typed bigint. JSDoc lifted from the spec's field comments
   (condense, keep normative notes like the §5.2 outputTokens-excludes-reasoning rule).
3. src/shared/index.ts — barrel exporting the full §3.3 "Shared" checklist minus the
   normalizers/pure-math/deriveIdempotencyKey (those are Tasks 1.3–1.5; leave TODO-free —
   just don't export what doesn't exist yet).

Constraints:
- Zero runtime logic in this task — types and constants only.
- No imports from @nestjs/*, @prisma/*, ioredis, or node:* modules.
- `import type` for type-only imports; `as const` on every constant object.
- Follow /bymax-workflow:standards: JSDoc on every export, @fileoverview + @layer headers,
  English comments only.

Verification:
- `pnpm typecheck` — expected: pass, zero errors.
- `grep -rn '@nestjs\|@prisma\|ioredis\|from .node:' src/shared/` — expected: no matches.
- `pnpm build && node -e "import('./dist/shared/index.mjs').then(m => console.log(Object.keys(m).sort()))"`
  — expected: lists PROVIDER_IDS, AI_OPERATIONS, SERVICE_TIERS, TOKEN_CATEGORIES,
  WALLET_ENTRY_TYPES, AI_TOKENS_ERROR_CODES (types are erased — constants visible).

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 2/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.2 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.2`.
````

---

### Task 1.3 — Money + idempotency utilities

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.2

#### Description

The exact-arithmetic foundation: nano-USD bigint helpers (`formatNanoUsd`, float→nano round-half-up conversion) and `deriveIdempotencyKey(payload)` (stable canonical-JSON sha256, pure sync implementation).

#### Acceptance criteria

- [x] `fast-check` property suite: formatNanoUsd round-trips known values; float→nano conversion round-half-up, exact for costs < $1,000; no `number` intermediate on money paths
- [x] `deriveIdempotencyKey` stable under key order (`{a:1,b:2}` ≡ `{b:2,a:1}`), distinct for distinct payloads
- [x] Pure — no `node:crypto` hard dependency (pure-TS sha256, sync, edge-safe)

#### Files to create / modify

`src/shared/pricing/money.ts` · `src/shared/utils/idempotency.ts` (+ spec files)

#### Agent prompt

````
You are a senior TypeScript engineer specializing in financial-grade arithmetic, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. All money is integer nano-USD (bigint, 1e-9 USD). TypeScript 5.x strict, Jest 100%
coverage, fast-check for property tests. src/shared/ is zero-dependency and edge-safe.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.3 of 11 (MIDDLE)

PRECONDITIONS
- Tasks 1.1–1.2 done: scaffold builds; shared catalogs/types exist.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "7.1 Money is an integer — nano-USD" (the arithmetic rules
  and the per-million pattern), § "7.4 Currency rule (normative)" (formatNanoUsd is the
  presentation helper), § "8.4 Exactly-once via idempotency keys" (deriveIdempotencyKey is a
  HOST-side helper, sha256 of the canonical payload), and the § "5.3" OpenRouter table row
  (float usage.cost → nano-USD, round-half-up).
- docs/development_plan.md § "2.3 Money and idempotency utilities" (acceptance criteria + the
  sync-pure-sha256 decision note).

TASK
Implement the money utilities and the idempotency-key derivation helper as pure, synchronous,
zero-dependency functions with exhaustive property tests.

DELIVERABLES

1. src/shared/pricing/money.ts:
   - `formatNanoUsd(nanoUsd: bigint, opts?: { currency?: string; fxRateNano?: bigint; decimals?: number }): string`
     — presentation only (default "$0.005000" style, USD); with fxRateNano converts at
     presentation time. Rounding to displayed decimals: round-half-up, computed in bigint.
   - `floatUsdToNanoUsd(usd: number): bigint` — round-half-up at nano precision
     (BigInt(Math.round(usd * 1e9)) is NOT acceptable verbatim if it loses precision — split
     integer/fraction handling so costs < $1,000 are exact; document the bound).
   - `perMillion(tokens: number, ratePerMillionNano: bigint): bigint` — the §7.1 building block:
     (BigInt(tokens) * rate) / 1_000_000n.
2. src/shared/utils/idempotency.ts:
   - `deriveIdempotencyKey(payload: unknown): string` — canonical JSON (recursively sorted
     object keys, stable array order, bigint→string, undefined dropped) hashed with a pure-TS
     synchronous sha256 (implement it in-file or as a tiny internal util — NO node:crypto, NO
     async WebCrypto; it must run identically in Node/edge/browser). Return hex.
3. Property tests (fast-check) + fixture tests for both files. Include the worked example from
   spec §7.1: 1,000 tokens at 5_000_000_000n per million → 5_000_000n.
4. Export all three money functions + deriveIdempotencyKey from src/shared/index.ts.

Constraints:
- No `number` arithmetic on monetary values beyond the documented float→nano entry conversion.
- Pure sync; zero deps; edge-safe.
- Follow /bymax-workflow:standards: JSDoc with @example on each export, English only.

Verification:
- `pnpm test -- --testPathPattern='money|idempotency'` — expected: green, incl. property suites.
- `pnpm test:cov -- --testPathPattern='money|idempotency'` — expected: 100% on both files.
- `grep -n 'node:crypto\|crypto.subtle' src/shared/` — expected: no matches.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 3/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.3 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.3`.
````

---

### Task 1.4 — Usage normalizers ×9 with reconciliation invariants

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 1.2, 1.3

#### Description

One pure normalizer per provider shape (OpenAI Chat, OpenAI Responses, OpenAI-compatible, Anthropic, Gemini, Bedrock Converse, Mistral, OpenRouter, Vercel AI SDK v5+v6), each satisfying the input-side and output-side reconciliation invariants.

#### Acceptance criteria

- [x] Each normalizer has fixture tests with realistic payloads (streaming-final and non-streaming where shapes differ)
- [x] Property tests assert both spec §5.5 invariants per adapter
- [x] Malformed input throws a plain `Error` (server layer wraps later); shared code never imports the exception class
- [x] `serviceTier` read from the response where reported (OpenAI `service_tier`, Anthropic `usage.service_tier`)
- [x] Unknown fields preserved in `raw`

#### Files to create / modify

`src/shared/normalizers/{openai-chat,openai-responses,openai-compatible,anthropic,gemini,bedrock-converse,mistral,openrouter,vercel-ai-sdk}.normalizer.ts` · `src/shared/normalizers/index.ts` (+ spec files with fixtures)

#### Agent prompt

````
You are a senior TypeScript engineer with deep knowledge of LLM provider APIs, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The normalizers are the heart: pure functions mapping each provider's raw `usage`
object into the canonical NormalizedUsage. Zero deps, TypeScript strict, Jest 100% + fast-check.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.4 of 11 (MIDDLE)

PRECONDITIONS
- Tasks 1.1–1.3 done: shared types (NormalizedUsage, catalogs) and floatUsdToNanoUsd exist.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "5.2 NormalizedUsage" (the target shape), § "5.3
  Per-provider field mapping" (THE normative table — every source field per provider, incl.
  the OpenAI reasoning SUBTRACTION rule, Gemini thoughtsTokenCount→reasoningTokens +
  toolUsePromptTokenCount→inputTokens, Anthropic cache TTL split + server_tool_use, Bedrock
  cacheDetails, OpenRouter cost conversion, Vercel AI SDK v5+v6 dual shape), § "5.5
  Reconciliation invariants" (the two hard test invariants), § "5.1 Catalogs" (ProviderId
  values only, quick check).
- docs/development_plan.md § "2.4 Usage normalizers (all nine)" (acceptance criteria + risk
  notes: reasoning-subtraction is the #1 billing bug; Mistral maps prompt/completion only).

TASK
Implement the nine pure normalizers exactly per the §5.3 mapping table, with realistic JSON
fixtures and property tests proving both §5.5 invariants for every adapter.

DELIVERABLES

1. Nine files src/shared/normalizers/<provider>.normalizer.ts, each exporting one
   `normalize<X>Usage: UsageNormalizer` pure function:
   - openai-chat: prompt_tokens/completion_tokens + details; outputTokens =
     completion_tokens − (completion_tokens_details.reasoning_tokens ?? 0); cached_tokens →
     cacheReadTokens; audio detail fields; response.service_tier + response.model.
   - openai-responses: input_tokens/output_tokens naming + same subtraction on
     output_tokens_details.reasoning_tokens.
   - openai-compatible: the chat shape without OpenAI-specific detail assumptions; factory
     use comes later via presets (this is just the normalizer; DeepSeek prompt_cache_hit_tokens
     → cacheReadTokens when present).
   - anthropic: input_tokens/output_tokens (reasoningTokens: 0 — thinking already included);
     cache_creation_input_tokens (+ cache_creation.ephemeral_5m/1h split when present) →
     cacheWrite5m/1h; cache_read_input_tokens; usage.service_tier; usage.server_tool_use →
     serverToolUse.
   - gemini: promptTokenCount→input (+ toolUsePromptTokenCount folded into input),
     candidatesTokenCount→output (EXCLUDES thoughts — no subtraction),
     thoughtsTokenCount→reasoning, cachedContentTokenCount→cacheRead.
   - bedrock-converse: inputTokens/outputTokens/cacheReadInputTokens/cacheWriteInputTokens
     (+ cacheDetails[] TTL entries → cacheWrite5m/1h; unsplit write defaults to 5m — document).
   - mistral: prompt_tokens/completion_tokens only; everything else verbatim into raw.
   - openrouter: prompt/completion + details (cached_tokens, cache_write_tokens→cacheWrite5m,
     reasoning subtraction like OpenAI); usage.cost (float USD) → providerReportedCostNanoUsd
     via floatUsdToNanoUsd; cost_details preserved in raw.
   - vercel-ai-sdk: v5 shape (usage.inputTokens/outputTokens/cachedInputTokens/reasoningTokens)
     AND v6 shape (inputTokenDetails.cacheReadTokens/cacheWriteTokens,
     outputTokenDetails.reasoningTokens) — detect and read both; model/provider must be supplied
     by the caller context, so accept them via a second optional arg or leave empty for the
     caller to fill (follow the UsageNormalizer single-arg type: emit model '' when absent and
     document that presets/context override it).
2. index.ts barrel + export from src/shared/index.ts.
3. Fixture tests: at least one realistic full payload per provider (write them by hand from the
   §5.3 field lists — do NOT fetch anything), plus streaming-final variants for OpenAI (last
   chunk with empty choices) and Anthropic (message_delta cumulative shape as a plain object).
4. Property tests (fast-check): generate payloads per provider and assert BOTH §5.5 invariants:
   input side (totalInput = input + cacheRead + cacheWrite5m + cacheWrite1h) and output side
   (providerTotalOutput = outputTokens + reasoningTokens). For OpenAI generators include
   reasoning_tokens > 0 cases and assert outputTokens + reasoningTokens === completion_tokens.

Constraints:
- Pure functions over `unknown`; narrow with type guards, never cast blindly; malformed input
  → throw new Error('<provider>: <what is missing>') (plain Error — no NestJS imports here).
- Missing optional detail fields default to 0; unknown extra fields land in `raw`.
- Follow /bymax-workflow:standards: JSDoc + @example per normalizer, English only.

Verification:
- `pnpm test -- --testPathPattern='normalizers'` — expected: green (fixtures + properties).
- `pnpm test:cov -- --testPathPattern='normalizers'` — expected: 100% per normalizer file.
- `grep -rn '@nestjs' src/shared/normalizers/` — expected: no matches.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 4/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.4 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.4`.
````

---

### Task 1.5 — Pure cost engine (computeCostNanoUsd + applyMarkup)

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 1.2

#### Description

`computeCostNanoUsd` (tier + surcharge aware, token/surcharge parts separable) and `applyMarkup` (4-decimal-place exact bigint math) — the billing-correctness core.

#### Acceptance criteria

- [x] Worked examples from spec §7.1 pass exactly (1,000 Opus input tokens → 5_000_000n)
- [x] Tier boundary tests: at/below/above `tierThresholdTokens` (threshold counts ALL input-side categories)
- [x] Surcharge tests: units in `serverToolUse` missing from `unitRates` are ignored; and vice versa
- [x] `applyMarkup` property tests: m=1.0 identity; 4-dp rounding; truncation-toward-zero; rejects non-finite/≤0
- [x] Return shape exposes `{ totalNanoUsd, tokenNanoUsd, surchargeNanoUsd }`

#### Files to create / modify

`src/shared/pricing/compute-cost.ts` · `src/shared/pricing/apply-markup.ts` (+ spec files)

#### Agent prompt

````
You are a senior TypeScript engineer specializing in financial-grade arithmetic, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. All money is bigint nano-USD; rates are nano-USD per 1,000,000 tokens. This task is
the billing-correctness core. Zero deps, TS strict, Jest 100% + fast-check.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.5 of 11 (MIDDLE)

PRECONDITIONS
- Tasks 1.1–1.2 done: NormalizedUsage and PriceVersion types exist; perMillion util exists (1.3
  may land in parallel — if perMillion is absent, implement it here in compute-cost and let 1.3
  re-export; coordinate via the barrel).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "7.1 Money is an integer — nano-USD" (the REFERENCE
  IMPLEMENTATION of computeCostNanoUsd — tier all-or-nothing + surcharge loop; transcribe it,
  then extend per the acceptance criteria), § "7.2 Markup / margin" (applyMarkup signature,
  validation, 4-dp rounding, truncation-toward-zero formula), § "6.2 PriceVersion" (rate fields
  incl. tier fields + unitRates).
- docs/development_plan.md § "2.5 Pure cost engine" (acceptance criteria incl. the
  {totalNanoUsd, tokenNanoUsd, surchargeNanoUsd} return shape).

TASK
Implement the two pure pricing functions with exhaustive boundary and property tests.

DELIVERABLES

1. src/shared/pricing/compute-cost.ts — `computeCostNanoUsd(u: NormalizedUsage, r: PriceVersion)`
   returning `{ totalNanoUsd, tokenNanoUsd, surchargeNanoUsd }` (all bigint). Follow the spec
   §7.1 reference implementation exactly: per-million integer math on the ten token categories;
   long-context tier is ALL-OR-NOTHING (totalInput = input + cacheRead + cacheWrite5m +
   cacheWrite1h; when > tierThresholdTokens use tierInput/tierOutput rates, falling back to base
   when a tier rate is absent); surcharges = Σ serverToolUse[unit] × unitRates[unit] over units
   present in BOTH maps.
2. src/shared/pricing/apply-markup.ts — `applyMarkup(rawCostNanoUsd: bigint, multiplier: number): bigint`
   with `billed = (raw * BigInt(Math.round(m * 10_000))) / 10_000n`; validates finite and > 0
   (throw RangeError otherwise); rounds the multiplier to 4 dp before applying; document
   truncation-toward-zero on the division. Also export `resolveMultiplier4dp(m: number): number`
   (the validated/rounded value — persisted later on records).
3. Tests: the spec §7.1 worked example; tier boundary triple (below/at/above — note "at" is NOT
   over: strict >); surcharge intersection semantics; fast-check properties for applyMarkup
   (identity at 1.0; monotonicity; 4-dp stability: applyMarkup(x, 1.23456) ===
   applyMarkup(x, 1.2346)).
4. Export both + the return type from src/shared/index.ts.

Constraints:
- Pure; zero deps; bigint-only money paths; no float beyond the multiplier entry point.
- Follow /bymax-workflow:standards: JSDoc with @example, English only.

Verification:
- `pnpm test -- --testPathPattern='compute-cost|apply-markup'` — expected: green.
- `pnpm test:cov -- --testPathPattern='compute-cost|apply-markup'` — expected: 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 5/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.5 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.5`.
````

---

### Task 1.6 — Price seed dataset (`./prices`)

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.2

#### Description

The pinned `MODEL_PRICES_SEED` snapshot in its own data-only subpath, converted offline from LiteLLM's price map (tier fields + unit rates included), validated against the `PriceVersion` row shape.

#### Acceptance criteria

- [x] Seed covers: current OpenAI GPT-5.x family + embeddings, Anthropic Opus/Sonnet/Haiku (cache rates 1.25×/2×/0.1× of input), Gemini Pro/Flash (incl. long-context tier rows), Mistral Large/Medium/Small, DeepSeek/xAI/Groq headline models
- [x] Every entry validates against the `PriceVersion` row schema (typed, no floats)
- [x] Snapshot date + source recorded in the file header (`source: 'snapshot'`)
- [x] `./shared` does NOT import `./prices`

#### Files to create / modify

`src/prices/index.ts` · `src/prices/model-prices.seed.ts` · `scripts/convert-litellm-prices.mjs` (+ spec file)

#### Agent prompt

````
You are a senior TypeScript engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The ./prices subpath is a DATA-ONLY module: a pinned snapshot of per-model prices
in bigint nano-USD per million tokens, seeded into the host's price registry on first boot.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.6 of 11 (MIDDLE)

PRECONDITIONS
- Tasks 1.1–1.2 done: PriceVersion type and catalogs exist; the prices subpath entry is a
  placeholder.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "6.4 The seed dataset" (source + conversion + pinning
  rationale), § "6.2 PriceVersion" (target row shape incl. serviceTier, tier fields, unitRates
  as nano-USD-per-unit), § "5.1 Catalogs" (ProviderId/AiOperation/ServiceTier values).
- docs/development_plan.md § "2.6 Price seed dataset" (coverage list + risks: rates must be
  spot-checked; do NOT wire live fetching).

TASK
Author the seed dataset (hand-curated from the coverage list — you are OFFLINE: use the rate
knowledge embedded in the spec/plan and standard published prices; every rate carries a source
comment) plus the conversion script committed for provenance, and the validation test.

DELIVERABLES

1. src/prices/model-prices.seed.ts — `MODEL_PRICES_SEED: readonly SeedPriceRow[]` where
   SeedPriceRow = Omit<PriceVersion, 'id' | 'effectiveFrom' | 'effectiveTo'> & { }; rates as
   bigint literals (e.g. 5_000_000_000n = $5/M). Cover AT MINIMUM (standard tier unless noted):
   - openai: gpt-5.x family chat rows (+ cached-input rate as cacheRead), text-embedding-3-small
     ($0.02/M) + -large ($0.13/M) as operation 'embeddings' with output rate 0n; batch/flex tier
     rows where the family has published discounts (≈50% of standard — mark source comments).
   - anthropic: current Opus/Sonnet/Haiku chat rows with cacheRead = 0.1× input,
     cacheWrite5m = 1.25× input, cacheWrite1h = 2× input; batch tier rows at 50%.
   - gemini: Pro + Flash rows incl. long-context tier rows (tierThresholdTokens 200_000,
     tier rates ≈ 2× input where published); cacheRead ≈ 10% input.
   - mistral: Large/Medium/Small chat rows.
   - deepseek / xai / groq: one headline chat model each.
   Every row: a trailing comment `// source: <provider pricing page> snapshot 2026-07`.
2. src/prices/index.ts — export MODEL_PRICES_SEED + SeedPriceRow type. Header comment records
   snapshot date + methodology.
3. scripts/convert-litellm-prices.mjs — the offline converter (reads a local
   model_prices_and_context_window.json path from argv, emits seed rows mapping
   input_cost_per_token → inputNanoUsdPerMillion etc., incl. *_batches/_flex/_priority tier
   fields and search_context_cost_per_query → unitRates). Committed for provenance/refresh —
   NOT executed in CI, NOT imported by src/.
4. Test: every seed row round-trips the PriceVersion shape (type-level + runtime guard),
   no duplicate (provider, model, operation, serviceTier) pairs, all rates >= 0n.

Constraints:
- Data only — no runtime logic in ./prices beyond the exported array.
- ./shared must not import ./prices (grep-verified); the server (Task 1.10) imports it lazily.
- Rates you are not certain of: include with a `// VERIFY:` comment rather than omitting the
  model — the review pass checks them (plan §2.6 risk note).

Verification:
- `pnpm test -- --testPathPattern='prices'` — expected: green.
- `pnpm build && du -h dist/prices/` — expected: builds; size reported.
- `grep -rn "from '.*prices" src/shared/` — expected: no matches.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 6/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.6 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.6`.
````

---

### Task 1.7 — Error catalog

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: S
- **Depends on**: 1.2

#### Description

`AiTokensException extends HttpException` plus the exhaustive, compiler-enforced code→message and code→status maps for the 15 error codes.

#### Acceptance criteria

- [x] Maps typed `Record<keyof typeof AI_TOKENS_ERROR_CODES, …>` (exhaustiveness compiler-enforced)
- [x] Only `AI_TOKENS_ERROR_CODES`, `AiTokensException`, `AiTokensErrorResponse` public; maps internal
- [x] Response body `{ error: { code, message, details? } }` snapshot-tested

#### Files to create / modify

`src/server/errors/{ai-tokens-exception,ai-tokens-error-messages,ai-tokens-error-status}.ts` (+ spec file)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. TS strict, Jest 100%. Error pattern mirrors the sibling @bymax-one/nest-storage:
a typed HttpException subclass + internal exhaustive maps.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.7 of 11 (MIDDLE)

PRECONDITIONS
- Tasks 1.1–1.2 done: AI_TOKENS_ERROR_CODES const + AiTokensErrorResponse type exist in shared.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "16.1 AiTokensException class" (the class, verbatim) and
  § "16.2 Code table" (all 15 codes with HTTP statuses and when-it-occurs semantics — the
  message text derives from the "When it occurs" column, condensed to one actionable sentence).

TASK
Implement the exception class and the two internal exhaustive maps in src/server/errors/,
exporting only the public trio from the server layer.

DELIVERABLES

1. src/server/errors/ai-tokens-error-messages.ts — internal
   `AI_TOKENS_ERROR_MESSAGES: Record<keyof typeof AI_TOKENS_ERROR_CODES, string>`.
2. src/server/errors/ai-tokens-error-status.ts — internal
   `AI_TOKENS_ERROR_STATUS: Record<keyof typeof AI_TOKENS_ERROR_CODES, HttpStatus>` matching
   the §16.2 HTTP column exactly (402/429/404/410/409/422/400/500/502/503).
3. src/server/errors/ai-tokens-exception.ts — the §16.1 class verbatim (constructor defaults
   statusCode from the status map; body { error: { code, message, details? } }).
4. Spec file: one throw per code asserting status + body shape (snapshot), plus a
   type-level exhaustiveness test (adding a code without a map entry fails typecheck — assert
   via a satisfies expression).

Constraints:
- Codes/response type import from ../../shared (single source).
- Maps NOT exported from the server barrel (public surface: exception + codes + response type).
- Follow /bymax-workflow:standards: JSDoc, English only.

Verification:
- `pnpm test -- --testPathPattern='errors'` — expected: green, 100% coverage.
- `pnpm typecheck` — expected: pass.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 7/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.7 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.7`.
````

---

### Task 1.8 — Port interfaces

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.2, 1.7

#### Description

Every port contract the module wires: the four storage ports + counter port, plus tokenizer, telemetry, event-sink, content-store, markup-policy, and the module-options/metering-context/hold interfaces.

#### Acceptance criteria

- [x] Every port interface from spec §3.3 exists with JSDoc lifted from the spec's normative text
- [x] `BymaxAiTokensModuleAsyncOptions` follows the NestJS async dynamic-module pattern
- [x] No `any`; discriminated unions for `HoldEstimate`

#### Files to create / modify

`src/server/interfaces/{ai-tokens-store,ledger-store,pricing-store,wallet-store,budget-store,budget-counter-store,tokenizer,telemetry-sink,event-sink,content-store,markup-policy,metering-context,hold,module-options}.interface.ts` · `src/server/interfaces/index.ts`

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Persistence is abstracted behind ports (hexagonal); the official Prisma adapter and
a Redis counter implement them later. TS strict, zero `any`.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.8 of 11 (MIDDLE)

PRECONDITIONS
- Tasks 1.2 + 1.7 done: shared types (UsageRecord, PriceVersion, Wallet*, Budget*, LedgerFilter,
  NewUsageRecord, …) and the error catalog exist.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "15.1 Store ports" (ILedgerStore, IPricingStore,
  IWalletStore, IBudgetStore, IBudgetCounterStore — transcribe signatures VERBATIM, incl.
  transition(id, from, to, patch) null-on-mismatch and the multi-dimension conditionalConsume),
  § "4.1 BymaxAiTokensModuleOptions" (the full options interface + IAiTokensStore bundle with
  Partial wallet/budget halves), § "11.1 MeteringService" (ONLY the MeteringContext, Hold,
  HoldEstimate, MeterResult type blocks — not the service), § "7.2" (IMarkupPolicy), § "14.1"
  (ITelemetrySink), § "14.2" (IContentStore), § "12.1" (IEventSink).
- ../nest-storage/src/server/interfaces/storage-module-options.interface.ts — ONLY the
  BymaxStorageModuleAsyncOptions block at the end (the async-options pattern to mirror).

TASK
Create every port and options interface in src/server/interfaces/ with a barrel, transcribing
the spec's normative signatures exactly (they were audit-hardened — do not "improve" them).

DELIVERABLES

1. The 14 interface files listed in the task header, each with @fileoverview + JSDoc per
   member (condensed from the spec's inline comments).
2. module-options.interface.ts also defines BymaxAiTokensModuleAsyncOptions +
   BymaxAiTokensModuleOptionsFactory following the nest-storage async pattern
   (useFactory/useClass/useExisting + imports/inject).
3. index.ts barrel; re-export from src/server/index.ts (types only — no implementations yet).

Constraints:
- Signatures VERBATIM from spec §15.1/§4.1/§11.1 — any mismatch is a defect.
- ExecutionContext type for scopeResolver comes from @nestjs/common (type-only import).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm typecheck` — expected: pass.
- `grep -n ': any\b' src/server/interfaces/` — expected: no matches.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 8/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.8 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.8`.
````

---

### Task 1.9 — DI tokens + options validation + defaults

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.7, 1.8

#### Description

The `Symbol()` injection tokens, `validateOptions()` (every §4.6 rule → `AI_TOKENS_INVALID_CONFIG` with actionable reason), and `applyDefaults()` → `ResolvedAiTokensOptions`.

#### Acceptance criteria

- [x] Every invalid-config case from spec §4.6 throws with an actionable `details.reason`
- [x] `wallets: {}` with a store missing `conditionalDebit` fails at init (feature-port validation)
- [x] Defaults exactly match spec §4.2 (holds TTL 3600, reaper 300, thresholds [0.8, 1.0], burnOrder 'expiry', failClosed true, …)

#### Files to create / modify

`src/server/bymax-ai-tokens.constants.ts` · `src/server/config/{validate-options,apply-defaults,resolved-options,default-options.constants}.ts` (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Config follows the family pattern: Symbol tokens, validateOptions() throwing a typed
exception, applyDefaults() producing a fully-resolved options object services consume.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.9 of 11 (MIDDLE)

PRECONDITIONS
- Tasks 1.7–1.8 done: AiTokensException and all option/port interfaces exist.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "4.5 Injection tokens" (the 11 Symbol names), § "4.2
  Summary of required options and defaults" (the defaults table — transcribe exactly), § "4.6
  Wiring and precedence rules" (validation rules: feature-port checks, AI_TOKENS_FX_REQUIRED
  when currency !== 'USD' without fx, markup validation, NOT_CONFIGURED semantics), § "7.2"
  (markup multiplier validation rules — reuse resolveMultiplier4dp from Task 1.5).
- docs/development_plan.md § "2.9 DI tokens, options validation, defaults" (acceptance criteria).

TASK
Implement the DI tokens, the validator, the defaults-resolver, and a ResolvedAiTokensOptions
type where every optional block is either resolved-with-defaults or explicitly disabled.

DELIVERABLES

1. src/server/bymax-ai-tokens.constants.ts — the 11 Symbol() tokens from §4.5.
2. src/server/config/default-options.constants.ts — every default from §4.2 as-const.
3. src/server/config/resolved-options.ts — ResolvedAiTokensOptions: required store +
   scopeResolver?; ratingMode/currency/pricing/holds/ledger/events resolved to concrete values;
   wallets/budgets/telemetry/content as `{ enabled: false } | { enabled: true, ...resolved }`
   discriminated unions (services never touch undefined).
4. src/server/config/validate-options.ts — validateOptions(options): asserts store presence +
   ledger/pricing port methods always; wallet/budget port methods only when the feature block is
   present; fx required when currency !== 'USD'; markup valid (number path via
   resolveMultiplier4dp in a try/catch → INVALID_CONFIG; policy path: has resolve function);
   alertThresholds ∈ (0, 1]; holds ttl/reaper > 0; every failure →
   new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, { reason: '<actionable>' }).
5. src/server/config/apply-defaults.ts — merge + freeze into ResolvedAiTokensOptions.
6. Spec files covering every §4.6 failure case + the full defaults table.

Constraints:
- Validation is best-effort structural (has-method checks) — no store calls at validate time.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='config'` — expected: green, 100% on the four files.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 9/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.9 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.9`.
````

---

### Task 1.10 — PricingService (resolution chain + cache + idempotent seed)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 1.5, 1.6, 1.8, 1.9

#### Description

Effective-dated rate resolution with the six-step model-resolution chain (exact → baseModel → alias map → normalized ID → longest-prefix → miss), tier fallback rules, in-memory TTL cache, `upsertPrice`/`getPriceHistory`, and the idempotent snapshot seed.

#### Acceptance criteria

- [ ] Resolution-chain tests: exact; `baseModel`; alias map; date-suffix strip (`gpt-5.2-2026-03-14`); `models/` prefix strip; Bedrock region strip; longest-`startsWith`; strict miss throws / non-strict null
- [ ] Tier resolution: `flex` with no flex row → strict miss (never standard rates); `standard` resolves standard
- [ ] `upsertPrice` closes the open row and inserts a new one; history returns both
- [ ] Cache: hit within TTL, refresh after, keyed by the full resolution tuple
- [ ] Seed runs once across two concurrent module inits (fake store records lock acquisitions)

#### Files to create / modify

`src/server/services/pricing.service.ts` · `src/server/utils/model-id.ts` · `test/fakes/in-memory-pricing-store.ts` (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. PricingService resolves effective-dated rates: a call is priced at the rate in
effect AT ITS TIMESTAMP, never today's — and model IDs from responses rarely match price-row
IDs exactly (dated snapshots, deployment names), so a resolution chain is mandatory.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.10 of 11 (MIDDLE)

PRECONDITIONS
- Tasks 1.5, 1.6, 1.8, 1.9 done: cost engine, seed, IPricingStore port, tokens/validation.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "6.3 Rate resolution" (effective-dated select; tier
  fallback ONLY standard→standard; strict vs non-strict; cache; NewPriceVersion semantics),
  § "6.6 Model resolution" (the SIX-step chain — normative order), § "6.4 The seed dataset"
  (idempotent + advisory-locked seeding), § "15.1" (IPricingStore signatures ONLY —
  resolveRate/upsertPrice/getPriceHistory/listModels).
- docs/development_plan.md § "2.10 PricingService" (acceptance criteria).

TASK
Implement model-id normalization utils, the PricingService over IPricingStore, and an
in-memory fake store for tests (the fake is reused by later phases — make it faithful:
effective-dated rows, open-row uniqueness, a seed-lock counter).

DELIVERABLES

1. src/server/utils/model-id.ts — normalizeModelId(id): strip 'models/' prefix, strip trailing
   date suffix (-YYYY-MM-DD or -YYYYMMDD), strip Bedrock region/vendor prefixes (us./eu./apac.),
   lowercase. Pure, unit-tested with the §6.6 examples.
2. test/fakes/in-memory-pricing-store.ts — IPricingStore over a Map; enforces one open row per
   (provider, model, operation, serviceTier); exposes seedLockAcquisitions counter.
3. src/server/services/pricing.service.ts —
   - resolveRate(provider, model, operation, at, serviceTier = 'standard'): the six-step chain
     (exact → caller baseModel [passed as an optional arg] → options.pricing.modelAliases →
     normalizeModelId → longest-startsWith via store.listModels → miss). Tier rule: only a
     'standard' request may match only-standard rows; batch/flex/priority MUST find their tier
     row or miss. Strict: throw AiTokensException('AI_TOKENS_PRICE_NOT_FOUND', …, { provider,
     model, operation, serviceTier }); non-strict: return null.
   - In-memory cache keyed (provider, resolvedModel, operation, serviceTier, at-bucket) with
     options.pricing.cacheTtlMs.
   - upsertPrice(input) / getPriceHistory(...) delegating to the store.
   - seedFromSnapshot(): lazy dynamic import of '@bymax-one/nest-ai-tokens/prices' (path-mapped
     to src/prices in tests); idempotent — delegates locking to the store contract; called from
     onModuleInit when options.pricing.seedFromSnapshot.
4. Spec files covering every acceptance criterion (chain steps individually, tier rules, cache
   TTL with fake timers, concurrent seed via two service instances on one fake store).

Constraints:
- 'responses' operation resolves 'chat' rows (spec §5.1 note) — implement as an operation alias
  inside resolveRate.
- No Date.now() free calls in cache logic — inject a now() clock for testability.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='pricing|model-id'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 10/11. 5. Update the Phase 1 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 1.10 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.10`.
````

---

### Task 1.11 — BymaxAiTokensModule.forRoot() + provider presets + fixture demo

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.4, 1.9, 1.10

#### Description

The synchronous `@Global()` dynamic module (store fan-out under per-port tokens, option-vs-token precedence, feature-gated provider registration), the `providerPresets` object, the server barrel with the shared re-export rule — closed by the phase's Definition-of-Done fixture demo.

#### Acceptance criteria

- [ ] Fixture app boots with only `store`; `PricingService` injectable; `WalletService`/`BudgetService` NOT registered
- [ ] With `wallets: {}`/`budgets: {}`, the corresponding providers register (services themselves arrive in later phases — register placeholders is NOT acceptable: gate on existence, so this criterion is validated structurally via the provider-factory map)
- [ ] Host-bound `BYMAX_AI_TOKENS_PRICING_STORE` token overrides the bundle's pricing half
- [ ] Every preset produces the right `{ provider, normalizer, ratingMode }`; `openaiCompatible('deepseek')` works
- [ ] End-to-end fixture: raw OpenAI usage → preset normalizer → PricingService → exact expected nano-USD cost

#### Files to create / modify

`src/server/bymax-ai-tokens.module.ts` · `src/server/config/provider-presets.ts` · `src/server/index.ts` (+ spec files, fixture module)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The dynamic module is @Global() (guard/interceptor injectable anywhere; one
ledger/pricing instance per app is a correctness requirement). forRoot() fans the single store
object out under per-port DI tokens; opt-in features register zero providers when unused.

CURRENT PHASE: 1 (Foundation + Shared Core + Pricing) — Task 1.11 of 11 (LAST)

PRECONDITIONS
- Tasks 1.4, 1.9, 1.10 done: normalizers, tokens/validation/defaults, PricingService.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "2.1 NestJS dynamic module" (@Global justification),
  § "4.6 Wiring and precedence rules" (fan-out + override + feature gating + init validation),
  § "4.3 Provider presets" (the 11 presets incl. openaiCompatible(id) and the azureOpenai
  baseModel note), § "3.3 Public exports" (Server list + the re-export rule: the server entry
  re-exports every ./shared symbol).
- ../nest-storage/src/server/bymax-storage.module.ts — the forRoot provider-wiring shape ONLY
  (read the file once; it is < 200 lines).

TASK
Implement the synchronous module, the presets, and the server barrel; prove the phase's
Definition of Done with an end-to-end fixture test.

DELIVERABLES

1. src/server/config/provider-presets.ts — providerPresets per §4.3: openaiChat,
   openaiResponses, azureOpenai, anthropic, gemini, vertex, bedrock, mistral, vercelAiSdk,
   openrouter (ratingMode 'provider-reported'), openaiCompatible(id: string) factory.
2. src/server/bymax-ai-tokens.module.ts — @Global() @Module({}) class with static
   forRoot(options): validateOptions → applyDefaults → providers:
   [ {BYMAX_AI_TOKENS_OPTIONS: resolved}, per-port store tokens (same instance fanned out,
   each with useValue — a host override wins by normal Nest token precedence when bound in the
   importing module), optional tokens (counter/tokenizer/telemetry/event-sink/content) from
   options or null, PricingService, + a feature-gated provider map prepared for later phases
   (only actually-existing services registered; wallets/budgets slots documented) ] and exports.
   onModuleInit on a small bootstrap provider triggers pricing seed when enabled.
3. src/server/index.ts — the §3.3 Server surface implemented so far + `export * from '../shared'`
   (the re-export rule).
4. Spec files: boot fixture (Test.createTestingModule) minimal-config; feature-gating assertions;
   token-override test; preset table test; THE DEMO: openai chat usage fixture (with cached +
   reasoning tokens) → normalizeOpenAiChatUsage → resolveRate against a seeded fake store →
   computeCostNanoUsd → assert the exact expected bigint (hand-computed in the test comment).

Constraints:
- No forRootAsync yet (Phase 4). No MeteringService yet (Phase 2).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='module|presets'` — expected: green incl. the demo.
- `pnpm build && pnpm size` — expected: within budgets.
- `pnpm test:cov` — expected: 100% global on implemented files.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 11/11 and phase Status to 👀 Review (✅ only after the §1.7 plan
Done-criteria checklist passes and /bymax-quality:code-review findings are applied). 5. Update
the Phase 1 row in docs/development_plan.md §1.5 (+§1.4; set Active phase to Phase 2 when ✅).
6. Append: `- 1.11 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 1.11`.
````

---

## Completion log

<!-- Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>` -->

- 1.1 ✅ 2026-07-02 — Scaffolded the five-subpath peer-only package (tsup dual-format, 5 tsconfig/jest variants, eslint flat v9, Stryker, brotli size budgets) and the four CI workflows (ci/codeql/scorecard/release); typecheck, lint, build (all 5 subpaths mjs+cjs+d.ts), size, and passWithNoTests all green with `dependencies: {}`.
- 1.2 ✅ 2026-07-02 — Implemented the full zero-dependency shared surface: 6 as-const catalog constants (+ derived unions) and the canonical types (NormalizedUsage, PriceVersion, UsageRecord, wallet/budget/report/event/error types, plus New* insert aliases and LedgerFilter), all barrel-exported; typecheck, lint, and the src/shared zero-dep grep clean.
- 1.3 ✅ 2026-07-02 — Added exact nano-USD money utilities (perMillion, floatUsdToNanoUsd round-half-up exact < $1,000, formatNanoUsd bigint presentation) and deriveIdempotencyKey over canonical JSON + a pure sync SHA-256 (no node:crypto); fast-check property suites + FIPS test vectors, 100% coverage on every file.
- 1.4 ✅ 2026-07-02 — Implemented the nine pure provider normalizers (OpenAI chat/responses/compatible, Anthropic, Gemini, Bedrock Converse, Mistral, OpenRouter, Vercel v5+v6) over a shared field-reader helper; OpenAI/OpenRouter/Vercel subtract reasoning, Gemini maps thoughts directly, Anthropic keeps reasoning 0; fast-check tests assert both §5.5 invariants per adapter; 100% coverage, shared bundle 4.2 KB brotli, no provider SDK imports.
- 1.5 ✅ 2026-07-02 — Implemented the pure cost engine: computeCostNanoUsd (all-or-nothing long-context tier, per-category perMillion math, unitRates surcharge intersection, separable {total,token,surcharge}) and applyMarkup + resolveMultiplier4dp (4-dp bigint, truncation-toward-zero, rejects non-finite/≤0); tier-boundary + surcharge + fast-check property suites, 100% coverage.
- 1.6 ✅ 2026-07-02 — Authored the pinned MODEL_PRICES_SEED snapshot (OpenAI gpt-5 family + embeddings + batch, Anthropic Opus/Sonnet/Haiku with 0.1×/1.25×/2× cache rates + batch, Gemini Pro/Flash long-context tier rows, Mistral L/M/S, DeepSeek/xAI/Groq) in bigint nano-USD, plus the offline convert-litellm-prices.mjs provenance script; validation spec (shape, no duplicate keys, non-negative, coverage) at 100%; dist/prices has zero runtime imports and ./shared does not import ./prices.
- 1.7 ✅ 2026-07-02 — Implemented AiTokensException (extends HttpException, canonical { error: { code, message, details? } } body) plus the internal exhaustive code→message and code→HttpStatus maps (compiler-enforced via Record<AiTokensErrorCode, …>); one-throw-per-code spec asserting the §16.2 statuses (402/429/404/410/409/422/400/500/502/503), 100% coverage.
- 1.8 ✅ 2026-07-02 — Transcribed all 14 port/options interfaces (ILedgerStore/IPricingStore/IWalletStore/IBudgetStore/IBudgetCounterStore + IAiTokensStore bundle, ITokenizer, ITelemetrySink, IEventSink, IContentStore, IMarkupPolicy, MeteringContext/MeterResult, Hold/HoldEstimate union, BymaxAiTokensModuleOptions + async options/factory); also fixed a spec defect by defining the previously-unspecified ITokenizer port (docs(spec)). Typecheck/lint/build clean, zero any.
- 1.9 ✅ 2026-07-02 — Implemented the 11 Symbol DI tokens, validateOptions (store presence + always-required ledger/pricing ports, feature-gated wallet/budget port checks, FX_REQUIRED for non-USD without fx, markup/threshold/holds/wallet validation → INVALID_CONFIG with actionable reason) and applyDefaults → frozen ResolvedAiTokensOptions with { enabled } discriminated unions matching §4.2; 32-case config spec, 100% coverage.
