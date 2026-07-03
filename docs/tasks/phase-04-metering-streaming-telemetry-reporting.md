# Phase 4 — Metering Lifecycle + Streaming + Telemetry + Reporting + E2E

> **Status**: 🔄 In Progress · **Progress**: 4 / 12 tasks · **Last updated**: 2026-07-03
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § 5
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md) (v0.2.0)
> **Complexity**: HIGH

---

## Context

Phases 1–3 delivered rating, the persisted ledger, and race-safe wallets/budgets. This phase completes the public surface: the auth-hold lifecycle (`hold`/`capture`/`release` + the **hold reaper** — a v0.1 correctness requirement), `meter()`, the orchestrated `reverse()`, `getStatus()`, streaming-safe capture (`StreamUsageCollector`), the declarative path (`MeteringInterceptor` + `@Meter` + guard hold mode + cost headers), OpenTelemetry `gen_ai.*` emission, `UsageReportService` (summarize + cache savings + CSV/JSON export), `forRootAsync()`, the opt-in content sidecar, and the **ten-scenario e2e suite** against real PostgreSQL + Redis.

**Definition of Done (demo):** `meter(fn, ctx)` works end-to-end — including aborted streams, concurrent enforcement, and reversal — verified by the ten e2e scenarios (spec §19.2).

---

## Rules-of-phase

1. **Token economy.** Grep the cited `§` heading, read only that range. Never read whole docs or other phase files.
2. **The side-effect matrix (spec §11.2) is normative** — every cell of record/hold/capture/release/reverse must map to a test. The hold failure ordering (counter → window → wallet → pending insert, compensating backwards) is exact.
3. **`capture()` is idempotent** (repeat returns the posted record); capture-after-release → 409; release-after-capture → no-op warn; capture-after-reap → 410 (spec §11.1, §16.2).
4. **`release()` never bills** — partial billing on aborted streams goes through `capture(hold, collector)` (spec §2.2 step 4).
5. **Cross-tenant hold validation** — `capture`/`release` reject a hold whose tenant/scope mismatches the caller's context with `HOLD_NOT_FOUND` (spec §14.4).
6. **`isSystemCost` rows never touch wallet/budget/counter**, regardless of path.
7. **bigint never crosses a JSON boundary raw** — headers, exports, and event sinks use decimal strings (spec §15.5).
8. **`/security-review` mandatory at phase close**; 100% coverage per file; docs updated per task.

---

## Reference docs

