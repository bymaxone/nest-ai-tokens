# Phase 3 — Wallets + Budgets + Enforcement

> **Status**: 🔄 In Progress · **Progress**: 9 / 10 tasks · **Last updated**: 2026-07-03
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § 4
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md) (v0.2.0)
> **Complexity**: HIGH

---

## Context

Phases 1–2 delivered rating and the persisted ledger. This phase adds the two enforcement stores and the gate: prepaid **wallets** (materialized balance, atomic conditional debit, grant burn-down with an allocation trail, adjust/entries/reconcile) and **budgets** (three limit dimensions — spend/tokens/count — feature-scoped, renewal-anchored windows, the five-clause consumption predicate, multi-level scope checks, soft thresholds/throttle), plus the `BudgetGuard` (check-only mode), the `RedisBudgetCounterStore`, and the Prisma wallet/budget halves.

This is the **riskiest code in the library** — concurrent money movement. The two lanes (wallets 3.1–3.3, budgets 3.4–3.7) are fully parallel until 3.10.

**Definition of Done (demo):** spend is blocked before it happens, race-safely, under concurrency, at every scope level — proven by contract tests that run against BOTH the in-memory fakes and real Postgres.

---

## Rules-of-phase

1. **Token economy.** Grep the cited `§` heading, read only that range. Never read whole docs or other phase files.
2. **Unlimited semantics are normative (spec §10.2):** no budget row / null limit = unlimited; a present `0` = hard block; negative rejected. Never re-import bymax-fitness's `0 = unlimited` bug.
3. **ALL matching budgets across the scope hierarchy are checked and consume independently** (spec §10.3) — "most-specific wins" is a documented anti-pattern.
4. **The consumption predicate (spec §10.7) is the single source of truth** for what consumes windows — enforced ∧ ¬system ∧ feature-match ∧ posted/reversed ∧ in-window. `reconcileWindow` uses the SAME predicate.
5. **Atomicity via conditional writes** — `UPDATE … WHERE` guards, never check-then-write (spec §9.4, §10.8). Contract tests must run two concurrent operations with headroom for one.
6. **Wallets are money (nano-USD), never tokens**; `'key'` scopes cannot own wallets (spec §9.1).
7. **Fail closed** — counter unavailable → DB conditional consume; DB also down → block (spec §10.8, `failClosed`).
8. **Admin-plane mutations (grant/adjust/upsertBudget/removeBudget/rotateWindow) emit `ai_tokens.audit`** (spec §14.4).
9. **`/security-review` mandatory at phase close.** 100% coverage per file; docs updated per task.

---

## Reference docs

- [`../technical_specification.md`](../technical_specification.md) — §9 (wallets), §10 (budgets/enforcement), §11.3–11.4 (guard/decorators), §12.2 (events), §15.1–15.3 (ports/mapping/schema). Read per-task sections only.
- [`../development_plan.md`](../development_plan.md) — §4 (sub-steps §4.1–§4.10), §1.10 (cross-cutting rules).

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 3.1 | WalletService core (balance, grant, debit, refund, adjust, entries) | ✅ Done | P0 | M | 2.7 |
| 3.2 | Grant burn-down + allocations + lazy expiry | ✅ Done | P0 | L | 3.1 |
| 3.3 | Race-safe conditional debit + reconcile + overdraft | ✅ Done | P0 | L | 3.2 |
| 3.4 | Budget model + window anchoring + BudgetService CRUD | ✅ Done | P0 | L | 2.7 |
| 3.5 | Enforcement predicate + multi-dimension conditional consume | ✅ Done | P0 | L | 3.4 |
| 3.6 | Budget status API (BudgetStatus[]) | ✅ Done | P0 | M | 3.5 |
| 3.7 | Soft thresholds + projections + throttle policy | ✅ Done | P1 | M | 3.5, 3.6 |
| 3.8 | BudgetGuard + @RequireBudget + @AiFeature (check-only) | ✅ Done | P0 | M | 3.6 |
| 3.9 | RedisBudgetCounterStore (./redis) + fail-closed fallback | ✅ Done | P0 | M | 3.5 |
| 3.10 | Prisma wallet + budget halves (contract tests on real Postgres) | 📋 ToDo | P0 | L | 3.3, 3.5, 2.7 |

---

## Tasks

### Task 3.1 — WalletService core

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 2.7

#### Description

The full §9.2 service surface over `IWalletStore`: `getBalance`, `grant`, `debit` (optional `usageRecordId`, mandatory `reason` when absent — the voucher-reservation path), `refund`, `adjust` (signed admin correction), `getEntries` — plus the in-memory wallet fake.

#### Acceptance criteria

- [x] Grant/debit/refund/adjust each append entries with per-wallet idempotency (replay-or-conflict)
- [x] `getBalance` excludes future-`effectiveAt` and expired grants
- [x] Debit without `usageRecordId` and without `reason` → validation error
- [x] `getEntries` pagination + type/date filters
- [x] `grant`/`adjust` emit `ai_tokens.wallet.granted`/`ai_tokens.audit`

