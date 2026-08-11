# Autonomous Phase Execution — @bymax-one/nest-ai-tokens

> A runbook for driving the whole roadmap (**Phase 1 → Phase 5**, 5 phases / 47 tasks)
> autonomously, one phase per PR, with zero human interaction after launch (single
> exception: the final `v0.1.0` tag push — see §6). It reuses the operational lessons
> proven on the sibling `nest-queue` / `nest-storage` / `nest-notification` runbooks —
> where the naive "one agent does everything including merge and spawns the next"
> design **deadlocked** waiting for the code-review bot. This is the **library**
> `@bymax-one/nest-ai-tokens`: an AI token metering & usage-based billing NestJS
> dynamic module (provider usage normalizer → versioned pricing → immutable ledger →
> wallets/budgets → markup), five subpaths, published to npm. It is a **billing
> library — money correctness dominates every decision**. The gates, the security
> focus, and the memory-safety rules are the TypeScript-library set — read §4 and §5
> carefully.

---

## 0. How to launch

```bash
cd /Users/maximiliano/Documents/MyApps/bymax-one/nest-ai-tokens
claude --dangerously-skip-permissions
```

Then paste **Part A — The Orchestrator Prompt** (§2) as the first message. Nothing
else is required from you; the orchestrator drives every phase to merge and chains
the next one until the roadmap is complete (Phase 5 = release prepared; you fire the
final tag).

The **orchestrator** runs on **Opus 4.8 at xhigh effort** (selected in the terminal
before launch). The **implementer subagents** follow a **hybrid model policy**
(detailed in §2 STEP 1): **Opus 4.8** for Phases 1–4 (every one of them carries
money-correctness code: the normalizer reasoning-subtraction invariant + the bigint
cost engine in P1; the ledger state machine + exactly-once idempotency in P2; the
race-safe conditional wallet/budget movement in P3; the hold→capture lifecycle +
streaming settlement in P4), **Sonnet 4.6** for Phase 5 (docs / budgets / mutation /
publish-prep — mechanical, and the merge gate enforces the quality floor
model-agnostically).

> **Tip — make this runbook readable by the agents:** copy this file into the repo once so
> the prompts can reference its sections without the absolute MySupport path:
> `cp "/Users/maximiliano/Documents/MySupport/Prompts/PHASE_EXECUTION_PROMPT [nest-ai-tokens].md" docs/PHASE_EXECUTION_PROMPT.md`
> (the Part A/B prompts below point at `docs/PHASE_EXECUTION_PROMPT.md`).

---

## 1. Architecture — who does what (the most important lesson)

The work is split across **two roles**. Mixing them is what caused the deadlock.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR  (the main session — long-lived, small context)             │
│                                                                          │
│  • Owns the chain. Decides which phase is next (Phase 1 → Phase 5).      │
│  • Spawns ONE implementer subagent per phase (isolated git worktree).    │
│  • Picks the implementer's MODEL per the hybrid policy (§2 STEP 1).      │
│  • Receives the PR number the implementer returns.                       │
│  • Drives steps 5–9: wait for CI + review bot → fix → merge after a      │
│    grace window → update the dashboards → spawn the NEXT phase.          │
│  • Maintains the autonomy backbone (always a pending background job OR a │
│    ScheduleWakeup armed — never ends a turn with a "dead gap").          │
└──────────────────────────────────────────────────────────────────────────┘
                                   │ spawns (Agent tool, isolation: "worktree", model: …)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ IMPLEMENTER  (a subagent — one per phase, in its own worktree)           │
│                                                                          │
│  • Steps 0–4 ONLY: implement every task → gates → reviews → open PR.     │
│  • Returns the PR number as its final message, then STOPS.               │
│  • NEVER waits for the review bot. NEVER merges. NEVER spawns anything.  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why the split.** A background subagent that tries to "wait for the review bot / wait for
CI" simply **ends its execution** the moment it enters a long wait — only the **main loop**
is re-invoked by task-notifications when a background job finishes. So the long waits (CI,
Copilot, the grace window) MUST live in the orchestrator, fed by a background
`run_in_background` poll that exits on a **signal** (CI failed / bot re-reviewed / grace
window elapsed), not on a fixed sleep. That background completion is what re-invokes the
main loop and keeps the chain alive between phases.

**Why ONE implementer at a time is non-negotiable.** The lib's own test suite is bounded,
but from **Phase 2 onward Testcontainers spins real databases**: Phase 2 boots a PostgreSQL
container (migrations smoke), Phase 3 re-runs the wallet/budget concurrency contract suites
against PostgreSQL, and Phase 4 runs the **ten-scenario E2E suite against PostgreSQL + Redis**
plus (in Phase 5) the Stryker mutation run (10–20 min of full-suite re-execution). Two phases
building/testing at once — or fanned-out test agents — multiply memory by
`workers × containers × agents` and saturate cores. **Never run two implementers, never fan
out parallel test agents, and keep Jest `maxWorkers` bounded (`'50%'`, baked into the
configs).**

---

## 2. Part A — The Orchestrator Prompt

> Paste this block verbatim into the main session.

