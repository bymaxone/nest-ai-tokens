# Phase 5 — Release v0.1.0

> **Status**: 🔄 In Progress · **Progress**: 5 / 7 tasks · **Last updated**: 2026-07-04
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § 6
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md) (v0.2.0)
> **Complexity**: LOW (mechanical, but gate-heavy)

---

## Context

Phases 1–4 are code-complete, e2e-proven, and integration-reviewed. This phase is documentation, budgets, the mutation gate, the provenance publish, and the example-app skeleton. Nothing new ships in `src/` except doc comments and findings fixes.

**Definition of Done:** `@bymax-one/nest-ai-tokens@0.1.0` live on npm with provenance; `bymaxone/nest-ai-tokens-example` skeleton initialized.

---

## Rules-of-phase

1. **Token economy.** Grep the cited `§` heading, read only that range. Never read whole docs.
2. **No behavior changes** — docs, budgets, gates, and publish only. Any bug found routes through a `fix:` commit with a regression test first.
3. **The README's code samples must compile** against the built package (README-fixture test — family convention).
4. **Mutation gate: break 95** — surviving equivalent mutants are documented with `// Stryker disable next-line` + justification, never by lowering the gate.
5. **The tag push / final `npm publish` awaits the human** (family convention) — agents prepare everything up to it.
6. Docs updated per task (Completion Protocol); phase ✅ only after the plan §1.7 checklist.

---

## Reference docs

- [`../technical_specification.md`](../technical_specification.md) — §14.4 (threat model → SECURITY.md), §3.3 (export tables → README), §19.1 (bundle budgets), §22 (migration pointer). Read per-task sections only.
- [`../development_plan.md`](../development_plan.md) — §6 (sub-steps §6.1–§6.7).
- Family references: `../nest-storage/{README.md,SECURITY.md,CLAUDE.md,AGENTS.md,CHANGELOG.md}` — structure donors.

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 5.1 | JSDoc + file-header audit (examples compile) | ✅ Done | P0 | M | 4.12 |
| 5.2 | README (badges, quick start, provider matrix, positioning) | ✅ Done | P0 | M | 5.1 |
| 5.3 | SECURITY.md / CHANGELOG.md / CLAUDE.md / AGENTS.md / LICENSE | ✅ Done | P0 | M | 5.1 |
| 5.4 | Bundle-size budgets final check | ✅ Done | P0 | S | 4.12 |
| 5.5 | Mutation testing release gate (break 95) + docs | ✅ Done | P0 | M | 5.1–5.4 |
| 5.6 | Publish v0.1.0 (prepare; human fires the tag) | 📋 ToDo | P0 | S | 5.5 |
| 5.7 | nest-ai-tokens-example skeleton | 📋 ToDo | P1 | M | 5.6 |

---

## Tasks

### Task 5.1 — JSDoc + file-header audit

- **Status**: ✅ Done · **Priority**: P0 · **Size**: M · **Depends on**: 4.12

#### Description

Every export documented; every file carries `@fileoverview` + `@layer`; `@example` blocks type-check; no phase/task references in committed comments.

#### Acceptance criteria

- [x] Doc-coverage sweep: no exported symbol without JSDoc (scripted check)
- [x] `@example` blocks compile via a docs-fixture tsconfig
- [x] No phase/task/TODO references in committed comments (timeless rule)

#### Agent prompt

````
You are a senior TypeScript engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11 (five subpaths, peer-only deps, Jest 100%). Phases 1–4 code-complete.

CURRENT PHASE: 5 (Release v0.1.0) — Task 5.1 of 7 (FIRST)

PRECONDITIONS
- Task 4.12 done: export surface matches spec §3.3; all gates green.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/development_plan.md § "6.1 JSDoc + file-header audit".
- /bymax-workflow:standards skill — the JSDoc + @fileoverview/@layer rules.
- Source files: sweep MECHANICALLY (grep for `^export` without a preceding `/**`), reading
  only the symbols flagged — never whole files you don't need.

TASK
Audit and complete JSDoc/file-header coverage across src/, make @example blocks compile, and
purge time-bound comments.

DELIVERABLES

1. scripts/check-jsdoc.mjs — a lightweight sweep (exported symbol without JSDoc → exit 1);
   wire as `pnpm docs:check` and into ci.yml's verify job.