#### Files to create / modify

`src/server/services/wallet.service.ts` · `test/fakes/in-memory-wallet-store.ts` (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in payment/wallet systems, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Wallets hold prepaid nano-USD balances as append-only entries (grant/debit/refund/
adjustment/expiry) with a materialized balance column for atomic debits. TS strict, bigint
money, Jest 100%.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.1 of 10 (FIRST, wallet lane)

PRECONDITIONS
- Phase 2 done: LedgerService, events dispatcher, error catalog, IWalletStore port, shared
  wallet types (WalletRef/Wallet/WalletEntry/WalletEntryType).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "9.1 Types" (WalletRef excludes 'key'; auto-create on
  first grant/positive adjust; debit on nonexistent wallet → INSUFFICIENT_CREDITS), § "9.2
  WalletService" (the six method signatures VERBATIM incl. the debit usageRecordId/reason
  rule), § "14.4" (admin-plane audit bullet only), § "12.2" (wallet.granted + audit payload
  rows only).
- docs/development_plan.md § "4.1 Wallet core" (acceptance criteria).

TASK
Implement WalletService (all six methods) and a faithful in-memory IWalletStore fake
(entries + materialized balance + per-wallet idempotency; conditionalDebit/openGrants stubbed
for 3.2–3.3).

DELIVERABLES

1. test/fakes/in-memory-wallet-store.ts — Map-backed: getWallet, appendEntry (auto-create
   wallet on grant/positive adjust; unique (walletId, idempotencyKey) with replay-or-conflict
   using an entry-payload hash), listEntries (filters + pagination), reconcile; conditionalDebit
   + openGrants throw 'Task 3.2/3.3' for now.
2. src/server/services/wallet.service.ts — getBalance (Σ effective entries: exclude grants
   with effectiveAt future or expiresAt past — document that non-grant entries always count;
   credits = balance / options.wallets.creditRateNanoUsd as a number for presentation), grant
   (validates amount > 0n; emits wallet.granted + audit), debit (this task: plain appendEntry
   path with the usageRecordId/reason validation; the ATOMIC path replaces it in 3.3 — leave a
   TODO-free seam: debit delegates to a private appendDebit that 3.3 swaps), refund (validates
   against negative balance? NO — refunds always allowed), adjust (signed; emits audit),
   getEntries (delegate).
3. Spec files per acceptance criteria (idempotent replay, effectiveAt/expiresAt exclusion
   matrix, validation errors, pagination, events emitted).