```
You are the ORCHESTRATOR for the autonomous build of @bymax-one/nest-ai-tokens.

Project root: /Users/maximiliano/Documents/MyApps/bymax-one/nest-ai-tokens
GitHub repo:  bymaxone/nest-ai-tokens
Package:      @bymax-one/nest-ai-tokens (public npm) — AI token metering & usage-based
              billing for NestJS 11: usage normalizer (9 providers) → versioned pricing →
              immutable ledger → wallets/budgets → markup. FIVE subpaths (".", "./shared",
              "./prices", "./prisma", "./redis"); zero runtime deps (peers only).
Spec:         docs/technical_specification.md (v0.2.0 — the single source of truth)
Roadmap:      docs/development_plan.md  (5 phases / 47 tasks; §1.5 "Phase dashboard" +
              §1.4 "Progress" + §1.6 "Update protocol" + §1.7 "Global per-phase Done criteria")
Phase tasks:  docs/tasks/phase-NN-*.md  +  docs/tasks/README.md (index + global rules:
              token economy + completion protocol)
ONE status legend EVERYWHERE (do NOT invent a second): 📋 ToDo · 🔄 In Progress · 👀 Review · ✅ Done · ⛔ Blocked · 🟡 Partial.
Canonical status lives in development_plan §1.5/§1.4; each phase file mirrors its own
header/progress. (docs/tasks/README.md's table has NO status column — do not add one.)

You drive the WHOLE roadmap, Phase 1 → Phase 5, one phase per PR, sequentially — NEVER two
phases in parallel (memory-safety: Phases 2–4 spin Testcontainers PostgreSQL (+ Redis in 4)
and Phase 5 runs the Stryker mutation gate; concurrent Jest/E2E runs OOM the machine). You
do NOT implement code yourself; you spawn one implementer subagent per phase and you own
everything from "PR opened" to "merged + next phase spawned". Read §1 (architecture), §4
(conventions), and §5 (the operational playbook) of docs/PHASE_EXECUTION_PROMPT.md before
you begin, and follow §5 literally for every merge decision and every wait.

────────────────────────────────────────────────────────────────────────────
STEP -1 — Preconditions (seed main with docs if needed)
────────────────────────────────────────────────────────────────────────────
The repo has docs/ but may have ZERO commits yet (greenfield) while origin
(https://github.com/bymaxone/nest-ai-tokens.git) exists. Phase PRs need a valid base:
  • `git rev-parse HEAD` succeeds AND `git ls-remote --heads origin main` exits 0 with
    non-empty output → base OK. (A non-zero exit means a missing/renamed remote, not an
    empty result — treat that as "origin/main absent".)
  • If HEAD is missing OR origin/main is absent: stage docs/, commit
    `chore(repo): seed main with project documentation`, and `git push -u origin main`.
  • Start every phase from the latest origin/main: `git fetch origin`, then `git switch main`
    (or, if no local main exists, `git switch -c main --track origin/main`), then `git pull --ff-only`.
  • Branch creation uses `git switch -c` — NEVER `git checkout -b` (a git-guard hook hard-blocks it).
  • No external pre-build is required (zero runtime deps; the only REQUIRED peers are
    @nestjs/common/@nestjs/core/reflect-metadata; @prisma/client, ioredis,
    @nestjs/event-emitter, @opentelemetry/api are OPTIONAL peers installed as devDeps).
    Docker must be available from Phase 2 onward (Testcontainers PostgreSQL; + Redis in Phase 4).

────────────────────────────────────────────────────────────────────────────
STEP 0 — Pick the next phase
────────────────────────────────────────────────────────────────────────────
Read docs/tasks/README.md (the index) and docs/development_plan.md (§1.5 Phase dashboard).
The next phase is the lowest-numbered phase NOT ✅ Done, respecting the dependency order
(plan Appendix A — the track is linear 1→2→3→4→5; the sanctioned §5.8-reporting overlap is
an INTRA-implementer note, not a reason to run two phases).
  • If all of Phases 1–5 are ✅ Done → report "✅ All phases complete.
    @bymax-one/nest-ai-tokens v0.1.0 is prepared — human action: push the v0.1.0 tag to
    publish (plan §6.6)." and STOP.
  • All phases run in this repo. (The Phase 5 task 5.7 example app lives in a SEPARATE repo
    bymaxone/nest-ai-tokens-example — the implementer handles it per its task file, using a
    local pack if the human has not pushed the tag yet.)

────────────────────────────────────────────────────────────────────────────
STEP 1 — Spawn the implementer (steps 0–4) in an isolated worktree
────────────────────────────────────────────────────────────────────────────
Use the Agent tool with isolation: "worktree" and pass Part B (the Implementer Prompt from
docs/PHASE_EXECUTION_PROMPT.md §3) verbatim, with {N} set to the phase number (1..5) and {NN}
to the zero-padded number (01..05). ONE implementer at a time — never fan out (OOM risk on
the Testcontainers phases; concurrent worktrees on the same branch collide).

MODEL POLICY (hybrid). You (orchestrator) ALWAYS run on Opus 4.8 (1M). For each implementer/fix
subagent you spawn, set the Agent tool `model`:
  • Opus 4.8 (OMIT `model` → the subagent inherits the main-loop model) for the
    money-correctness phases — ALL of Phases 1–4:
      Phase 1 (Foundation + Shared Core + Pricing — the nine normalizers with the
        reasoning-SUBTRACTION invariant [the #1 billing bug], the bigint tier+surcharge
        cost engine, the six-step model-resolution chain),
      Phase 2 (Ledger + Markup + Events + Prisma — append-only state machine,
        payload-hash exactly-once idempotency, compensation, the first real-DB semantics),
      Phase 3 (Wallets + Budgets + Enforcement — atomic conditional debit/consume, grant
        burn-down allocations, renewal-anchored windows; the riskiest code in the library),
      Phase 4 (Metering lifecycle + Streaming + Reporting + E2E — hold→capture delta math,
        idempotent capture, the reaper, abort-safe streaming, the ten-scenario suite).
  • Sonnet 4.6 (`model: "sonnet"`) for the mechanical phase:
      Phase 5 (Release — JSDoc audit, README + 4 support docs, bundle budgets, Stryker gate,
        publish prep, example-app skeleton).
  • Fix subagents: ESCALATE to Opus (omit `model`) when a phase stalls on review/CI findings,
    even if its implementer was Sonnet — ESPECIALLY for any /security-review finding and for
    anything touching money math, idempotency, or the conditional SQL.
Rationale: the merge gate — /bymax-quality:code-review + /security-review iterated to zero,
CI (100% coverage via jest.coverage.config.ts + e2e, build of all FIVE subpaths, size budgets,
codeql/scorecard), the Copilot review, and the Phase 5 mutation gate — enforces the quality
floor model-agnostically; but in a BILLING library the subtle first-pass judgment (whether
outputTokens excludes reasoning, whether a conditional UPDATE is actually atomic, whether a
replay double-bills) is exactly what reviews catch LATE and expensively, so Phases 1–4 stay
on Opus. Caveat: the Agent tool exposes only `model`, NOT effort — only the model is
guaranteed per subagent.

The implementer returns a PR number. DO NOT trust its prose about what it did — verify the
real state via git/gh (§5.5). Confirm the PR exists and its head branch matches:
  gh pr view <PR#> --repo bymaxone/nest-ai-tokens --json number,headRefName,state

If the implementer died silently (no completion notification, worktree at base with 0 commits
after ~60 min) → investigate file mtimes, then re-spawn (§5.3). Give Phases 2–4 (container
pulls, e2e) and Phase 5 (Stryker cold run) a wider window before declaring death.

────────────────────────────────────────────────────────────────────────────
STEP 2 — Wait for CI + the review bot via a BACKGROUND poll
────────────────────────────────────────────────────────────────────────────
Start a background poll (Bash run_in_background) that watches the PR and exits on a SIGNAL,
writing its verdict to a file you then read (NEVER read an agent's .output transcript — §5.5).
Use the gh vocabulary in §5.6. The poll exits with exactly one:
  • CI_FAILED        — at least one check is failing (this repo's CI: dependency-review /
                       typecheck / lint / test:cov / build-integrity (5 subpaths) / size /
                       e2e / codeql / scorecard — any may fail)
  • BOT_COMMENTED    — the bot left unresolved review threads to address
  • READY_TO_MERGE   — the full merge-gate conjunction (§5.1) holds
Its completion re-invokes you. Re-arm a long ScheduleWakeup (1200s+) fallback each turn so a
silently-dead poll cannot strand the chain (§5.3).

While the poll runs, DO NOT idle: read the next phase's task file, sync main, pre-draft replies
to threads the last fix already addressed — so the merge is instant when the gate opens (§5.1).

────────────────────────────────────────────────────────────────────────────
STEP 3 — React to the verdict
────────────────────────────────────────────────────────────────────────────
  • CI_FAILED or BOT_COMMENTED → run the FIX procedure (§5.2 + §5.4):
      - Release the phase branch first: if it is checked out in the implementer's worktree,
        `git worktree remove <path> --force` so a fix can switch to it.
      - Spawn a fix subagent (isolation: "worktree", model per the escalation rule above) OR fix
        inline in a fresh worktree on that branch: address EVERY failing check and EVERY bot
        comment (all severities, down to nit). Push.
      - Resolve each bot thread ONE AT A TIME with the real fix SHA, re-fetching thread IDs fresh
        each time (§5.2).
      - Go back to STEP 2 (new background poll).
  • READY_TO_MERGE → STEP 4.

────────────────────────────────────────────────────────────────────────────
STEP 4 — Merge (only after the grace window), then DELETE the merged branch
────────────────────────────────────────────────────────────────────────────
Re-verify the merge-gate conjunction one last time (state may have changed since the poll exited).
Capture the merged PR's head branch FIRST so you can delete it deterministically:
  BR=$(gh pr view <PR#> --repo bymaxone/nest-ai-tokens --json headRefName -q .headRefName)
Then merge and DELETE THE BRANCH OF THIS VERY MERGE — remote and local. A merge is not "done"
until its branch is gone:
  gh pr merge <PR#> --repo bymaxone/nest-ai-tokens --squash --delete-branch
  git switch main && git pull
  git status                                                 # must be clean
  git worktree remove <implementer-worktree-path> --force    # if still present
  git branch -D "$BR" 2>/dev/null || true
  git push origin --delete "$BR" 2>/dev/null || true
  git ls-remote --heads origin "$BR"                         # MUST print nothing
  git branch --list "$BR"                                    # MUST print nothing
The last two are the proof: if either still shows the branch, the merge is NOT finished. Never
merge the instant CI goes green — honor the grace window in §5.1.

────────────────────────────────────────────────────────────────────────────
STEP 5 — Update the dashboards, then chain the next phase
────────────────────────────────────────────────────────────────────────────
Follow the development_plan §1.6 "Update protocol". ONE legend (📋🔄👀✅⛔🟡) — no
cross-vocabulary trap. Update the plan + the phase file:
  • docs/development_plan.md §1.5 "Phase dashboard" — the phase row Status → ✅, Progress
    (N / N sub-steps), Last updated date; AND the Total row.
  • docs/development_plan.md §1.4 "Progress" — recompute (X / 5 phases + %, Y / 47 sub-steps),
    set Active phase to the next phase, and Blocked.
  • docs/tasks/phase-NN-*.md — header Status → ✅ + Progress N/N + Completion log (if the
    implementer's per-task Completion Protocol did not already finalize it).
Confirm every §1.7 Global Done criterion is actually met AND that CI is green on the merged
main — verify via gh/git, not via any agent's narration; if any bullet is unmet use 🟡 Partial
and keep the phase not-Done.
Commit: docs(plan): mark Phase N complete   (no Co-Authored-By). Push.

Then LOOP: go to STEP 0 for the next phase. Before ending the turn, make sure there is ALWAYS
either a tracked background job pending or a ScheduleWakeup armed (§5.3) — never end a turn with
a dead gap, or the chain stalls waiting for a human.
```