2. Fixes: missing JSDoc/@fileoverview/@layer headers; @example blocks extracted into
   test/docs-fixtures/examples.spec-d.ts (type-check only, tsconfig.e2e-style variant).
3. `grep -rn 'Phase [0-9]\|Task [0-9]\|TODO' src/` → zero matches (fix or reword timelessly).

Constraints:
- Comment/doc changes only — zero behavior changes.

Verification:
- `pnpm docs:check && pnpm typecheck && pnpm lint && pnpm test:cov` — expected: all green.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 1/7. 5. Update the Phase 5 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 5.1 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 5.1`.
````

---

### Task 5.2 — README

- **Status**: ✅ Done · **Priority**: P0 · **Size**: M · **Depends on**: 5.1

#### Description

The public front page in the family structure: badges → centered tagline → Overview → Features → Subpath Exports table → Quick Start → Configuration → per-feature sections → Error Codes → Testing → Contributing → License — with the markup/resale positioning as the differentiator.

#### Acceptance criteria

- [x] Every code sample compiles against the built package (README-fixture test)
- [x] Badge URLs point at bymaxone/nest-ai-tokens
- [x] Provider matrix (condensed spec §5.3), 60-second quick start (record + meter + guard), markup positioning, bigint/JSON note, migration pointer to spec §22

#### Agent prompt

````
You are a senior developer-experience engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Public npm package; the README is the storefront and must project authority:
normalizer-first across 9+ providers, exact nano-USD accounting, immutable ledger, budgets/
wallets, and the differentiator — first-class markup/margin for reselling SaaS.

CURRENT PHASE: 5 (Release v0.1.0) — Task 5.2 of 7 (MIDDLE)

PRECONDITIONS
- Task 5.1 done. The built dist/ is current.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- ../nest-storage/README.md — STRUCTURE ONLY (badges block, section order); skim headings.
- docs/technical_specification.md § "1.2 Why it exists" + § "2.5 Why in-process" (positioning
  arguments), § "3.2"/"3.3" (subpath/export tables), § "5.3" (provider matrix source), § "16.2"
  (error code table), § "21" (Example Integration — lift the best snippets: 21.1, 21.2, 21.3,
  21.5, 21.6, 21.7), § "15.5" (bigint note), § "22" (migration pointer).
- docs/development_plan.md § "6.2 README" (content requirements).

TASK
Write README.md in the family structure with compiling samples and a README-fixture test.

DELIVERABLES

1. README.md — family badge block (npm version/downloads, CI, codecov, mutation, OpenSSF,
   license, TS 5.x, Node >= 24), centered `@bymax-one/nest-ai-tokens` tagline, sections:
   Overview / Features / Subpath Exports / Quick Start (install + forRootAsync + record +
   meter + guard in ~60s) / Configuration / Providers matrix / Pricing & markup (the resale
   lever — worked example: markup 4.0, credits at $5) / Wallets & budgets / Streaming /
   Reporting & status / Events / Error Codes / BigInt & JSON / Migration (spec §22 pointer) /
   Testing / Contributing / License.
2. test/docs-fixtures/readme.spec-d.ts — every README TypeScript block type-checks against
   the package's path aliases (family convention).

Constraints:
- English; no marketing fluff — capability-dense like nest-storage; every claim backed by a
  spec §.

Verification:
- `pnpm typecheck` (includes the fixture) — expected: green.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 2/7. 5. Update the Phase 5 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 5.2 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 5.2`.
````

---

### Task 5.3 — SECURITY.md / CHANGELOG.md / CLAUDE.md / AGENTS.md / LICENSE

- **Status**: 📋 ToDo · **Priority**: P0 · **Size**: M · **Depends on**: 5.1

#### Description

The family's supporting docs: SECURITY.md (the §14.4 threat model — admin vs data plane, scope-resolver trust, hash-chain verification, disclosure contact), CLAUDE.md (critical rules, ≤ ~150 lines), AGENTS.md (architecture deep-dive), CHANGELOG.md (v0.1.0 entry), LICENSE (MIT).

#### Acceptance criteria