Constraints:
- All amounts bigint nano-USD; 'key' ownerType rejected at the type level AND runtime-validated.
- Wallet feature is opt-in: the module registers WalletService only when options.wallets exists
  (extend the Phase 1 module provider map).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='wallet'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 1/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.1 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.1`.
````

---

### Task 3.2 — Grant burn-down + allocations + lazy expiry

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 3.1

#### Description

Burn order (`expiry`/`priority`/`fifo`), the debit→grant allocation trail (`AiWalletDebitAllocation`), and lazy `expiry` entries negating unspent remainders.

#### Acceptance criteria

- [x] Two grants, different expiries: debit allocates to soonest-expiring first ('expiry'); 'priority' and 'fifo' verified
- [x] A debit spanning two grants creates two allocations summing to the debit
- [x] Expired grant with remainder: next debit writes the `expiry` entry negating exactly the unspent remainder and excludes it from allocation
- [x] Refund restores balance but never resurrects an expired grant

#### Files to create / modify

`src/server/services/wallet.service.ts` (extend) · `test/fakes/in-memory-wallet-store.ts` (extend: `openGrants` + allocations) (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in payment/wallet systems, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Grant burn-down makes credit expiry auditable: every debit records which grant(s)
it drew from via an allocation table; a grant's remaining value = amount − Σ allocations.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.2 of 10 (MIDDLE, wallet lane)

PRECONDITIONS
- Task 3.1 done: WalletService core + fake (openGrants/allocations stubbed).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "9.3 Grant burn-down" (burn orders; allocation trail;
  LAZY expiry entries — at next debit or reaper sweep; rollover is host guidance only),
  § "15.1" (IWalletStore.openGrants + appendEntry allocations parameter), § "15.3"
  (AiWalletDebitAllocation model — reference for the fake's shape).
- docs/development_plan.md § "4.2 Grant burn-down" (acceptance criteria).

TASK
Implement openGrants + allocation persistence in the fake, and the burn-down algorithm in
WalletService's debit path (still non-atomic — 3.3 adds the conditional guard around it).

DELIVERABLES

1. Fake store: openGrants(ref, order) — grants with remaining > 0n, effective now, not expired,
   ordered per burnOrder ('expiry': soonest expiresAt first, null-expiry last; 'priority':
   lowest number first; 'fifo': createdAt); appendEntry accepts allocations and stores them.
2. WalletService debit path: fetch openGrants(options.wallets.burnOrder); FIRST handle lazy
   expiry — any grant with expiresAt past and remaining > 0n gets an 'expiry' entry of
   -remaining (own idempotency key `expiry:<grantEntryId>`) and is excluded; then allocate the
   debit greedily across remaining grants (allocations array; a debit exceeding total grant
   remainder still succeeds against the unallocated balance — overdraft/balance guard is 3.3's
   concern; document); pass allocations to appendEntry.
3. Spec files per acceptance criteria: three burn orders; split allocation; lazy expiry math;
   refund-does-not-resurrect (refund is a plain credit entry, allocations untouched).

Constraints:
- Allocation invariants tested: Σ allocations of a debit === min(debit, Σ grant remainders);
  a grant's remaining never negative.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='wallet'` — expected: green, 100% on changed files.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 2/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.2 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.2`.
````

---

### Task 3.3 — Race-safe conditional debit + reconcile + overdraft

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 3.2

#### Description

The §9.4 materialized-balance conditional debit (`UPDATE … WHERE balance − cost ≥ −overdraft`), balance reconciliation, overdraft semantics, and the depletion event — with concurrency contract tests reused verbatim against Prisma in 3.10.

#### Acceptance criteria

- [x] Two concurrent debits against balance for one → exactly one succeeds (contract test file, parameterized by store)
- [x] Overdraft honored: balance may reach exactly `−overdraft`, not below
- [x] `reconcile` detects and repairs a manually-skewed materialized balance
- [x] Depletion emits `ai_tokens.wallet.depleted`

#### Files to create / modify

`src/server/services/wallet.service.ts` (extend) · `test/fakes/in-memory-wallet-store.ts` (extend: atomic `conditionalDebit`) · `test/contracts/wallet-store.contract.ts` (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in concurrent financial systems, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The check-then-decrement race is THE classic wallet bug: two requests both read
balance=10, both spend 8. The fix is an atomic conditional UPDATE against a materialized
balance column, kept transactionally consistent with the append-only entries.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.3 of 10 (LAST of wallet lane)

PRECONDITIONS
- Task 3.2 done: burn-down + allocations; fake conditionalDebit still stubbed.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "9.4 Race-safe debit" (the conditional UPDATE + the
  entries-remain-source-of-truth rationale + reconcile), § "9.5 Overdraft", § "15.1"
  (IWalletStore.conditionalDebit + reconcile signatures), § "12.2" (wallet.depleted row).
- docs/development_plan.md § "4.3 Race-safe conditional debit" (acceptance criteria + the
  contract-test-reuse requirement for 3.10).

TASK
Implement atomic conditionalDebit in the fake (synchronous CAS emulating the SQL), swap
WalletService.debit onto it (burn-down allocations computed AFTER the conditional reserve
succeeds, inside the same store call), add reconcile + overdraft + depletion event, and write
the store-parameterized concurrency contract suite.

DELIVERABLES

1. Fake conditionalDebit(ref, entry, overdraft): atomically check
   balance - amount >= -overdraft; on success update materialized balance + append entry +
   allocations in one step; return entry; else null. (Simulate interleaving in tests with
   microtask scheduling.)
2. WalletService.debit final form: lazy-expiry sweep (3.2) → compute allocations preview →
   store.conditionalDebit(entry with allocations) → null → throw
   AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', 402, { balance, requested }); success →
   if new balance <= 0n emit wallet.depleted. reconcile(ref): recompute Σ entries, compare,
   repair, return Wallet; expose via a public WalletService.reconcile (admin plane → audit
   event).
3. test/contracts/wallet-store.contract.ts — exported `runWalletStoreContract(makeStore)`
   Jest suite: concurrent-debit-one-wins, overdraft boundary (exact −overdraft ok, 1n more
   fails), idempotent-replay, reconcile-repairs. Run it against the in-memory fake now; 3.10
   runs it against Prisma unchanged.
4. Spec files for the service-level behavior (error mapping, depletion event).

Constraints:
- The conditional guard and the entry insert are ONE atomic store operation — the service
  never does check-then-write.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='wallet'` — expected: green incl. the contract suite, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 3/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.3 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.3`.
````

---

### Task 3.4 — Budget model + window anchoring + BudgetService CRUD

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 2.7

#### Description

`BudgetService` CRUD (`upsertBudget`/`removeBudget`/`list`/`rotateWindow`) and the window-anchor engine: calendar-UTC and per-subject `anchorAt` (month-end clamping), `total`, `custom:<seconds>`, `expiresAt`, plus the normative unlimited semantics.

#### Acceptance criteria

- [x] Window-anchor table tests: Jan 31 anchor → Feb 28/29 → Mar 31; week/day anchors; calendar-UTC defaults; `total` never rotates; `custom:86400`
- [x] `limit: 0` blocks; absent dimension = unlimited; negative rejected at validation
- [x] `rotateWindow` starts a fresh window now and re-anchors subsequent windows
- [x] Expired budgets ignored by enforcement and excluded from `findMatching`
- [x] `upsertBudget`/`removeBudget` emit `ai_tokens.audit`

#### Files to create / modify

`src/server/services/budget.service.ts` · `src/server/utils/window-anchor.ts` · `test/fakes/in-memory-budget-store.ts` (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in billing systems, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Budgets cap spend/tokens/operation-counts per scope per window. Windows anchor
either to calendar UTC or to a per-subject date (subscription renewal) with month-end
clamping — the primitive bymax-fitness promised users but never had.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.4 of 10 (FIRST, budget lane)

PRECONDITIONS
- Phase 2 done. Wallet lane (3.1–3.3) may be in flight — no dependency on it.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "10.1 Budget" (the interface incl. features filter, three
  limit dimensions, anchorAt semantics + month-end clamping, expiresAt), § "10.2 Unlimited
  semantics (normative)" (ALL three bullets + the migration warning), § "10.3 Scopes, windows,
  and multi-level enforcement" (all-matching-budgets rule; findMatching includes ancestor
  scopes), § "10.5 BudgetService" (CRUD + rotateWindow signatures; status/reconcile arrive in
  3.5–3.6), § "15.1" (IBudgetStore signatures).
- docs/development_plan.md § "4.4 Budget model + windows" (acceptance criteria).

TASK
Implement the window-anchor utility (pure), the in-memory IBudgetStore fake, and
BudgetService's CRUD + rotation surface.

DELIVERABLES

1. src/server/utils/window-anchor.ts — pure functions:
   windowStartFor(budget, at: Date): Date and resetsAtFor(budget, windowStart): Date | null.
   Rules: anchorAt present → windows are [anchor + k·window) with month-length clamping
   (a Jan 31 monthly anchor yields Feb 28/29, Mar 31 — clamp day-of-month to month length);
   anchorAt absent → calendar UTC (day = midnight UTC; week = Sunday 00:00 UTC; month = 1st
   00:00 UTC); 'total' → windowStart = anchorAt ?? budget.createdAt, resetsAt null;
   { customSeconds } → epoch-aligned to anchorAt ?? createdAt. Inject the clock.
2. test/fakes/in-memory-budget-store.ts — upsert/remove/findMatching (scope + ALL ancestor
   scopes: key→user→team→tenant by scope type; tenant-wide budgets match everything in the
   tenant)/getWindow/setWindowStart; conditionalConsume/adjustWindow stubbed for 3.5.
3. src/server/services/budget.service.ts — upsertBudget (validation: §10.2 negative-limit
   rejection; at least one limit dimension present; softThresholds ∈ (0,1]; emits audit),
   removeBudget (audit), list, rotateWindow(budgetId, newWindowStart?) → setWindowStart(now
   or given) + update anchorAt so subsequent windows follow the new cycle (via upsert).
4. Spec files: the window-anchor TABLE test (every rule above with explicit dates), CRUD
   validation matrix, findMatching hierarchy matrix, expiresAt exclusion, rotation.

Constraints:
- Budget feature opt-in: module registers BudgetService only when options.budgets exists.
- Zero Date.now() free calls — injected clock everywhere.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='budget|window-anchor'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 4/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.4 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.4`.
````

