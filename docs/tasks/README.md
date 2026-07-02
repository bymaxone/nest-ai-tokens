# Task Files — @bymax-one/nest-ai-tokens

One file per phase, generated from [`docs/development_plan.md`](../development_plan.md) (Layer 3 of the spec → roadmap → phase-tasks workflow). Each task carries a **self-contained agent prompt** — droppable into a fresh AI-agent conversation with zero prior context.

| Phase | File | Tasks | Complexity |
|---|---|---|---|
| 1 — Foundation + Shared Core + Pricing | [phase-01-foundation-shared-core-pricing.md](./phase-01-foundation-shared-core-pricing.md) | 11 | MEDIUM |
| 2 — Ledger + Markup + Events + Prisma Store | [phase-02-ledger-markup-events-prisma.md](./phase-02-ledger-markup-events-prisma.md) | 7 | HIGH |
| 3 — Wallets + Budgets + Enforcement | [phase-03-wallets-budgets-enforcement.md](./phase-03-wallets-budgets-enforcement.md) | 10 | HIGH |
| 4 — Metering Lifecycle + Streaming + Telemetry + Reporting + E2E | [phase-04-metering-streaming-telemetry-reporting.md](./phase-04-metering-streaming-telemetry-reporting.md) | 12 | HIGH |
| 5 — Release v0.1.0 | [phase-05-release.md](./phase-05-release.md) | 7 | LOW |

**Total: 47 tasks.** Canonical status lives in the [master plan §1.5 dashboard](../development_plan.md#15-phase-dashboard); each task file mirrors its own phase only.

## How to execute a task

1. Open the phase file, pick the first 📋 ToDo task whose `Depends on` are all ✅.
2. Copy the task's **Agent prompt** block into a fresh agent session (or run via `/bymax-workflow:task <task-id>`).
3. The agent executes, verifies, then runs the **Completion Protocol** — non-negotiable.

## Global rules (bind every task in every phase)

1. **Token economy — read surgically.** The spec (~2,250 lines) and plan (~1,150 lines) are large. NEVER read them whole. Each prompt lists REQUIRED READING as specific `§` sections — locate each with Grep (e.g. `grep -n '^### 8.4'`) and read only that line range. Never read other phase files or unrelated source files.
2. **The spec is the single source of truth.** Interfaces, schemas, and normative rules are NOT duplicated in tasks — the prompt cites the spec §. If implementation reveals a spec defect, fix the spec first (`docs(spec):` commit), then the code (plan Appendix A.3).
3. **Docs update on completion.** Every task ends with the Completion Protocol: update the task block + index + this phase file's header progress + `docs/development_plan.md` §1.5 dashboard row and §1.4 overall progress + append to the phase Completion log. A task without its protocol run is NOT done.
4. **Quality gates per task:** `pnpm typecheck` + `pnpm lint` (zero warnings) + `pnpm test:cov` (100% on files touched) + JSDoc on every export + `@fileoverview`/`@layer` headers + Conventional Commits (scope `ai-tokens`, no `Co-Authored-By`).
5. **English-only, timeless comments** — no phase/task references in committed code.