- [x] SECURITY.md lists sensitive code paths + security@bymax.one disclosure contact
- [x] CLAUDE.md rule-dense per family convention (money-integer, ledger immutability, side-effect matrix, no text in ledger, unlimited semantics)
- [x] AGENTS.md covers architecture (ports, lifecycle, rating flow, enforcement)

#### Agent prompt

````
You are a senior engineer writing project documentation for the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The family ships SECURITY.md / CLAUDE.md / AGENTS.md / CHANGELOG.md / LICENSE with
every lib; structure mirrors ../nest-storage.

CURRENT PHASE: 5 (Release v0.1.0) — Task 5.3 of 7 (MIDDLE)

PRECONDITIONS
- Task 5.1 done.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- ../nest-storage/{SECURITY.md,CLAUDE.md,AGENTS.md} — structure donors (skim headings, copy
  skeleton).
- docs/technical_specification.md § "14.4 Security considerations" (the threat model —
  SECURITY.md's core), § "1.5 Design Principles" (CLAUDE.md rule source), § "2 Architecture"
  (AGENTS.md source — the section intros only), § "11.2" (the matrix — reproduce in CLAUDE.md
  condensed).
- docs/development_plan.md § "6.3" (content requirements).

TASK
Write the five files.

DELIVERABLES

1. SECURITY.md — security goals; the admin-plane vs data-plane split (grant/upsertPrice/
   reverse/adjust/export = privileged); scopeResolver trusted-input rule; cross-tenant hold
   validation; hash-chain verification procedure; sensitive paths list (wallet debit, budget
   consume, capture, markup resolution); disclosure: security@bymax.one.
2. CLAUDE.md — quick reference + CRITICAL RULES (bigint money everywhere; append-only ledger,
   annotation-only reversal; capture idempotent; unlimited = no row, 0 = block; isSystemCost
   never consumes; no prompt text in ledger; the §11.2 matrix condensed; commands).
3. AGENTS.md — architecture deep-dive (module wiring/fan-out, rating flow both modes, hold
   lifecycle + reaper, ports + official adapters, event system, testing strategy).
4. CHANGELOG.md — `## 0.1.0` initial-release entry (feature bullets from README Features).
5. LICENSE — MIT, Bymax One.

Constraints:
- English; timeless; no duplication of full spec text — link `docs/technical_specification.md §`.

Verification:
- `pnpm lint` (markdown untouched by eslint — just confirm repo green) — expected: green.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 3/7. 5. Update the Phase 5 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 5.3 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 5.3`.
````

---

### Task 5.4 — Bundle-size budgets final check

- **Status**: ✅ Done · **Priority**: P0 · **Size**: S · **Depends on**: 4.12

#### Description

Enforce the spec §19.1 budgets (server < 40 KB, shared < 10 KB, prisma < 15 KB, redis < 5 KB brotli; prices exempt/documented) and record actual sizes.

#### Acceptance criteria

- [ ] `pnpm size` covers the five entries; CI fails over budget
- [ ] Actual sizes recorded in the README

#### Agent prompt

````
You are a senior build engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — five-subpath tsup build with brotli size budgets
enforced in CI (family convention).

CURRENT PHASE: 5 (Release v0.1.0) — Task 5.4 of 7 (MIDDLE)

PRECONDITIONS
- Task 4.12 done; scripts/check-size.mjs exists from Task 1.1.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "19.1" (the budget numbers paragraph).
- scripts/check-size.mjs (whole file — it is small).

TASK
Run, tighten, and record the size budgets.

DELIVERABLES

1. `pnpm build && pnpm size` — if over budget: identify the culprit via tsup metafile/esbuild
   analyze; fix imports (lazy prices import, no accidental deep imports across subpaths); if
   legitimately over, DO NOT raise the budget silently — flag in the PR for human decision.
2. README: an "Artifacts" line with actual per-subpath brotli sizes + the prices data size.
3. Confirm ci.yml runs `pnpm size` in verify (Task 1.1 wired it — assert).

Constraints:
- No budget increases without explicit human approval.

Verification:
- `pnpm size` — expected: all five entries within budget, exit 0.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 4/7. 5. Update the Phase 5 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 5.4 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 5.4`.
````

---

### Task 5.5 — Mutation testing release gate

- **Status**: ✅ Done · **Priority**: P0 · **Size**: M · **Depends on**: 5.1–5.4

#### Description

Full Stryker run — high 100 / low 95 / **break 95** — plus `docs/mutation_testing_plan.md` and `docs/mutation_testing_results.md` (family convention).

#### Acceptance criteria

- [x] Score ≥ 95%; surviving equivalent mutants documented with `// Stryker disable next-line` + justification — **100.00%, 0 survivors** (all killed or justified-equivalent)
- [x] `docs/mutation_testing_plan.md` + `docs/mutation_testing_results.md` committed

#### Agent prompt

````
You are a senior test engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — Jest 100% coverage floor + Stryker mutation gate
(break 95) at release. Critical mutation targets: cost engine, model resolution, ledger state
machine, conditional debit/consume, window anchoring.

CURRENT PHASE: 5 (Release v0.1.0) — Task 5.5 of 7 (MIDDLE)

PRECONDITIONS
- Tasks 5.1–5.4 done; stryker.config.json from Task 1.1 (high 100/low 95/break 95).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/development_plan.md § "6.5 Mutation testing" + § "1.1" (the mutation-focus bullet).
- ../nest-storage/docs/mutation_testing_plan.md — structure donor (skim headings).

TASK
Run the full mutation suite, kill or justify survivors, and write the two docs.

DELIVERABLES

1. `pnpm mutation` full run (expect 10–20 min). For each survivor: kill it with a targeted
   test (preferred) or — ONLY for genuinely equivalent mutants (e.g. logging branches,
   defensive guards unreachable by contract) — annotate `// Stryker disable next-line <mutator>:
   <one-line justification>`.
2. docs/mutation_testing_plan.md — strategy, critical paths, thresholds, how to run.
3. docs/mutation_testing_results.md — final score table per module, survivor justifications,
   run date.

Constraints:
- The break-95 gate is never lowered.

Verification:
- `pnpm mutation` — expected: score >= 95%, exit 0.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 5/7. 5. Update the Phase 5 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 5.5 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 5.5`.
````

---

### Task 5.6 — Publish v0.1.0 (prepare; human fires the tag)

- **Status**: 📋 ToDo · **Priority**: P0 · **Size**: S · **Depends on**: 5.5

#### Description

Version bump `0.1.0-alpha.0 → 0.1.0`, the full `prepublishOnly` chain, and release notes — **the tag push / publish itself awaits the human** (family convention).

#### Acceptance criteria

- [ ] `prepublishOnly` chain green (clean → typecheck → lint → test:cov:all 100% → build)
- [ ] Version 0.1.0 committed; release notes drafted; install smoke documented
- [ ] Tag/publish explicitly left for the human (PR note)

#### Agent prompt

````
You are a senior release engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — provenance-signed npm publish, tag-driven release.yml
(Phase 1). The human fires the tag; you prepare everything up to it.

CURRENT PHASE: 5 (Release v0.1.0) — Task 5.6 of 7 (MIDDLE)

PRECONDITIONS
- Task 5.5 done: mutation gate passed; all docs current.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/development_plan.md § "6.6 Publish v0.1.0".
- package.json (whole file — small).

TASK
Prepare the release: version, gates, notes, smoke instructions.

DELIVERABLES

1. package.json version → 0.1.0 (single `chore(ai-tokens): release v0.1.0` commit).
2. Run the full prepublishOnly chain locally; paste the summary into the PR description.
3. RELEASE_NOTES draft in the PR body (from CHANGELOG 0.1.0) + the install smoke procedure:
   `npm i @bymax-one/nest-ai-tokens` in a scratch Nest app, forRoot boots, record() writes.
4. PR note: "Human action required: push tag v0.1.0 → release.yml publishes with provenance."

Constraints:
- DO NOT push a tag. DO NOT run npm publish.

Verification:
- `pnpm prepublishOnly` — expected: full chain green.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 6/7. 5. Update the Phase 5 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 5.6 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 5.6`.
````

---

### Task 5.7 — nest-ai-tokens-example skeleton

- **Status**: 📋 ToDo · **Priority**: P1 · **Size**: M · **Depends on**: 5.6

#### Description

Scaffold the sibling reference app (`bymaxone/nest-ai-tokens-example`, family convention): NestJS 11 + Prisma + the published lib, demonstrating record + meter + guard/interceptor, `GET /me/ai-usage`, a minimal dashboard, and the fitness-style plan-budget setup.

#### Acceptance criteria

- [ ] Separate repo initialized with the working skeleton + README linking back
- [ ] Demonstrates: record, meter, guard+interceptor, status endpoint, plan budgets (spec §21.5 pattern)
- [ ] Not a blocker for 5.6 (lands after publish)

#### Agent prompt

````
You are a senior NestJS engineer scaffolding the reference app for the nest-ai-tokens library.

PROJECT: nest-ai-tokens-example — reference implementation for @bymax-one/nest-ai-tokens
(family convention: every lib ships a sibling <lib>-example). NestJS 11 + Prisma/Postgres +
the PUBLISHED @bymax-one/nest-ai-tokens@0.1.0.

CURRENT PHASE: 5 (Release v0.1.0) — Task 5.7 of 7 (LAST)

PRECONDITIONS
- Task 5.6 done and the human published v0.1.0 (or use a local pack: `pnpm pack` + file: dep,
  documented as the pre-publish path).
- Repo bymaxone/nest-ai-tokens-example exists (create via gh if missing — confirm with the
  human first).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- nest-ai-tokens/docs/technical_specification.md § "21 Example Integration" (ALL subsections
  — this IS the example app's feature list: 21.1–21.8) and § "22" table rows for plan-budget
  setup patterns.
- ../nest-auth-example or ../nest-cache-example — repo skeleton structure (skim the tree).

TASK
Scaffold the example app demonstrating the §21 patterns end-to-end.

DELIVERABLES

1. NestJS 11 app: BymaxAiTokensModule.forRootAsync (PrismaAiTokensStore + markup 4.0 + wallets
   + budgets per spec §21.5), a fake-LLM provider module (deterministic usage objects — no real
   API keys), controllers: POST /ai/chat (meter + idempotency), POST /ai/summarize (guard +
   interceptor + headers), GET /me/ai-usage (getStatus + toJsonSafe), admin endpoints (grant,
   upsertBudget, reverse, export CSV).
2. Prisma schema merging the lib's fragment (multi-file schema — document the §15.3 workflow).
3. docker-compose (postgres + redis), .env.example, seed script (prices + a demo tenant/user
   with budget + wallet).
4. README: what it demonstrates, how to run, curl walkthrough; links back to the lib repo.

Constraints:
- Follow /bymax-workflow:standards; the example must run with `docker compose up + pnpm start:dev`.

Verification:
- `pnpm start:dev` + the curl walkthrough — expected: chat meters, budget blocks after the
  quota, status shows remaining, export streams CSV.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 7/7 and phase Status to 👀 Review; after the plan §1.7 checklist,
set Phase 5 ✅ — the PROJECT dashboard reaches 5/5. 5. Update docs/development_plan.md §1.5 +
§1.4 (Overall: 5/5 phases, 47/47). 6. Append: `- 5.7 ✅ <YYYY-MM-DD> — <summary>`.
7. Commit `docs(plan): complete task 5.7 — v0.1.0 shipped`.
````

---

## Completion log

<!-- Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>` -->
- 5.1 ✅ 2026-07-03 — JSDoc audit: check-jsdoc.mjs + 14 class/interface doc fixes + examples.spec-d.ts compilation fixture; docs:check wired to CI
- 5.2 ✅ 2026-07-03 — README.md with badge block, provider matrix, markup positioning, BigInt note, migration pointer + readme.spec-d.ts fixture
- 5.3 ✅ 2026-07-03 — SECURITY.md (threat model, admin/data plane, hash-chain, disclosure), CLAUDE.md (critical rules, side-effect matrix), AGENTS.md (architecture deep-dive, port map, DI tokens), CHANGELOG.md (0.1.0 entry), LICENSE (MIT)
- 5.4 ✅ 2026-07-03 — All five bundles within budget: server 37 KB (< 40 KB), shared 5 KB (< 10 KB), prisma 10 KB (< 15 KB), redis 1.1 KB (< 5 KB), prices 1.3 KB (exempt); sizes recorded in README