---

### Task 3.5 — Enforcement predicate + multi-dimension conditional consume

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 3.4

#### Description

The five-clause consumption predicate (spec §10.7), the multi-dimension atomic `conditionalConsume` + signed `adjustWindow`, `reconcileWindow` (same predicate over the ledger), and the 402-vs-429 error mapping.

#### Acceptance criteria

- [x] Predicate truth-table tests (each clause independently flips consumption)
- [x] Cost-, token-, and count-limited budgets each block on their own dimension with the right error code
- [x] Feature filter: `features: ['workout.generate']` consumes for that feature only; embeddings pass through
- [x] `reconcileWindow` recomputed from a seeded ledger equals live counters (including after a reversal)
- [x] Two concurrent consumes with headroom for one → exactly one passes (contract test)

#### Files to create / modify

`src/server/services/budget.service.ts` (extend: `consume`/`release`/`reconcileWindow`) · `test/fakes/in-memory-budget-store.ts` (extend: atomic `conditionalConsume`/`adjustWindow`) · `test/contracts/budget-store.contract.ts` (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in concurrent billing systems, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Budget windows materialize spend; the ledger remains the reconcilable source of
truth via a five-clause predicate; consumption is an atomic multi-dimension conditional UPDATE.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.5 of 10 (MIDDLE, budget lane)

PRECONDITIONS
- Task 3.4 done: window anchoring + CRUD + fake store (conditionalConsume stubbed).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "10.7 Which records consume budgets (normative predicate)"
  (the five clauses + reconcileWindow same-predicate rule + counter-drift healing), § "10.8
  Race-safe consumption" (the conditional SQL semantics — transcribe into the fake), § "10.4"
  (ONLY the 402-vs-429 sentence), § "15.1" (conditionalConsume/adjustWindow/getWindow
  signatures), § "10.3" (every matching budget consumes independently — the consume loop).
- docs/development_plan.md § "4.5 Enforcement predicate" (acceptance criteria).

TASK
Implement the predicate (pure function over a UsageRecord + Budget + window), the atomic
consume in the fake, BudgetService.consume/release/reconcileWindow, and the store contract
suite (reused against Prisma in 3.10).

DELIVERABLES

1. src/server/services/budget-predicate.ts (internal, pure) —
   recordConsumesBudget(record, budget, windowStart, windowEnd): the five §10.7 clauses.
2. Fake conditionalConsume(budgetId, windowStart, delta {nanoUsd, tokens, count}, limits):
   atomic all-dimensions check-and-increment (any dimension over → false, nothing moves);
   creates the window row on first touch. adjustWindow: signed unconditional add (floors at 0n).
3. BudgetService.consume(context, delta): findMatching(scope) → filter expired + feature-match
   → for EACH matching budget: windowStartFor → conditionalConsume; any false → roll back the
   ones already consumed (adjustWindow negative) and throw BUDGET_EXCEEDED (402, dimension
   'cost') or QUOTA_EXCEEDED (429, dimension tokens/count) per the failing dimension.
   release(context, delta): adjustWindow negative on every matching budget.
   reconcileWindow(budgetId, windowStart): LedgerService.query the window range + predicate →
   recompute the three sums → overwrite the window row (store method) → return diff.
4. test/contracts/budget-store.contract.ts — runBudgetStoreContract(makeStore): concurrent
   consume one-wins, multi-dimension boundary (each dimension individually), first-touch
   window creation, adjustWindow floor.
5. Spec files: predicate truth table (parameterized: flip each clause), feature-filter
   pass-through, multi-budget partial-failure rollback, reconcile-after-reversal equality.

Constraints:
- consume() is called by Phase 4's hold/record paths — export it on BudgetService (internal
  to the lib, not the public barrel).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='budget'` — expected: green incl. contract suite, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 5/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.5 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.5`.