---

## 3. Part B — The Implementer Prompt (steps 0–4 only)

> The orchestrator passes this verbatim to each spawned implementer subagent, substituting
> `{N}` with the phase number (1..5) and `{NN}` with the zero-padded number (01..05), and
> setting the Agent `model` per the §2 STEP 1 hybrid policy. The implementer runs in its own
> git worktree, opens the PR, returns the number, and STOPS.

```
You implement ONE phase of @bymax-one/nest-ai-tokens end-to-end up to OPENING A PR, then you
STOP and return the PR number. You do NOT wait for the review bot, you do NOT merge, you do
NOT spawn any agent. The orchestrator owns all of that.

Project root: /Users/maximiliano/Documents/MyApps/bymax-one/nest-ai-tokens
GitHub repo:  bymaxone/nest-ai-tokens
Package:      @bymax-one/nest-ai-tokens — AI token metering & usage-based billing for
              NestJS 11 (usage normalizer ×9 providers → versioned effective-dated pricing →
              immutable append-only ledger → prepaid wallets + multi-dimension budgets →
              markup/margin). FIVE subpaths: "." server / "./shared" zero-dep / "./prices"
              data / "./prisma" store adapter / "./redis" budget counter. Zero runtime deps;
              REQUIRED peers @nestjs/common ^11, @nestjs/core ^11, reflect-metadata ^0.2;
              OPTIONAL peers @prisma/client >=6, ioredis ^6, @nestjs/event-emitter,
              @opentelemetry/api. ALL persisted money is bigint nano-USD.
You are running in an ISOLATED git worktree — your branch, commits, and files do not touch the
main tree or any other agent. Create your branch with `git switch -c feat/phase-{N}-<slug>`
(NEVER `git checkout -b` — a git-guard hook blocks it). Run `pnpm install` in the worktree
first (worktrees share the working tree, not node_modules; the pnpm store makes it cheap).

YOUR PHASE: Phase {N}.
Read docs/tasks/phase-{NN}-*.md (the full task list, acceptance criteria, and rules-of-phase)
and the "REQUIRED READING" each task names — TOKEN ECONOMY: read ONLY your task's
`### Task {N}.n` block + that block's bounded REQUIRED READING, not the whole file or the
whole plan/spec (see docs/tasks/README.md "Global rules" — the spec is ~2,250 lines, the plan
~1,150, the phase files 500–1,050: Grep the cited § heading, Read only that range).