- [`../technical_specification.md`](../technical_specification.md) — §2.2 (lifecycle), §5.6 (streaming), §8.3/§8.5 (holds/reversal), §10.6 (status), §11 (metering API — the phase's core contract), §13 (reporting), §14.1 (OTel), §19.2 (e2e scenarios). Read per-task sections only.
- [`../development_plan.md`](../development_plan.md) — §5 (sub-steps §5.1–§5.12), §1.10 (cross-cutting rules).

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 4.1 | hold() — estimate, rate, reserve (compensated ordering) | ✅ Done | P0 | L | 3.10 |
| 4.2 | capture() + release() (idempotency contracts, delta math) | ✅ Done | P0 | L | 4.1 |
| 4.3 | Hold reaper (TTL sweep, multi-replica claim) | ✅ Done | P0 | M | 4.2 |
| 4.4 | meter() + reverse() orchestrator + getStatus() | ✅ Done | P0 | L | 4.2, 3.6 |
| 4.5 | StreamUsageCollector (abort-safe streaming capture) | 📋 ToDo | P0 | L | 4.2 |
| 4.6 | MeteringInterceptor + @Meter + guard hold mode + headers | 📋 ToDo | P0 | L | 4.2, 3.8 |
| 4.7 | OpenTelemetry gen_ai.* emission | 📋 ToDo | P1 | M | 4.4 |
| 4.8 | UsageReportService (summarize, cache savings, CSV/JSON export) | 📋 ToDo | P0 | L | 2.7 |
| 4.9 | forRootAsync() | 📋 ToDo | P0 | S | 4.4 |
| 4.10 | Content sidecar wiring (opt-in) | 📋 ToDo | P2 | S | 4.4 |
| 4.11 | E2E suite — the ten scenarios (Testcontainers PG + Redis) | 📋 ToDo | P0 | L | 4.1–4.10 |
| 4.12 | Phase-4 integration review (matrix audit + export surface) | 📋 ToDo | P0 | M | 4.11 |

---

## Tasks

### Task 4.1 — hold() — estimate, rate, reserve

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 3.10

#### Description

The auth-hold entry point: rate a `HoldEstimate` (three variants), consume counter → budget → wallet with backward compensation on failure, write the `pending` ledger record with TTL.

#### Acceptance criteria

- [x] All three `HoldEstimate` variants rate correctly (`{ tokens }` against the context preset's model; `{ amountNanoUsd }` as-is — the fitness-estimator path)
- [x] Failure injection at each step → all prior steps compensated, correct domain error
- [x] `Hold` is plain serializable (JSON round-trip preserves capture-ability)
- [x] `isSystemCost` holds skip wallet/budget/counter entirely
- [x] Multi-hold composition: two holds for one logical feature reserve independently

#### Files to create / modify

`src/server/services/metering.service.ts` (extend) (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in payment authorization flows, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The metering lifecycle models credit-card auth-hold → capture: reserve on an
estimate, settle on provider-reported actuals. Wallets/budgets/ledger from Phases 2–3 are live.

CURRENT PHASE: 4 (Metering Lifecycle + Streaming + Telemetry + Reporting + E2E) — Task 4.1 of 12 (FIRST)

PRECONDITIONS
- Phases 1–3 done: MeteringService.record(), LedgerService (state machine), WalletService
  (conditionalDebit), BudgetService (consume/release), events dispatcher, MarkupResolver.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "11.1 MeteringService" (hold() signature + HoldEstimate
  variants + the Hold plain-object contract), § "11.2 Side-effect matrix" (the hold row + the
  normative failure ordering paragraph below the table), § "2.2 The metering lifecycle"
  (step 1 semantics), § "8.3" (pending status + TTL fields).
- docs/development_plan.md § "5.1 hold()" (acceptance criteria).

TASK
Implement hold(context, estimate) in MeteringService, replacing the Phase 2 stub.

DELIVERABLES

1. hold(context, estimate): resolve the estimate to (rawEstimateNanoUsd, estimatedTokens) —
   variant A { provider, model, operation, serviceTier?, inputTokens, maxOutputTokens }: rate
   via PricingService + computeCost over a synthetic NormalizedUsage; variant B { tokens }:
   requires context.preset (else INVALID_CONFIG) — rate tokens at the preset model's blended
   input rate (document: input rate is the conservative choice); variant C { amountNanoUsd }:
   pre-rated. Apply markup → billedEstimate. Then, unless context.isSystemCost:
   (1) counter/budget consume via BudgetService.consume(context, {nanoUsd: billedEstimate,
   tokens: estimatedTokens, count: 1}); (2) wallet debit via WalletService.debit (when wallets
   enabled) with idempotencyKey `hold:<ledgerKey>`; each step wrapped so a failure compensates
   all previous (release consumed budgets / nothing for counter-only) and rethrows the domain
   error. (3) LedgerService.append the PENDING record (enforced true, estimate amounts,
   occurredAt now, expiresAt = now + options.holds.ttlSeconds embedded in the Hold return —
   the record itself carries createdAt; the reaper computes expiry from createdAt + TTL).
   Return Hold { id, tenantId, scope, estimatedTokens, estimatedCostNanoUsd, expiresAt }.
2. Spec files: variant matrix; failure-injection at each step (fakes that throw on command)
   asserting compensation via wallet/budget balances; JSON round-trip of Hold; system-cost
   bypass; two independent holds.

Constraints:
- The wallet debit is LAST money movement before the pending insert (spec ordering — counter/
  budget first: cheapest to roll back).
- No events on hold (matrix: events column is empty for hold).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='metering'` — expected: green, 100% on changed code.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 1/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.1 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.1`.
````

---

### Task 4.2 — capture() + release()

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 4.1

#### Description

Settlement with actuals + exact delta adjustment on wallet/budget/counter; void with full restoration; the idempotency contracts; cross-tenant validation.

#### Acceptance criteria

- [x] Capture below/above/equal the estimate adjusts wallet + window + counter by the exact delta (property test)
- [x] Double capture → same record, no double side effects; capture after release → 409; capture after reap → 410
- [x] Release restores in full; release twice → single restoration; release after capture → no-op warn
- [x] Hold from tenant A captured under tenant B → 404
- [x] Markup re-resolved at capture against actuals; `priceVersionId` from `occurredAt`

#### Files to create / modify

`src/server/services/metering.service.ts` (extend) (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in payment authorization flows, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. capture() settles a hold with provider-reported actuals (pending → posted, adjust
by the delta); release() voids it (pending → released, restore in full). Both are idempotent
by contract.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.2 of 12 (MIDDLE)

PRECONDITIONS
- Task 4.1 done: hold() live; LedgerService.transition enforces the state machine.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "11.1" (capture/release signatures + idempotency notes),
  § "11.2" (capture + release matrix rows: wallet 'adjustment' for the ±delta; window/counter
  ±delta; events usage.recorded + thresholds on capture, hold.released on release), § "14.4"
  (cross-tenant hold validation → HOLD_NOT_FOUND), § "16.2" (HOLD_EXPIRED 410 /
  HOLD_ALREADY_SETTLED 409 rows), § "2.2" (steps 3–4).
- docs/development_plan.md § "5.2 capture() and release()" (acceptance criteria).

TASK
Implement capture(hold, usage) and release(hold, reason). (The StreamUsageCollector overload
of capture arrives in 4.5 — accept `unknown` usage now; collector detection added then.)

DELIVERABLES

1. capture(hold, usage): load the record by hold.id; validate tenant/scope against the
   caller-supplied Hold (mismatch or missing → HOLD_NOT_FOUND 404); status dispatch:
   'posted' → return it (IDEMPOTENT); 'released' → reaped? distinguish: released-by-reaper
   records carry the reaper reason → HOLD_EXPIRED 410, released-by-caller → 409
   HOLD_ALREADY_SETTLED; 'pending' → settle: normalize usage (context preset persisted on the
   record? The hold's pending record stores feature/scope/preset-provider fields — normalize
   via the preset resolved from the record's provider/operation or an explicit preset arg;
   simplest correct: capture accepts an optional preset, defaulting to provider-based lookup),
   rate at record.occurredAt … actually rate at CAPTURE time price resolved by the PENDING
   record's occurredAt (spec: priceVersionId from occurredAt), markup re-resolved; compute
   deltas vs the hold estimate (billed cost, tokens); transition pending→posted with actual
   amounts patched; then adjust: BudgetService release/consume the delta (negative delta →
   release; positive → consume WITHOUT limits enforcement? NO — positive delta consumes via
   adjustWindow directly per the matrix '±delta', document that capture never re-blocks);
   WalletService: delta as 'adjustment' entry (refund-like for negative, debit-like for
   positive, no conditional guard); counter ±delta. Fire usage.recorded + threshold events.
2. release(hold, reason): same load/validate; 'posted' → logger.warn + return (no-op);
   'released' → no-op; 'pending' → transition pending→released; restore: budget release full
   estimate, wallet refund of the hold debit (idempotencyKey `release:<holdId>`), counter decr;
   emit hold.released { expired: false }.
3. Spec files per acceptance criteria incl. the delta property test (fast-check estimates vs
   actuals) and the full idempotency/state matrix.

Constraints:
- All wallet/budget adjustments carry deterministic idempotency keys derived from the hold id
  (crash-safe replays).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='metering'` — expected: green, 100% on changed code.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 2/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.2 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.2`.
````

---

### Task 4.3 — Hold reaper

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 4.2

#### Description

The periodic sweep restoring expired pending holds — sharing `release()`'s restoration code path, multi-replica-safe via the atomic transition claim.

#### Acceptance criteria

- [x] Expired holds swept exactly once with two reaper instances racing
- [x] Sweep performs the same restoration as `release()` (shared code path)
- [x] Interval starts on module init, clears on shutdown (no open handles in Jest)
- [x] Non-expired pending holds untouched

#### Files to create / modify

`src/server/enforcement/hold-reaper.ts` · module wiring (+ spec files)

#### Agent prompt

````
You are a senior backend engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. A hold moves real wallet/budget headroom; a crash between hold() and capture()
must not strand it. The reaper sweeps pending records older than holds.ttlSeconds and restores
them — a v0.1 correctness requirement, not an optimization.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.3 of 12 (MIDDLE)

PRECONDITIONS
- Task 4.2 done: release() restoration path exists; ILedgerStore.findExpiredHolds +
  transition(from='pending') atomic claim exist.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "8.3 Lifecycle state machine" (the reaper paragraph:
  TTL, same restoration as release, transition claim = one replica wins), § "4.1" (holds
  ttlSeconds/reaperIntervalSeconds options), § "12.2" (hold.released with expired: true).
- docs/development_plan.md § "5.3 Hold reaper" (acceptance criteria — incl. NO @nestjs/schedule
  dependency: plain setInterval under lifecycle hooks).

TASK
Implement the reaper provider and wire it into the module lifecycle.

DELIVERABLES

1. src/server/enforcement/hold-reaper.ts — @Injectable() with onApplicationBootstrap (start
   setInterval(reaperIntervalSeconds)) and onApplicationShutdown (clearInterval). sweep():
   findExpiredHolds(now − ttlSeconds, batch 100) → for each: transition(id, 'pending',
   'released', { reason: 'expired' }) — null result = another replica won, skip; success →
   run the SHARED restoration routine extracted from release() (refactor MeteringService to
   expose an internal restoreHold(record) used by both) and emit hold.released
   { expired: true }. Errors per hold are logged and do not abort the batch.
2. Module wiring: reaper registered whenever budgets OR wallets are enabled (a hold without
   either still writes pending rows — register unconditionally; document).
3. Spec files: fake timers (start/stop lifecycle, no open handles), race with two reaper
   instances on one fake store (claim counter = 1), partial-batch error isolation,
   non-expired untouched.

Constraints:
- unref() the interval so it never blocks process exit.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='reaper'` — expected: green, 100%; Jest exits cleanly
  (--detectOpenHandles).

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 3/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.3 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.3`.
````

---

### Task 4.4 — meter() + reverse() orchestrator + getStatus()

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 4.2, 3.6

#### Description

The three remaining facade methods: the `meter()` wrapper (hold→fn→capture, release on error; post-hoc `enforce` without estimate), the orchestrated `reverse()` (ledger + wallet + budget + counter in one flow), and `getStatus()` (`AccessStatus` combining wallet + budgets). Also unlocks `record({ enforce: true })`.

#### Acceptance criteria

- [x] `meter` happy path returns `{ result, usage }`; fn throwing → hold released, error re-thrown
- [x] `meter` without estimate → `record({ enforce: true })` semantics (Phase 2 stub removed)
- [x] `reverse` on an enforced record restores wallet + all three window dimensions + counter; non-enforced → ledger only
- [x] `getStatus` reflects wallet + budgets; `hasAccess: false` + `blockedBy` when either exhausted; wallet section absent when wallets disabled
- [x] `record({ enforce: true })` post-hoc consume can throw AFTER the ledger write — record persists, error propagates (documented trade-off verified)

#### Files to create / modify

`src/server/services/metering.service.ts` (extend) (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. This task completes the MeteringService facade: meter() (the most common entry
point), the orchestrated reverse() (the bymax-fitness refund made first-class), and
getStatus() (the usage-meter query).

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.4 of 12 (MIDDLE)

PRECONDITIONS
- Tasks 4.1–4.2 done (hold/capture/release); Task 3.6 done (BudgetService.status);
  WalletService.getBalance live.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "11.1 MeteringService" (meter/reverse/getStatus
  signatures + MeterResult), § "8.5 Compensation" (step 3: the orchestrated variant — wallet
  refund via the linked debit + budget release incl. COUNT + counter, one transaction),
  § "10.6" (AccessStatus shape + blockedBy), § "11.2" (record enforce:true row + reverse row).
- docs/development_plan.md § "5.4 meter() + reverse() + getStatus()" (acceptance criteria).

TASK
Implement meter(), reverse(), getStatus(); enable record({ enforce: true }).

DELIVERABLES

1. meter(fn, context, extract, estimate?): with estimate → hold(context, estimate); try
   result = await fn(); usage = capture(hold, extract(result)); catch → release(hold,
   'fn threw') + rethrow; return { result, usage }. Without estimate → result = await fn();
   usage = record({ usage: extract(result), preset: context.preset, context: { ...context,
   enforce: true } }); return.
2. record enforce:true (remove the Phase 2 stub): after the ledger append (enforced: true):
   unless isSystemCost — BudgetService.consume(context, actual delta incl. count 1) +
   WalletService.debit(billed, usageRecordId, key `record:<recordId>`); failures propagate
   AFTER the record persisted (document in JSDoc: post-hoc enforcement bills a call that
   already ran — spec §11.2 trade-off).
3. reverse(usageRecordId, reason): LedgerService.reverse (2.2) → if original.enforced &&
   !isSystemCost: WalletService.refund (amount = original billed, usageRecordId, key
   `reverse:<id>`), BudgetService.release(scope-context rebuilt from the record,
   { nanoUsd, tokens, count: 1 }), counter decr; emit usage.reversed. All-or-nothing across
   stores is best-effort sequential with logged partial failures (document — cross-store 2PC
   is out of scope; idempotent keys make retries safe).
4. getStatus(tenantId, scope): budgets = BudgetService.status (empty when disabled); wallet =
   WalletService.getBalance + overdraft remaining (absent when disabled); hasAccess = no
   hard-block budget exhausted AND (wallet absent OR balance + overdraft > 0n); blockedBy set
   accordingly. Return AccessStatus.
5. Spec files per acceptance criteria (incl. the post-ledger enforce-throw ordering test and a
   reverse idempotent-retry test).

Constraints:
- reverse() is admin-plane: emit ai_tokens.audit alongside usage.reversed (spec §14.4).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='metering'` — expected: green, 100% on changed code.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 4/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.4 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.4`.
````

---

### Task 4.5 — StreamUsageCollector

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 4.2

#### Description

Streaming-safe usage capture: prefer the provider's final usage chunk; fall back to tokenizer-counted partial output on abort; `capture(hold, collector)` overload; the input-token fallback order.

#### Acceptance criteria

- [ ] OpenAI stream fixture (final chunk with `include_usage`) → provider-final usage wins
- [ ] Anthropic fixture (cumulative `message_delta` + `message_stop`) → finalized correctly
- [ ] Aborted stream + tokenizer → partial output billed; input per the fallback order (collector prompt count → hold estimate → 0)
- [ ] No tokenizer + no final usage → 422 `AI_TOKENS_STREAM_USAGE_MISSING`
- [ ] Exported from the server entry (public class)

#### Files to create / modify

`src/server/streaming/stream-usage-collector.ts` · `src/server/services/metering.service.ts` (capture overload) (+ spec files)

#### Agent prompt

````
You are a senior backend engineer with deep knowledge of LLM streaming APIs, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Streamed responses report usage only in the final chunk; an aborted stream reports
all-zero usage even though tokens were consumed. The collector makes aborts billable.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.5 of 12 (MIDDLE)

PRECONDITIONS
- Task 4.2 done: capture(hold, usage) live. Phase 1 normalizers + ITokenizer port exist.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "5.6 Streaming-safe capture" (the class contract:
  constructor opts, push(), finalize() precedence, the aborted-input fallback order — this is
  the normative definition), § "16.2" (STREAM_USAGE_MISSING row), § "11.1" (capture accepts
  `unknown | StreamUsageCollector`).
- docs/development_plan.md § "5.5 StreamUsageCollector" (acceptance criteria).

TASK
Implement the collector and the capture() overload.

DELIVERABLES

1. src/server/streaming/stream-usage-collector.ts — per spec §5.6: push(chunk) accumulates
   output text (OpenAI: chunk.choices[].delta.content; Anthropic: content_block_delta text;
   generic: a configurable extractor with those two built-in) and watches for final usage
   (OpenAI: chunk.usage non-null; Anthropic: message_delta.usage cumulative → keep latest +
   message_stop marker); setPromptText(text)/setPromptTokens(n) optional inputs for the
   fallback; finalize(): (a) provider-final usage seen → run it through the preset/provider
   normalizer; (b) else tokenizer present → NormalizedUsage with outputTokens =
   tokenizer.countTokens(accumulated), inputTokens per fallback order (prompt count if
   provided → else 0 here; the HOLD estimate fallback is applied by capture(), which knows the
   hold — document the split); (c) else throw AiTokensException('AI_TOKENS_STREAM_USAGE_MISSING').
2. capture() overload: detect a collector instance → usage = collector.finalize(); when the
   collector fell back (flag on the result) and inputTokens === 0 → use hold.estimatedTokens
   input portion (the estimate carries inputTokens for variant A — store it on the Hold;
   extend the Hold type per spec §11.1 which already carries estimatedTokens: document the
   composition).
3. Export the class from the server barrel.
4. Spec files: the four scenarios + a mixed cumulative-Anthropic sequence + collector reuse
   rejection (finalize twice → error).

Constraints:
- The collector never throws inside push() (malformed chunks are skipped + counted for debug).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='stream'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 5/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.5 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.5`.
````

---

### Task 4.6 — MeteringInterceptor + @Meter + guard hold mode + headers

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 4.2, 3.8

#### Description

The declarative capture path: interceptor extracts usage from the handler result and captures the guard's hold (or `record({enforce:true})`), releases on handler error; `@RequireBudget.estimate` activates the guard's hold mode; `exposeHeaders` sets the three `x-ai-tokens-*` headers.

#### Acceptance criteria

- [ ] Guard(estimate) + interceptor: hold placed pre-handler, captured with the handler's usage, released when the handler throws
- [ ] Interceptor without guard hold → `record({ enforce: true })`
- [ ] Headers present and correct when `exposeHeaders: true` (decimal strings)
- [ ] Handler returning no extractable usage → `AI_TOKENS_USAGE_MALFORMED` (not a silent skip)
- [ ] Fixture controller e2e-lite (supertest against a Nest testing module)

#### Files to create / modify

`src/server/enforcement/metering.interceptor.ts` · `src/server/enforcement/budget.guard.ts` (hold mode) (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The declarative path: @RequireBudget (guard: block or place a hold) + @Meter
(interceptor: capture usage from the handler's return value) — zero metering code in
controllers.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.6 of 12 (MIDDLE)

PRECONDITIONS
- Task 3.8 done (guard check-only + decorators + request.aiTokens contract); Task 4.2 done
  (hold/capture/release).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "11.3 BudgetGuard and MeteringInterceptor" (the full
  section — both bullets now apply: hold hand-off via request.aiTokens.hold; interceptor
  extract/capture/release rules; the three x-ai-tokens-* headers), § "11.4" (@Meter config:
  feature/scope/preset/extract/exposeHeaders/isSystemCost/tags), § "15.5" (headers carry
  decimal strings).
- docs/development_plan.md § "5.6 MeteringInterceptor" (acceptance criteria).

TASK
Add hold mode to BudgetGuard (replacing the Phase 3 NOT_CONFIGURED stub) and implement
MeteringInterceptor.

DELIVERABLES

1. BudgetGuard hold mode: when @RequireBudget.estimate present → after the status check
   passes, hold(context-with-@Meter-feature, estimate) and attach request.aiTokens.hold.
2. src/server/enforcement/metering.interceptor.ts — NestInterceptor: read @Meter config
   (absent → pass-through untouched); build context from request.aiTokens.context (guard ran)
   or scopeResolver directly (guard absent); on next.handle() success: extract usage
   (config.extract ?? (r) => (r as any)?.usage — typed safely; missing/undefined →
   throw USAGE_MALFORMED); hold present → capture(hold, usage); else record({ enforce: true,
   isSystemCost: config.isSystemCost, tags: config.tags, preset: config.preset, context });
   exposeHeaders → set x-ai-tokens-cost (raw), x-ai-tokens-billed-cost,
   x-ai-tokens-budget-remaining (min remaining nanoUsd across matched budgets, from a fresh
   status call or the guard's snapshot — use the guard snapshot, document staleness) as
   DECIMAL STRINGS via the HTTP adapter. On handler error with a hold → release(hold,
   'handler threw') then rethrow.
3. Spec files: the five acceptance scenarios via Test.createTestingModule + supertest fixture
   controller (guard+interceptor together; interceptor alone; error path releases; headers;
   malformed extraction).

Constraints:
- The interceptor must not swallow handler errors (release, then rethrow the ORIGINAL).
- rxjs usage per NestJS interceptor idiom (from/mergeMap or lastValueFrom in tests).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='interceptor|guard'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 6/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.6 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.6`.
````

---

### Task 4.7 — OpenTelemetry gen_ai.* emission

- **Status**: 📋 ToDo
- **Priority**: P1
- **Size**: M
- **Depends on**: 4.4

#### Description

`gen_ai.*` attribute/metric emission through `ITelemetrySink` on every posted record, with a strict no-content rule and zero overhead when unconfigured.

#### Acceptance criteria

- [ ] Every posted record triggers `recordUsage` with the documented attributes; duration on `meter()` paths
- [ ] No sink → no-op (no attribute objects built)
- [ ] No prompt/completion text in any attribute

#### Files to create / modify

`src/server/telemetry/{otel-emitter,no-op-telemetry}.ts` · wiring in `metering.service.ts` (+ spec files)

#### Agent prompt

````
You are a senior observability engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Telemetry follows the OpenTelemetry GenAI semantic conventions (gen_ai.*) so hosts
get Datadog/Grafana dashboards with zero mapping. Content is never captured.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.7 of 12 (MIDDLE)

PRECONDITIONS
- Task 4.4 done: all posting paths (record/capture) converge on shared internals.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "14.1 OpenTelemetry GenAI conventions" (the attribute
  list + the two metrics + the ITelemetrySink interface + no-content rule), § "4.1"
  (telemetry option block + metrics default).
- docs/development_plan.md § "5.7 OpenTelemetry emission" (acceptance criteria).

TASK
Implement the emitter and wire it into the posting paths.

DELIVERABLES

1. src/server/telemetry/otel-emitter.ts — buildGenAiAttributes(record): gen_ai.usage
   .input_tokens/output_tokens, gen_ai.request.model (requestedModel ?? model),
   gen_ai.response.model, gen_ai.operation.name, gen_ai.provider.name (+ service tier as
   gen_ai.request.service_tier custom attr — document as extension); emit via sink.recordUsage;
   meter()/interceptor paths also sink.recordDuration when the sink implements it.
2. src/server/telemetry/no-op-telemetry.ts — the default binding; posting paths guard with a
   cheap `if (telemetryEnabled)` so NO attribute objects are allocated when disabled (assert
   via spy on the builder).
3. Spec files: attribute snapshot per record shape; no-op zero-allocation guard; a regex
   assertion that no attribute value contains fixture prompt text.

Constraints:
- @opentelemetry/api stays an optional peer — the sink port isolates it; this task imports
  NOTHING from it (the host's sink does).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='telemetry'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 7/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.7 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.7`.
````

---

### Task 4.8 — UsageReportService

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 2.7

#### Description

SQL aggregation (`summarize` across 12 groupBy dimensions incl. `cacheSavingsNanoUsd`), streaming CSV/JSON export with the full field set, audit events, FX presentation, `maxExportRows`. Independent of the lifecycle tasks — may run in parallel (plan Appendix A).

#### Acceptance criteria

- [ ] `summarize` groupBy tests per dimension incl. `day` (UTC), `tag` (unnest), `beneficiary`, `systemCostCategory`; grand-total on empty groupBy
- [ ] `cacheSavingsNanoUsd = Σ cacheReadTokens × (inputRate − cacheReadRate)` verified against seeded records with known price versions
- [ ] CSV export streams (`Readable`), full §13.2 field set, bigints as decimal strings; JSON line-delimited
- [ ] `isSystemCost`/`systemCostCategory` filtering (the fitness admin reports)
- [ ] Export emits an audit event; `maxExportRows` enforced
- [ ] Non-USD `currency` + `fx` adds converted presentation columns

#### Files to create / modify

`src/server/services/usage-report.service.ts` (+ spec files; Prisma summarize SQL in `src/prisma/index.ts` if needed)

#### Agent prompt

````
You are a senior backend engineer specializing in analytics/reporting, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Reporting is real SQL over typed columns (the very thing bymax-fitness could not
do with JSON metadata): SUM…GROUP BY across 12 dimensions, plus cache-savings math and
streaming exports.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.8 of 12 (parallel lane)

PRECONDITIONS
- Phase 2 done (ledger + Prisma store). Independent of tasks 4.1–4.7.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "13.1 UsageReportService" (ReportFilter/UsageSummary/
  groupBy list/summarize + export signatures; `Readable` from node:stream), § "13.2 Export
  field set" (every column), § "7.4" (FX presentation-only rule), § "14.4" (audit per export),
  § "4.1" (reporting.maxExportRows).
- docs/development_plan.md § "5.8 UsageReportService" (acceptance criteria).

TASK
Implement the report service over ILedgerStore.query/sumCost plus a dedicated summarize
capability (extend ILedgerStore with a documented `summarize(filter, groupBy)` OPTIONAL method:
the Prisma store implements it in SQL; stores without it fall back to a documented
query-and-aggregate-in-memory path capped at maxExportRows — this keeps the port minimal while
letting the official adapter scale).

DELIVERABLES

1. src/server/services/usage-report.service.ts — summarize(filter & { groupBy }): delegate to
   store.summarize when present, else in-memory fallback; compute cacheSavingsNanoUsd per
   group: Σ over records of cacheReadTokens × (inputRate − cacheReadRate) resolved from each
   record's priceVersionId (records with null priceVersionId contribute 0 — document); apply
   fx presentation columns when currency !== 'USD'. export(filter, format): stream rows in
   pages (Readable.from(asyncGenerator)); CSV header per §13.2, bigint → decimal strings;
   'json' = ndjson lines; throw on > maxExportRows; emit ai_tokens.audit { action: 'export' }.
2. Prisma store summarize: raw SQL GROUP BY per dimension (day = date_trunc UTC; tag =
   unnest(tags); scope/beneficiary = type+id pairs) returning the sums + record counts.
3. In-memory fake store summarize (same semantics) for unit tests.
4. Spec files per acceptance criteria (seed a deterministic ledger fixture with known price
   versions; hand-compute expected sums in test comments).

Constraints:
- No bigint through JSON.stringify anywhere; use the toJsonSafe/formatting helpers.
- UsageReportService registers only when options.reporting is present (opt-in per §1.6 of the
  spec — verify against § "4.1"; reporting has defaults so it may be always-on: follow the
  spec's §1.6 listing which marks it opt-in via `reporting: {}`).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='report'` — expected: green, 100%.
- `pnpm test:e2e -- --testPathPattern='prisma'` — expected: existing suites still green
  (schema untouched).

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 8/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.8 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.8`.
````

---

### Task 4.9 — forRootAsync()

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: S
- **Depends on**: 4.4

#### Description

Async module configuration (useFactory/useClass/useExisting) with wiring parity to `forRoot()`.

#### Acceptance criteria

- [ ] All three async styles boot the fixture app; provider-set parity with `forRoot()` (snapshot-compared)
- [ ] Factory rejection → clean bootstrap failure with `AI_TOKENS_INVALID_CONFIG`

#### Files to create / modify

`src/server/bymax-ai-tokens.module.ts` (extend) (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. forRootAsync mirrors forRoot exactly, resolving options via
useFactory/useClass/useExisting — the family pattern from @bymax-one/nest-storage.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.9 of 12 (MIDDLE)

PRECONDITIONS
- Task 4.4 done: the full service set is stable (provider parity is meaningful).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "4.4 forRootAsync example" (the canonical shape) and
  § "4.6" (same validation/fan-out; NOT_CONFIGURED pre-init semantics).
- ../nest-storage/src/server/bymax-storage.module.ts — the forRootAsync block only.
- docs/development_plan.md § "5.9 forRootAsync()" (acceptance criteria).

TASK
Implement forRootAsync with an async options provider feeding the same resolution pipeline
(validate → applyDefaults → fan-out) used by forRoot.

DELIVERABLES

1. forRootAsync(asyncOptions): ASYNC_OPTIONS provider (factory/class/existing) → a resolver
   provider that validates + applies defaults (AI_TOKENS_INVALID_CONFIG on failure, incl.
   rejected factory promises) → all per-port/service providers consume the RESOLVED token
   (refactor forRoot to share buildProviders(resolved) so parity is by construction).
2. Spec files: three async styles boot; provider-token set snapshot equality vs forRoot;
   factory rejection → bootstrap failure with the right code.

Constraints:
- Both paths must share buildProviders — no duplicated wiring lists.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='module'` — expected: green, 100% on changed code.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 9/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.9 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.9`.
````

---

### Task 4.10 — Content sidecar wiring (opt-in)

- **Status**: 📋 ToDo
- **Priority**: P2
- **Size**: S
- **Depends on**: 4.4

#### Description

The `content` option: masked, TTL'd prompt/completion capture through `IContentStore` — OFF by default; the ledger stays text-free either way.

#### Acceptance criteria

- [ ] Disabled (default): no content-store calls ever (spy assertion)
- [ ] Enabled: mask applied before `put`; TTL propagated; failures logged, never break metering
- [ ] Ledger row contains zero text either way

#### Files to create / modify

`src/server/services/content-capture.ts` (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. PII discipline: the immutable ledger NEVER stores prompt/completion text; an
opt-in, masked, short-TTL sidecar (IContentStore) exists for debugging only.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.10 of 12 (MIDDLE)

PRECONDITIONS
- Task 4.4 done. IContentStore port exists (Phase 1).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "4.1" (the content option block), § "14.2 PII discipline"
  (the sidecar contract + purge), § "14.3" (erasure note for the JSDoc).
- docs/development_plan.md § "5.10 Content sidecar wiring" (acceptance criteria).

TASK
Implement the internal content-capture helper and its optional hook on the metering paths
(callers pass text explicitly — the library never sees prompts unless the host hands them in).

DELIVERABLES

1. src/server/services/content-capture.ts — internal captureContent({ usageRecordId,
   tenantId, prompt?, completion? }): when options.content enabled — mask via options.content
   .mask (default identity), store.put per role with ttlSeconds; try/catch → logger.error,
   never rethrow. Exposed to hosts via an optional `content?: { prompt?, completion? }` field
   accepted by record()/capture() context (extend MeteringContext LOCALLY? No — the spec
   does not put text on MeteringContext; add an explicit optional last parameter
   `content?: { prompt?: string; completion?: string }` to record()/capture; document it as
   the ONLY path text enters, and that it is dropped when the feature is off).
2. Spec files: disabled spy assertion; mask + TTL; failure isolation; a ledger-row scan test
   asserting no text fields.

Constraints:
- No text in events, telemetry, or ledger — only IContentStore.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='content'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 10/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.10 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.10`.
````

---

### Task 4.11 — E2E suite — the ten scenarios

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 4.1–4.10

#### Description

The ten e2e scenarios from spec §19.2 against real PostgreSQL + Redis (Testcontainers), with a shared fixture harness and fresh schema per suite.

#### Acceptance criteria

- [ ] All ten scenarios green against Testcontainers Postgres; scenarios 1 and 10 also exercise the Redis counter path
- [ ] Suite runs in CI's e2e job under 10 minutes
- [ ] No test-order dependence (fresh schema per suite via migrations)

#### Files to create / modify

`test/e2e/{concurrency,idempotency,stream-abort,reversal,anchored-window,count-quota,alias-resolution,seed-idempotence,wallet-burndown,reaper}.e2e-spec.ts` · `test/e2e/harness.ts`

#### Agent prompt

````
You are a senior test engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The e2e suite is the release-blocking proof: ten scenarios covering concurrency,
idempotency, streaming aborts, reversal, anchored windows, count quotas, alias resolution,
seed idempotence, wallet burn-down, and the reaper — against real Postgres (+ Redis).

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.11 of 12 (MIDDLE)

PRECONDITIONS
- Tasks 4.1–4.10 done. Docker available. jest.e2e.config.ts targets test/e2e, timeout 90s.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "19.2 E2E scenarios (Phase 4, Testcontainers)" — the TEN
  scenarios are the normative checklist; each maps 1:1 to a spec behavior. For per-scenario
  expected semantics consult ONLY the section each behavior cites (e.g. scenario 4 → § "8.5";
  scenario 5 → § "10.1" anchorAt; scenario 7 → § "6.6") — Grep on demand, per scenario.
- docs/development_plan.md § "5.11 E2E suite" (acceptance criteria).

TASK
Build the harness and the ten scenario specs.

DELIVERABLES

1. test/e2e/harness.ts — starts PostgreSQL (+ Redis for scenarios 1/10) containers once per
   suite file; applies src/prisma/migrations/*.sql; boots a Nest testing module with
   BymaxAiTokensModule.forRoot({ store: PrismaAiTokensStore, wallets, budgets: { counter?  },
   markup: 2.0 }); exposes typed helpers (seedPrice, grantWallet, upsertBudget, meterOnce).
2. Ten spec files, one scenario each, exactly per spec §19.2:
   (1) hold→capture concurrency: two parallel meter() with headroom for one — one 402/429;
   ledger/window/wallet agree. (2) idempotent retry: same key+payload → one row, same
   response; changed payload → 409. (3) stream abort: collector without final usage bills
   tokenizer-counted partial. (4) reversal restores headroom (wallet + 3 window dims + a
   subsequently-unblocked call). (5) renewal-anchored window rotates on the anchor day, not
   the calendar 1st; rotateWindow forces fresh. (6) count quota limitCount 2 + feature filter
   blocks the third matching call; non-matching feature passes. (7) alias resolution: price
   row gpt-5.2 rates a response reporting gpt-5.2-2026-03-14; Azure deployment via baseModel.
   (8) seed idempotence: two concurrent module boots → one seed pass. (9) wallet burn-down:
   two grants, different expiries — soonest first; expiry entry negates remainder. (10) reaper:
   an expired hold swept exactly once across two replica instances; wallet/budget restored;
   capture afterwards → 410.
3. Each spec's header comment cites its spec § and the invariant it proves.

Constraints:
- Fresh schema per suite (drop/recreate or new database per container); no cross-file state.
- Keep total runtime < 10 min (share containers per file, not per test).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test:e2e` — expected: 10 suites green.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 11/12. 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 4.11 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 4.11`.
````

---

### Task 4.12 — Phase-4 integration review

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 4.11

#### Description

Cross-cutting verification before release: the §11.2 side-effect matrix audited cell-by-cell against tests, the §1.10 normative-rule sweep, `/security-review` on the full money-movement surface, and an export-surface audit against spec §3.3.

#### Acceptance criteria

- [ ] Matrix audit documented in the PR description (each cell → test reference)
- [ ] `/bymax-quality:code-review` + `/security-review` clean (0 CRITICAL/HIGH)
- [ ] Export surface exactly matches spec §3.3 (nothing missing, nothing extra)

#### Files to create / modify

(review task — fixes land where findings point)

#### Agent prompt

````
You are a senior staff engineer performing the Phase 4 integration review on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Phases 1–4 are code-complete; this task is the audit gate before the release phase.

CURRENT PHASE: 4 (Metering Lifecycle + …) — Task 4.12 of 12 (LAST)

PRECONDITIONS
- Tasks 4.1–4.11 done; full test suite green.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "11.2 Side-effect matrix" (the table — your audit
  checklist), § "3.3 Public exports" (the export checklist), § "1.10"? No — that is the PLAN:
- docs/development_plan.md § "1.10 Cross-cutting normative rules" (the 12-rule sweep table)
  and § "5.12 Phase-4 integration review".

TASK
Audit, fix, and document — do not add features.

DELIVERABLES

1. Matrix audit: for each §11.2 cell, locate the test that proves it (grep test titles);
   missing proof → add the test; write the cell→test map into the PR description (and a
   docs/tasks note in this file's Completion log entry).
2. §1.10 rule sweep: for each of the 12 rules, one-line evidence (file/test). Violations fixed.
3. Export surface: diff the server/shared/prices/prisma/redis barrels against spec §3.3 —
   remove extras, add missing, verify the server re-export rule (`export * from shared`).
4. Run /bymax-quality:code-review and /security-review; apply ALL findings (re-verify after).
5. Confirm `pnpm typecheck && pnpm lint && pnpm test:cov && pnpm test:e2e && pnpm build &&
   pnpm size` all green.

Constraints:
- Fixes only — any behavior change beyond a finding is out of scope.
- Follow /bymax-workflow:standards.

Verification:
- Full gate chain above — expected: all green, reviews clean.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 12/12 and phase Status to 👀 Review (✅ after the plan §1.7
checklist passes end-to-end). 5. Update the Phase 4 row in docs/development_plan.md §1.5
(+§1.4; advance Active phase when ✅). 6. Append: `- 4.12 ✅ <YYYY-MM-DD> — <summary>`.
7. Commit `docs(plan): complete task 4.12`.
````

---

## Completion log

<!-- Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>` -->
- 4.1 ✅ 2026-07-03 — hold(): three estimate variants rated + marked up, compensated budget→wallet→pending reservation, idempotent replay.
- 4.2 ✅ 2026-07-03 — capture()/release(): idempotent settlement ±delta, cross-tenant HOLD_NOT_FOUND, 409/410 contracts, release restores in full and never bills.
- 4.3 ✅ 2026-07-03 — hold reaper: setInterval lifecycle sweep, atomic multi-replica claim, shared restore path, per-hold error isolation, unref'd (no open handles).
- 4.4 ✅ 2026-07-03 — meter()/reverse()/getStatus() + record({enforce}) post-hoc consume; orchestrated reversal restores wallet+budget+count; AccessStatus blockedBy.