````

---

### Task 3.6 — Budget status API

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 3.5

#### Description

`BudgetService.status(tenantId, scope)` → `BudgetStatus[]` — the user-facing "how much is left" query (the `aiTokensRemaining`/`aiGenerationsRemaining` DTOs of bymax-fitness, generalized).

#### Acceptance criteria

- [x] Status reflects live windows across all matching scopes; `resetsAt` correct for anchored/calendar/total windows
- [x] Unlimited dimensions absent from `remaining` (not zero)
- [x] `usedFraction` correct with mixed dimensions

#### Files to create / modify

`src/server/services/budget.service.ts` (extend) (+ spec files)

#### Agent prompt

````
You are a senior backend engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Every consuming frontend renders a usage meter — status() is that query:
per-budget limit/spent/remaining across the three dimensions, with reset times.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.6 of 10 (MIDDLE, budget lane)

PRECONDITIONS
- Task 3.5 done: consume/windows live.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "10.6 Status API" (BudgetStatus/AccessStatus shapes —
  BudgetStatus only here; AccessStatus composition is Phase 4's getStatus), § "15.5" (bigint
  serialization note for the JSDoc).
- docs/development_plan.md § "4.6 Budget status API" (acceptance criteria).

TASK
Implement BudgetService.status() assembling BudgetStatus per matching budget from the live
window rows + window-anchor math.

DELIVERABLES

1. status(tenantId, scope): findMatching → per budget: windowStartFor(now) → getWindow (absent
   row = zero spend) → BudgetStatus { budgetId, features, window, windowStart, resetsAt
   (null for total), policy, limit{...present dims}, spent{always all three},
   remaining{only limited dims, floored at 0}, usedFraction = max over limited dims of
   spent/limit (bigint-safe division to a bounded float) }.
2. Spec files per acceptance criteria + a JSDoc @example showing host serialization via
   toJsonSafe.

Constraints:
- No counter reads here — status reads the DB window rows (documented freshness trade-off).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='budget'` — expected: green, 100% on changed code.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 6/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.6 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.6`.
````

---

### Task 3.7 — Soft thresholds + projections + throttle policy

- **Status**: ✅ Done
- **Priority**: P1
- **Size**: M
- **Depends on**: 3.5, 3.6

#### Description

Threshold-crossing detection (once per threshold per window), projected-spend events, and the `onThrottle` host callback dispatch.

#### Acceptance criteria

- [x] Crossing 80% then 100% emits exactly one event per threshold per window (no re-fire per call)
- [x] `policy: 'throttle'` invokes the callback with `{ context, budget, status }`; absent callback → warn + allow
- [x] Projection event fires when burn rate projects crossing before `resetsAt`

#### Files to create / modify

`src/server/services/budget.service.ts` (extend) (+ spec files)

#### Agent prompt

````
You are a senior backend engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Soft budget signals: threshold events at configurable fractions, projected-overage
warnings, and a host throttle callback for graceful degradation.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.7 of 10 (MIDDLE, budget lane)