────────────────────────────────────────────────────────────────────────────
STEP 0 — Claim the phase (plan dashboard + the phase file)
────────────────────────────────────────────────────────────────────────────
ONE legend (📋🔄👀✅⛔🟡):
  • docs/development_plan.md §1.5 "Phase dashboard" — phase row Status → 🔄 In Progress; AND
    §1.4 "Progress" Active phase → this phase.
  • docs/tasks/phase-{NN}-*.md — header Status → 🔄 In Progress.

────────────────────────────────────────────────────────────────────────────
STEP 1 — Execute the phase, task by task
────────────────────────────────────────────────────────────────────────────
Invoke: /bymax-workflow:task phase {N}
Follow the skill exactly, tasks in dependency order (the "Depends on" column). For every task:
  • Verify the current official docs FIRST (context7) for any library you touch — never code
    an API from memory. NestJS 11 (dynamic modules forRoot/forRootAsync, CanActivate,
    NestInterceptor, ExecutionContext/Reflector); Prisma >= 6 (multi-file schema,
    $queryRaw/$executeRaw, BigInt/Decimal mapping, P2002); ioredis 5 (Lua eval, defineCommand);
    @nestjs/event-emitter (EventEmitter2); @testcontainers/postgresql (+ redis); tsup (multi-
    entry dual-format); Stryker; fast-check. Resolve and query each before coding.
  • Implement to EVERY acceptance criterion; honor all rules-of-phase. Use the REAL semantics
    from the spec (the task cites the exact §): outputTokens EXCLUDES reasoningTokens (OpenAI
    adapters SUBTRACT the detail; Gemini maps thoughts directly; Anthropic keeps 0);
    computeCostNanoUsd's long-context tier is ALL-OR-NOTHING; markup = 4-dp bigint math in
    BOTH rating modes; ledger transitions pending→posted|released and posted→reversed is
    ANNOTATION-ONLY; transition(from,to) returns null on mismatch (the atomic claim);
    conditionalDebit/conditionalConsume are raw-SQL conditional UPDATEs, never check-then-
    write; capture() is idempotent, release() never bills; unlimited = NO budget row, 0 = hard
    block; isSystemCost rows never touch wallet/budget/counter; the §11.2 side-effect matrix
    is normative.
  • TDD where the task says so (red → green → refactor); fast-check property tests on every
    money path.
  • After each task, run the relevant gates and FIX any failure before the next task (run from
    the worktree root; MEMORY-SAFE — Jest maxWorkers '50%' baked in, never fan out):
      pnpm typecheck
      pnpm lint                 # zero warnings; no eslint-disable / @ts-ignore
      pnpm test:cov             # 100% line/branch on every file implemented
      pnpm size                 # after a task that changes the exported surface
      # e2e only where the phase's own tasks introduce them (2.7 / 3.10 / 4.11 —
      # needs Docker for Testcontainers PostgreSQL, + Redis in Phase 4):
      pnpm test:e2e -- --testPathPattern='<this phase's e2e spec>'
  • Apply the per-task Completion Protocol (each task's prompt ends with it): task Status ✅
    in its block + the Task index row, tick acceptance checkboxes, bump the file-header
    Progress (n/N), update the Phase {N} row Progress in development_plan §1.5 (+§1.4), append
    the Completion-log line, and commit with Conventional Commits:
    <type>(ai-tokens): <subject> ({N}.<task>)  — type ∈ {feat, fix, chore, docs, refactor,
    test, ci}; NO Co-Authored-By trailer.
Technical priority order: money correctness → security → correctness → performance → ergonomics.

────────────────────────────────────────────────────────────────────────────
STEP 2 — Phase-wide gates (must all pass)
────────────────────────────────────────────────────────────────────────────
  pnpm typecheck
  pnpm lint
  pnpm test:cov:all   # 100% line/branch per implemented file — hard gate
  pnpm build          # dist/ has .mjs + .cjs + .d.ts for ALL FIVE subpaths
  pnpm size           # server < 40 KB brotli, shared < 10 KB, prisma < 15 KB, redis < 5 KB
                      # (prices is data — exempt, size reported) — hard gate
  # E2E (phases that ship e2e specs — 2.7 migrations smoke, 3.10 contract suites,
  # 4.11 the ten scenarios; needs Docker; ONE container set at a time, bounded workers):
  pnpm test:e2e
  # invariant gates — must find NOTHING:
  ! grep -rnE "from '(openai|@anthropic-ai/sdk|@google/genai|@mistralai)" src/
                      # normalizer-first: NO provider SDK import anywhere
  ! grep -rn '@nestjs\|@prisma\|ioredis' src/shared/
                      # ./shared stays zero-dependency
  ! grep -rnE '\bparseFloat\(|\btoFixed\(' src/shared/pricing src/server/services
                      # no float math on money paths (formatting lives in formatNanoUsd)
Mutation testing (Stryker high 100 / low 95 / break 95) is the DEDICATED Phase 5 pre-release
gate — NOT per task/commit.
MEMORY-SAFE: bound Jest workers (`maxWorkers: '50%'`, baked into the configs;
`NODE_OPTIONS=--max-old-space-size=4096` as a guard), one suite at a time, one Testcontainers
set at a time; never fan out parallel test agents (the Postgres/Redis containers + the
Phase-5 Stryker run reload the suite per worker otherwise).

────────────────────────────────────────────────────────────────────────────
STEP 3 — Reviews (iterate to zero findings)
────────────────────────────────────────────────────────────────────────────
Invoke /bymax-quality:code-review — fix ALL findings (every severity, down to nit), then re-run
until it reports zero. Watch especially for: `number` arithmetic on a monetary value (bigint
everywhere — the #1 review target); a normalizer that copies completion_tokens AND
reasoning_tokens without the subtraction (double-billing); an UPDATE/DELETE on posted ledger
amounts (append-only violation); check-then-write on wallet/budget (must be conditional SQL);
a public export left untyped/undocumented; files >800 lines / functions >50; a missing
`@fileoverview` + `@layer` header; any Phase/task reference left in shipped source or .github
config.
Invoke /security-review — fix ALL findings including Low. Pay special attention to
(spec §14.4 + the phase rules):
  • ADMIN vs DATA plane — WalletService.grant/adjust, PricingService.upsertPrice,
    BudgetService.upsertBudget/removeBudget/rotateWindow, MeteringService.reverse, and
    UsageReportService.export are credit-minting/price-setting surfaces: JSDoc must state the
    host MUST restrict them to privileged roles; every one emits ai_tokens.audit.
  • scopeResolver is TRUSTED INPUT — it must read the host's VERIFIED auth context (JWT
    claims/session), never client-supplied body/query fields; the JSDoc says so.
  • Cross-tenant hold validation — capture()/release() reject a hold whose tenantId/scope
    mismatches the caller (HOLD_NOT_FOUND, deliberately indistinguishable from nonexistent).
  • NO prompt/completion text in the ledger, events, telemetry, or logs — text enters ONLY
    via the opt-in IContentStore sidecar (masked + TTL'd). No usage payload logging.
  • Connection strings (PostgreSQL/Redis URLs) are MASKED before any log/exception/details;
    credentials from env, never literals.
  • Idempotency keys are per-tenant (no cross-tenant replay); payload-hash mismatch → 409,
    never a silent overwrite.
  • bigint never crosses a JSON boundary raw (toJsonSafe / decimal strings — headers, events
    via sinks, exports).
  • Markup/policy resolution validates finite/>0/4-dp; a throwing policy fails the call
    (never a silent 1.0 fallback).
  • Fail-closed enforcement: counter unavailable → DB conditional consume; DB down → block.
  • Supply chain: GitHub Actions pinned by commit SHA; least-privilege `permissions:`;
    committed lockfile; npm publish with provenance (OIDC).
Re-run until zero. Re-run the STEP 2 gates after the review fixes.

────────────────────────────────────────────────────────────────────────────
STEP 4 — Open the PR, return its number, STOP
────────────────────────────────────────────────────────────────────────────
Invoke /push (creates the branch if needed, commits anything outstanding, pushes, opens the PR
against main). Then return EXACTLY the PR number and head branch as your final message, e.g.
"PR #7 on branch feat/phase-1-foundation". Do NOT wait for CI or the review bot. Do NOT merge.
Do NOT spawn anything. STOP.

────────────────────────────────────────────────────────────────────────────
MANDATORY CONVENTIONS
────────────────────────────────────────────────────────────────────────────
See docs/PHASE_EXECUTION_PROMPT.md §4 — apply every rule there. Highlights: zero runtime deps
(`"dependencies": {}`; three required peers, four optional); NO provider SDKs anywhere
(normalizers consume plain objects); ALL money bigint nano-USD (float only at the documented
OpenRouter entry conversion + presentation helpers); append-only ledger (compensating records,
annotation-only reversal); exactly-once idempotency (payload-hash replay-or-conflict); the
§11.2 side-effect matrix is normative; unlimited = no budget row / 0 = hard block; typed
`AiTokensException` over the error catalog (`{ error: { code, message, details } }`); TS
strict / zero `any` / no suppression comments; 100% line+branch per file; functions ≤50 lines,
files ≤800; `@fileoverview` + `@layer` header + JSDoc on every export; English-only TIMELESS
comments (no Phase/Task refs in committed source or .github config — the runbook and planning
docs may name phases, the shipped code may not); Conventional Commits scope (ai-tokens) with
NO Co-Authored-By trailer; `git switch -c` (never checkout -b); no .gitkeep / empty-dir
placeholders; memory-safe tests (Jest maxWorkers '50%', never fan out).
```

---

## 4. Mandatory conventions (apply in every phase)

These derive from `docs/development_plan.md` (§1.2 Guiding principles, §1.7 Global Done criteria,
§1.10 Cross-cutting normative rules), `docs/technical_specification.md` (v0.2.0 — §1.5 design
principles, §11.2 side-effect matrix, §14.4 security, §16 errors), `docs/tasks/README.md`, and
the Bymax Code-Craft Standard.

### Dependencies & API surface
- **Zero runtime deps** — `package.json` ships `"dependencies": {}`. REQUIRED peers:
  `@nestjs/common ^11`, `@nestjs/core ^11`, `reflect-metadata ^0.2`. OPTIONAL peers
  (`peerDependenciesMeta`): `@prisma/client >=6` (only for `./prisma`), `ioredis ^6` (only for
  `./redis`), `@nestjs/event-emitter` (event channel), `@opentelemetry/api` (telemetry).
- **NO provider SDKs, ever** — `openai`/`@anthropic-ai/sdk`/`@google/genai`/`@mistralai/*` never
  appear in the dependency graph or the imports (grep-gated). The normalizers consume plain
  `usage` objects; fixtures are hand-written payloads.
- **Five subpaths** — `.` (server) / `./shared` (zero-dep — no `@nestjs/*`, `@prisma/*`,
  `ioredis`, grep-gated) / `./prices` (data-only; `./shared` never imports it) / `./prisma` /
  `./redis`. The server entry re-exports every `./shared` symbol (spec §3.3 re-export rule).
- **Classic dynamic module** — `@Global()` `forRoot`/`forRootAsync` with `Symbol()` DI tokens,
  store fan-out under per-port tokens, option-vs-token precedence, feature-gated providers
  (spec §4.6). Opt-in features register ZERO providers when unconfigured.
- **Official docs first (context7)** before using any library/SDK/CLI — never from memory.

### Money correctness (the product's #1 rule)
- **All persisted money is bigint nano-USD** (spec §7.1/§7.4); rates are nano-USD per 1M tokens;
  FX/rounding only at presentation. No `number` arithmetic on money anywhere; `fast-check`
  property suites guard drift; the float entry points are exactly two (OpenRouter `usage.cost`
  round-half-up conversion, markup multiplier 4-dp resolution).
- **Normalizer invariants (spec §5.5)** — input side AND output side (`totalOutput =
  outputTokens + reasoningTokens`; OpenAI adapters SUBTRACT the reasoning detail; Gemini maps
  thoughts directly; Anthropic keeps 0) are hard test requirements per adapter.
- **Point-in-time pricing** — `(provider, model, operation, serviceTier, occurredAt)` via the
  §6.6 six-step resolution chain; batch/flex/priority NEVER silently fall back to standard rates;
  past records are never re-rated.
- **Append-only ledger** — statuses `pending → posted | released`, `posted → reversed` is
  annotation-only; corrections are compensating records; balance sums `posted`+`reversed`.
- **Exactly-once** — upsert on `(tenantId, idempotencyKey)` + payload-hash replay-or-conflict;
  deterministic keys on every hold/capture/release/reverse side effect.
- **The §11.2 side-effect matrix is normative** — record (observe-only unless `enforce`),
  hold (counter → window → wallet → pending, compensating backwards), capture (idempotent,
  ±delta), release (void, never bills), reverse (orchestrated restoration incl. the COUNT
  dimension). `isSystemCost` rows never touch wallet/budget/counter.
- **Budgets** — unlimited = NO row / null limit; a present `0` = hard block; negatives rejected;
  ALL matching budgets across the scope hierarchy consume independently; windows anchor to
  calendar UTC or per-subject `anchorAt` with month-end clamping; the five-clause consumption
  predicate (spec §10.7) is the single source of truth, shared by `reconcileWindow`.
- **Race-safety via conditional SQL** — `UPDATE … WHERE` guards on the materialized wallet
  balance and the multi-dimension budget windows; never check-then-write; contract suites run
  against BOTH the in-memory fakes and real PostgreSQL.

### Security (spec §14.4)
- **Admin vs data plane** — grant/adjust/upsertPrice/upsertBudget/rotateWindow/reverse/export
  are privileged surfaces (host-restricted; JSDoc states it; every mutation emits
  `ai_tokens.audit`). The data plane (record/meter/hold/capture/getStatus/getBalance) is
  request-scoped-safe.
- **scopeResolver is trusted input** — reads the host's VERIFIED auth context only.
- **Cross-tenant hold validation** — capture/release reject mismatched tenants with
  `HOLD_NOT_FOUND` (indistinguishable from nonexistent).
- **PII discipline** — no prompt/completion text in ledger/events/telemetry/logs; the opt-in
  `IContentStore` sidecar (masked + TTL'd + purgeable) is the only text path.
- **No secret leakage** — Postgres/Redis connection strings masked in every log/exception;
  credentials from env.
- **bigint JSON boundary** — decimal strings via `toJsonSafe` on headers/exports/sink events.
- **Fail-closed enforcement** — counter down → DB conditional consume; DB down → block.
- **Supply chain** — SHA-pinned Actions, least-privilege `permissions:`, committed lockfile,
  npm publish with **provenance** (OIDC); OpenSSF Scorecard workflow from Phase 1.

### Error handling
- **Typed errors only** — `AiTokensException` over the 15-code catalog; response shape
  `{ error: { code, message, details } }`; HTTP status from the code map (402 spend / 429
  quota / 410 expired hold / 409 settled-or-conflict). No stringly-typed errors.

### Quality floor
- **TS strict, zero `any`** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **100% line + branch coverage** on every implemented file (`pnpm test:cov`/`test:cov:all`,
  thresholds `100/100/100/100`) — hard gate. `fast-check` property tests on money paths.
- **Mutation `break 95`** (high 100, low 95) — Stryker, the **Phase 5 pre-release** gate (not
  per task/commit); survivors documented as provable equivalents in
  `docs/mutation_testing_results.md`.
- **Bundle budgets** — `dist/server` < 40 KB brotli, `dist/shared` < 10 KB, `dist/prisma`
  < 15 KB, `dist/redis` < 5 KB (`pnpm size`); `dist/prices` is data (size reported, exempt);
  peers stay external to every bundle.
- **Clean Code sizing & SRP** — functions ≤ 50 lines, files ≤ 800 (200–400 typical). Over the
  limit is a HIGH code-review finding.
- **`@fileoverview` + `@layer` header on every file; JSDoc on every export** (with `@example`
  where applicable).
- **CI green from the first PR** — the four workflows (`ci`/`codeql`/`scorecard`/`release`) are
  created in **Phase 1** and every per-PR gate is incremental-safe (jest `--passWithNoTests`,
  coverage on implemented files, size budgets); `release.yml` is tag-driven and inert until the
  human fires the v0.1.0 tag. Job names are contractual — do not rename them mid-roadmap.

### Memory safety (Testcontainers + Stryker are heavy)
- **One implementer at a time; one suite at a time; bounded Jest workers** (`maxWorkers: '50%'`
  baked into the configs; `NODE_OPTIONS=--max-old-space-size=4096`). One Testcontainers set at
  a time (Phase 2: PostgreSQL smoke; Phase 3: PostgreSQL contract suites; Phase 4: PostgreSQL +
  Redis, ten scenarios; Phase 5: the Stryker full-suite run, 10–20 min).
- **Never fan out parallel `Agent`/`Workflow` runs that execute a test suite**; never run
  multiple suites at once.

### Comments, git & commits
- **Timeless, English-only comments** — never reference `Phase N` / `Task N` / plan stages in
  committed source, JSDoc, or `.github/**` docs-as-config (the runbook and the planning docs may;
  shipped code/config may not).
- **`git switch -c` to branch** — never `git checkout -b` (hook-blocked). **No `.gitkeep`** /
  empty-dir placeholders.
- **Conventional Commits** — `feat/fix/chore/docs/refactor/test/ci(ai-tokens): …`; **never** a
  `Co-Authored-By` (or any AI-attribution) trailer.

---

## 5. Operational playbook (the lessons, as concrete procedure)

### 5.1 Merge gate — a conjunction, after a bounded grace window
Never merge the instant CI goes green. A second bot review can land ~90 s after a push; merging
too early turns it into a stray follow-up PR. Merge only when ALL hold:
- **CI green** — `gh pr checks <N> --json bucket` shows **0 fail and 0 pending** (this repo's
  required jobs: dependency-review, typecheck, lint, test:cov, build-integrity across the five
  subpaths, size, e2e, codeql, scorecard — all must pass).
- **No pending review** — `gh pr view <N> --json reviewRequests` is an empty array.
- **No open bot threads** — every `reviewThreads` node `isResolved: true`.
- **No bot review newer than the pending HEAD** — compare each `reviews[].submittedAt` against
  `commits[-1].committedDate`.
- **Grace elapsed** — **≥ 4–5 min since the last push**, measured concretely (record the push
  time; compute elapsed — do not eyeball it).

After a fix-push, the poll has **two valid exit criteria**:
- `COPILOT_REREVIEWED` — a review with `submittedAt` > HEAD `committedDate` arrived, **or**
- `GRACE_NO_REVIEW` — `reviewRequests` empty **and** the grace window has elapsed with no new
  review (covers PRs where the bot doesn't re-review).

Don't idle during the window — sync main, read the next phase, pre-draft thread replies — so the
merge is immediate when the gate opens.

### 5.2 Resolving bot threads (anti-stale)
- **Re-fetch thread IDs FRESH each time**, and check `viewerCanResolve`. Thread IDs change when
  the bot re-reviews a new commit; reusing an old ID returns `NOT_FOUND` and looks (falsely) like
  a permission error.
- **Respond + resolve one call at a time** — do NOT batch GraphQL mutations (one failure cancels
  its siblings). Verify `isResolved: true` before declaring a thread done. Cite the **real fix
  SHA** in each reply.

### 5.3 Autonomy backbone — never end a turn with a "dead gap"
- The chain stays alive only while there is **always** either a tracked background job pending
  **or** a `ScheduleWakeup` armed. End a turn with neither and nothing re-invokes the loop — the
  chain stalls waiting for a human.
- `ScheduleWakeup` is a **long fallback (1200 s+)**, not a poll. Don't use a short interval to
  "poll" tracked work (it auto-notifies on completion). Re-arm it each relevant turn with a
  prompt describing the **current** state (not a stale one).
- **Silent-death detection**: an implementer worktree still at base (0 commits) after ~60 min
  with no completion notification ⇒ suspect death; investigate file mtimes (recent = alive;
  stale = dead) → re-spawn. Signs of life: worktree locked, new files, recent mtimes. The
  Testcontainers phases (2–4: image pulls + container boots) and the Phase 5 Stryker cold run
  are slow — give those phases a wider window before declaring death.

### 5.4 Worktree discipline
- **Every file-writing subagent runs in its own worktree** (`isolation: "worktree"`), **one agent
  per directory**. Two agents in the same tree collide — uncommitted edits mix and the husky hook
  breaks on the blended tree (recovery: kill both, `git reset --hard` + `git clean -fd`, re-run
  isolated).
- **Release a branch before a fix-agent touches it.** A branch is pinned to the worktree that
  created it; git refuses the same branch in two worktrees. Remove the prior worktree first:
  `git worktree remove <path> --force`.
- **A worktree shares the working tree, not `node_modules`** — each worktree runs its own
  `pnpm install` (the store is shared, so it is cheap). Prune stale worktrees:
  `git worktree prune`.
- **Clean up on merge — always delete the merged PR's own branch** from BOTH the remote and the
  local repo. Order: `gh pr merge --squash --delete-branch` → `git worktree remove <path>
  --force` → `git branch -D <branch>` → `git push origin --delete <branch>` (fallback) → verify
  with `git ls-remote --heads origin <branch>` AND `git branch --list <branch>` (both must print
  nothing — §2 STEP 4).

### 5.5 Anti-hallucination — verify, never trust narration
- An agent's final message **can confabulate state** (claims fixes it didn't make, invents a
  SHA). **Always confirm real state via git/gh**, never via the agent's prose. For a billing
  library the narration risk extends to test claims — "100% coverage, all invariants hold" is
  verified ONLY by re-running `pnpm test:cov:all` yourself (or trusting the CI check, never the
  prose).
- **`TaskList` is unreliable here** (has returned empty with jobs still active). The real "still
  running" signal is the **absence of a completion task-notification**.
- **Never `Read` an agent's `.output` file** — it's the JSONL transcript and will blow your
  context. Only read the output files your **bash polls** write.

### 5.6 Concrete `gh` signal vocabulary
- **CI status:** `gh pr checks <N> --repo bymaxone/nest-ai-tokens --json bucket` → count
  `pass` / `fail` / `pending`.
- **Pending review:** `gh pr view <N> --json reviewRequests` (empty = nothing queued).
- **Re-review detection:** `reviews[].submittedAt` vs `commits[-1].committedDate`.
- **Threads (GraphQL):** `reviewThreads.nodes[]` → `isResolved`, `viewerCanResolve`,
  `comments[0].databaseId` (the comment to reply under).
- **PR identity:** `gh pr view <N> --json number,headRefName,state,mergeStateStatus`.

---

## 6. The roadmap & the finish line

All 5 phases run in **this** repo (`bymaxone/nest-ai-tokens`). The sequence (see
`docs/development_plan.md` §1.5 and the per-phase files in `docs/tasks/`):

`Phase 1` Foundation + Shared Core + Pricing (11 tasks, MEDIUM): scaffold + **CI created from day
one** (4 workflows) → shared catalogs/types → money+idempotency utils → the NINE normalizers with
both reconciliation invariants → the tier+surcharge cost engine + 4-dp markup → the `./prices`
seed → errors → ports → validation/defaults → `PricingService` (six-step model resolution,
idempotent seed) → `forRoot()` + presets + the rate-any-usage demo
→ `Phase 2` Ledger + Markup + Events + Prisma (7 tasks, HIGH): append/idempotency/query → state
machine + compensation → opt-in hash chain → markup wiring → `record()` + `estimateCost()` →
typed events (EventEmitter2 bridge + IEventSink) → `PrismaAiTokensStore` ledger+pricing halves +
the 7-table schema/migrations + Testcontainers smoke
→ `Phase 3` Wallets + Budgets + Enforcement (10 tasks, HIGH — the riskiest money code; two
parallel lanes): wallet core → grant burn-down/allocations → race-safe conditional debit ∥ budget
model/anchored windows → predicate + multi-dimension consume → status API → thresholds/throttle →
`BudgetGuard` (check-only) → `RedisBudgetCounterStore` → Prisma wallet+budget halves (contract
suites on real Postgres)
→ `Phase 4` Metering Lifecycle + Streaming + Telemetry + Reporting + E2E (12 tasks, HIGH):
`hold()` → `capture()`/`release()` → the **hold reaper** → `meter()`/`reverse()`/`getStatus()` →
`StreamUsageCollector` → interceptor + `@Meter` + guard hold mode + cost headers → OTel
`gen_ai.*` → `UsageReportService` (may run as a parallel lane inside the phase) → `forRootAsync()`
→ content sidecar → **the ten-scenario E2E suite** → the integration review (matrix audit)
→ **`Phase 5` Release v0.1.0** (7 tasks, LOW).

Dependency notes: the track is linear (1 → 2 → 3 → 4 → 5); every phase's `Depends on` references
resolve to earlier task IDs (verified). Phase 3 is the review-heaviest (concurrent money
movement); Phase 4 is the largest (the lifecycle + the e2e suite).

**Phase 5 is the finish line**: JSDoc/file-header audit with compiling `@example` fixtures;
author `README.md` (badges, quick start, provider matrix, the markup/resale positioning — the
library's differentiator, bigint/JSON note, migration pointer), `CHANGELOG.md`/`SECURITY.md`
(the §14.4 threat model)/`CLAUDE.md`/`AGENTS.md`/`LICENSE`; enforce the bundle budgets; run the
Stryker mutation gate (`break 95`) and record `docs/mutation_testing_plan.md` +
`docs/mutation_testing_results.md`; prepare the release (version bump to 0.1.0, full
`prepublishOnly` chain, release notes) — **the v0.1.0 tag push is the ONE human action** (the
tag triggers `release.yml` → `npm publish --provenance`); then scaffold the
`nest-ai-tokens-example` dogfood repo (consumes the published package, or a local `pnpm pack`
if the tag hasn't been fired yet — its task file covers both).

When all of Phases 1–5 are ✅ and CI is green on main, the orchestrator reports:
"✅ All phases complete. @bymax-one/nest-ai-tokens v0.1.0 is prepared — human action: push the
v0.1.0 tag to publish." and STOPS.

> **CI is not a final phase here — it exists from Phase 1** and gates every single PR. The job
> names are contractual (branch protection references them); do not rename them mid-roadmap.