PRECONDITIONS
- Tasks 3.5–3.6 done: consume + status.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "10.4 Soft vs hard enforcement" (all four policy bullets +
  projection), § "12.2" (threshold_crossed / exceeded / projected_exceeded payload rows),
  § "4.1" (budgets.onThrottle + alertThresholds option shapes).
- docs/development_plan.md § "4.7 Soft thresholds" (acceptance criteria — note the
  once-per-window dedupe requirement).

TASK
Wire threshold/projection detection into the consume path and implement the throttle-policy
branch.

DELIVERABLES

1. After every successful consume: compute usedFraction before/after; for each configured
   threshold crossed by this delta → emit threshold_crossed ONCE (dedupe: track
   highest-emitted-threshold per (budgetId, windowStart) — persist it on the window row via
   adjustWindow metadata or an in-memory map with the documented multi-replica caveat; choose
   the window-row approach: add a store method note or reuse spentCount? Use a dedicated
   lastNotifiedFraction column? The spec does not define one — keep it IN-MEMORY per instance
   and document the multi-replica double-alert caveat in JSDoc + spec §20 alignment).
2. Projection: on consume, burnRate = spent / elapsedWindowTime; if projected spend at
   resetsAt > limit and usedFraction < 1 → emit projected_exceeded (same once-per-window
   dedupe).
3. Throttle: when a HARD-exceeded budget has policy 'throttle' → await options.budgets
   .onThrottle({ context, budget, status }) and ALLOW the call (no throw); callback absent →
   logger.warn + allow. policy 'allow' → emit exceeded event, never throw. policy 'block' →
   throw (3.5 behavior, unchanged).
4. Spec files: threshold dedupe across multiple consumes; both-thresholds-in-one-delta;
   throttle callback invocation + absence; projection math with injected clock.

Constraints:
- Event emission must not extend the consume critical section (fire after the atomic op).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='budget'` — expected: green, 100% on changed code.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 7/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.7 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.7`.
````

---

### Task 3.8 — BudgetGuard + @RequireBudget + @AiFeature (check-only)

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 3.6

#### Description

The `CanActivate` gate: `scopeResolver` → decorator-config merge → status check → block or enrich the request with `request.aiTokens`. Hold-placing mode arrives with holds in Phase 4.

#### Acceptance criteria

- [x] Guard blocks with 402/429 pre-handler when a hard budget is exhausted; passes otherwise
- [x] `request.aiTokens.status` populated on pass (fitness `AIGenerationGuard` parity)
- [x] Missing `scopeResolver` with guard in use → clear `AI_TOKENS_INVALID_CONFIG` at init
- [x] Decorator metadata merge precedence tested (`@Meter.feature` > `@AiFeature`)

#### Files to create / modify

`src/server/enforcement/budget.guard.ts` · `src/server/enforcement/decorators.ts` (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Enforcement lives in the request path: a CanActivate guard resolves the caller's
scope via the host-configured scopeResolver, checks budgets, and enriches the request.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.8 of 10 (MIDDLE, budget lane)

PRECONDITIONS
- Task 3.6 done: BudgetService.status.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "11.3 BudgetGuard and MeteringInterceptor" (guard bullets
  ONLY — the interceptor is Phase 4; check-only vs hold mode: implement check-only, leave the
  estimate/hold branch throwing NOT_CONFIGURED 'holds arrive in Phase 4'), § "11.4 Decorators"
  (@RequireBudget/@AiFeature configs + precedence; @Meter is metadata-only here — define its
  decorator + metadata key so 3.8's merge logic is final, the interceptor consumes it later),
  § "4.1" (scopeResolver option), § "14.4" (scopeResolver trusted-input bullet — mirror in
  JSDoc).
- docs/development_plan.md § "4.8 BudgetGuard" (acceptance criteria).

TASK
Implement the three decorators (metadata via Reflector) and the check-only BudgetGuard.

DELIVERABLES

1. src/server/enforcement/decorators.ts — @Meter(config), @RequireBudget(config),
   @AiFeature(name) — SetMetadata under exported symbol keys; config types from spec §11.4.
2. src/server/enforcement/budget.guard.ts — @Injectable() CanActivate: resolve base context
   via options.scopeResolver (absent → INVALID_CONFIG thrown at guard construction time when
   the guard is instantiated — validate in the module when budgets enabled? Simplest correct:
   constructor asserts scopeResolver present); merge decorator metadata (feature =
   @RequireBudget.feature ?? @Meter.feature ?? @AiFeature; scope type override from decorators
   — resolve the scope id from the resolved context's scope map); call
   budgetService.status(tenantId, scope); any HARD (policy 'block') budget with a zero
   remaining on any limited dimension matching the feature → throw 402/429 per dimension;
   else attach request.aiTokens = { status, context } and return true. @RequireBudget.estimate
   present → throw NOT_CONFIGURED('holds arrive in Phase 4').
3. Spec files: block/pass matrix per dimension + policy; request enrichment; precedence;
   missing scopeResolver; supertest-lite fixture controller via @nestjs/testing.

Constraints:
- The guard performs NO consumption — check-only (the §10.8 atomic consume still protects the
  actual charge later; document the race note from spec §11.3).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='guard|decorators'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 8/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.8 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.8`.
````

---

### Task 3.9 — RedisBudgetCounterStore + fail-closed fallback

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 3.5

#### Description

The optional live cross-replica counter (`./redis` subpath, atomic Lua `incrIfBelow`) and the fast-path/fallback wiring in `BudgetService.consume` with `failClosed` semantics.

#### Acceptance criteria

- [x] `incrIfBelow` atomic (single Lua script); unit-tested against ioredis-mock; real Redis in Phase 4 e2e
- [x] Counter unavailable + `failClosed: true` → falls back to DB conditional consume; DB also down → blocks
- [x] `decr`/`reset` used by release/rotate paths

#### Files to create / modify

`src/redis/index.ts` · `src/server/services/budget.service.ts` (fast-path wiring) (+ spec files)

#### Agent prompt

````
You are a senior NestJS + Redis engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The ./redis subpath ships RedisBudgetCounterStore: a live cross-replica spend
counter making budget checks cheap under high concurrency; the DB conditional consume remains
the authoritative fallback.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.9 of 10 (MIDDLE, budget lane)

PRECONDITIONS
- Task 3.5 done: BudgetService.consume with DB conditional path.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "10.8 Race-safe consumption" (counter fast path: key
  scheme ai_tokens:budget:{budgetId}:{windowStartISO}:{dimension}, TTL = window + 1h grace,
  int64-string values, failClosed semantics), § "15.1" (IBudgetCounterStore signatures),
  § "4.1"/"4.6" (budgets.counter option ↔ BYMAX_AI_TOKENS_BUDGET_COUNTER token precedence),
  § "20.2" (fallback caveat bullet).
- docs/development_plan.md § "4.9 RedisBudgetCounterStore" (acceptance criteria).

TASK
Implement the Redis counter store and wire the fast-path/fallback into consume/release/rotate.

DELIVERABLES

1. src/redis/index.ts — RedisBudgetCounterStore(redis: Redis | string, opts?: { keyPrefix? }):
   incrIfBelow via ONE Lua script (GET current (default 0) → current + amount > limit → return
   0 → else INCRBY + PEXPIRE ttl → return 1), amounts/limits as decimal strings (int64-safe);
   decr (DECRBY floored at 0 via Lua), reset (DEL). Constructor accepts an ioredis instance or
   a connection URL (lazy `new Redis(url)` — ioredis imported dynamically; optional peer).
2. BudgetService wiring: when a counter is bound — consume tries counter.incrIfBelow per
   dimension FIRST (cheap reject); counter false → domain error WITHOUT touching the DB;
   counter true → DB conditionalConsume (authoritative; on false → counter.decr rollback +
   error); counter THROWS (unavailable) → failClosed true: proceed to DB path only (fallback,
   log warn); DB also throws → STORE_ERROR (blocked — fail closed). release/rotateWindow call
   counter.decr/reset best-effort (failures logged).
3. Spec files: Lua atomicity semantics vs ioredis-mock; fallback matrix (counter ok/false/
   throws × DB ok/false/throws); key/TTL derivation.

Constraints:
- ioredis must remain an optional peer — no top-level static import in src/server/; ./redis
  subpath may import it directly (its consumers installed it).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='redis|budget'` — expected: green, 100%.
- `pnpm build && pnpm size` — expected: dist/redis < 5 KB brotli.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 9/10. 5. Update the Phase 3 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 3.9 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.9`.
````

---

### Task 3.10 — Prisma wallet + budget halves

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 3.3, 3.5, 2.7

#### Description

Complete `PrismaAiTokensStore` with the `IWalletStore` + `IBudgetStore` halves and re-run the Phase 3 concurrency contract suites against real Postgres.

#### Acceptance criteria

- [ ] The 3.3 and 3.5 contract suites pass against Testcontainers Postgres unchanged
- [ ] Allocation queries (`openGrants` with remaining) correct under concurrent debits
- [ ] All wallet/budget error-mapping rows from spec §15.2 verified

#### Files to create / modify

`src/prisma/index.ts` (extend) · `test/e2e/prisma-wallet-budget.e2e-spec.ts`

#### Agent prompt

````
You are a senior NestJS + PostgreSQL engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. This task completes the official Prisma adapter with the wallet/budget halves —
the real-database proof of the phase's race-safety claims.

CURRENT PHASE: 3 (Wallets + Budgets + Enforcement) — Task 3.10 of 10 (LAST)

PRECONDITIONS
- Tasks 3.3 + 3.5 done (contract suites exist); Task 2.7 done (schema/migrations shipped,
  including wallet/budget tables; ledger+pricing halves implemented).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "9.4 Race-safe debit" (the conditional UPDATE SQL —
  implement via $executeRaw + same-transaction entry/allocations insert), § "10.8" (the
  multi-dimension conditional UPDATE SQL), § "15.1" (IWalletStore + IBudgetStore signatures),
  § "15.2 Store error mapping" (wallet-entry idempotency + conditional-op rows).
- docs/development_plan.md § "4.10 Prisma wallet + budget halves" (acceptance criteria).
- test/contracts/wallet-store.contract.ts + test/contracts/budget-store.contract.ts — read
  fully (they define what must pass).

TASK
Replace the 'Phase 3' stubs in PrismaAiTokensStore with real implementations and run both
contract suites against Testcontainers Postgres.

DELIVERABLES

1. Wallet half: getWallet; appendEntry (transaction: upsert wallet [auto-create], insert entry
   with P2002 replay-or-conflict, insert allocations, update materialized balance);
   conditionalDebit ($executeRaw UPDATE ai_wallets SET balance_nano_usd = balance_nano_usd -
   $cost WHERE id AND balance_nano_usd - $cost >= -$overdraft; rowCount 0 → null; else insert
   entry + allocations in the SAME transaction); openGrants (SQL: grants with
   amount - COALESCE(SUM(alloc),0) > 0, effective, not expired, ORDER BY per burnOrder);
   listEntries; reconcile (recompute Σ, UPDATE, return).
2. Budget half: upsert/remove/findMatching (scope + ancestors via IN on scope pairs)/
   conditionalConsume ($executeRaw with the §10.8 WHERE across three dimensions; INSERT ... ON
   CONFLICT for first-touch window creation)/adjustWindow (GREATEST(0, ...) floors)/getWindow/
   setWindowStart.
3. test/e2e/prisma-wallet-budget.e2e-spec.ts — Testcontainers Postgres: apply migrations,
   run runWalletStoreContract(prismaFactory) + runBudgetStoreContract(prismaFactory) with REAL
   parallel connections; plus the concurrent-debit + concurrent-consume scenarios with two
   PrismaClient instances.

Constraints:
- Raw SQL for every conditional op — never emulate with read-then-write.
- bigint ↔ Prisma BigInt at the boundary; Decimal(10,4) ↔ number for markupMultiplier already
  handled in 2.7 — reuse the helpers.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test:e2e -- --testPathPattern='prisma-wallet-budget'` — expected: green (Docker).
- `pnpm test:cov` — expected: 100% on src/prisma unit-testable paths (raw-SQL branches covered
  via the e2e config exclusion documented in jest.coverage.config.ts).

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 10/10 and phase Status to 👀 Review (✅ after plan §1.7 checklist +
/bymax-quality:code-review + /security-review applied). 5. Update the Phase 3 row in
docs/development_plan.md §1.5 (+§1.4; advance Active phase when ✅). 6. Append:
`- 3.10 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 3.10`.
````

---

## Completion log

<!-- Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>` -->

- 3.1 ✅ 2026-07-03 — WalletService (balance/grant/debit/refund/adjust/entries/reconcile) + in-memory wallet fake with per-wallet idempotency, materialized balance, and event hooks.
- 3.2 ✅ 2026-07-03 — Grant burn-down (expiry/priority/fifo), the debit→grant allocation trail, and lazy `expiry` entries negating unspent remainders, all inside the atomic store op.
- 3.3 ✅ 2026-07-03 — Race-safe `conditionalDebit` (materialized-balance reserve, no check-then-write), overdraft boundary, `reconcile` repair, depletion event, and the store-parameterized wallet contract suite.
- 3.4 ✅ 2026-07-03 — Pure window-anchor engine (calendar-UTC + per-subject anchorAt with month-end clamping, total, custom seconds), the in-memory budget fake, and BudgetService CRUD + rotateWindow with normative §10.2 validation.
- 3.5 ✅ 2026-07-03 — §10.7 predicate (single source of truth), atomic multi-dimension conditionalConsume + rollback, consume/release/reconcileWindow, 402-vs-429 mapping, and the store-parameterized budget contract suite.
- 3.6 ✅ 2026-07-03 — BudgetService.status → BudgetStatus[] (live windows, unlimited dims absent from remaining, bigint-safe usedFraction, correct resetsAt).
- 3.7 ✅ 2026-07-03 — Soft thresholds (once-per-threshold-per-window dedupe), burn-rate projected_exceeded, and the throttle/allow policy branches with the onThrottle callback.
- 3.8 ✅ 2026-07-03 — Check-only BudgetGuard (scopeResolver trusted input, decorator feature-precedence merge, 402/429 pre-handler block, request.aiTokens enrichment, fail-fast on a missing scopeResolver) plus the @Meter/@RequireBudget/@AiFeature decorators.
- 3.9 ✅ 2026-07-03 — RedisBudgetCounterStore (./redis, single atomic Lua incrIfBelow, lazy dynamic ioredis import, masked URLs) and the BudgetService counter fast-path with fail-closed fallback (counter reject → block without DB; counter down → DB fallback; both down → failClosed blocks) plus release/rotate counter maintenance.
