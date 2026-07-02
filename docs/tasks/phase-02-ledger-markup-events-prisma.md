# Phase 2 — Ledger + Markup + Events + Prisma Store

> **Status**: 📋 ToDo · **Progress**: 0 / 7 tasks · **Last updated**: 2026-07-02
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § 3
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md) (v0.2.0)
> **Complexity**: HIGH

---

## Context

Phase 1 delivered the shared core, pricing, and the module skeleton — any provider usage can be rated to exact nano-USD. This phase adds persistence and the first metering path: the immutable ledger (state machine `pending → posted | released`, payload-hash idempotency, compensation, opt-in per-tenant hash chain), the markup engine wired into rating, `MeteringService.record()` (observe-only; `enforce: true` stays stubbed until Phase 3 delivers wallets/budgets), the typed event system, and the official `PrismaAiTokensStore` (ledger + pricing halves) with the full 7-table schema fragment and SQL migrations.

**Definition of Done (demo):** `record()` writes a correct, idempotent, marked-up, event-emitting ledger entry to a real PostgreSQL database (Testcontainers migration smoke).

---

## Rules-of-phase

1. **Token economy.** Never read the spec/plan whole — Grep the cited `§` heading, read only that range. Never read other phase files. Phase 1 source may be read file-by-file only where a task lists it.
2. **The ledger is append-only.** No `UPDATE`/`DELETE` of posted amounts, ever. The ONLY permitted post-posting mutation is the `reversedByRecordId` annotation + status flip to `reversed` (spec §8.5). `transition()` enforces this.
3. **Balance math sums `posted` + `reversed`** — compensating records are `posted` with negated amounts (spec §8.3).
4. **Exactly-once:** upsert on `(tenantId, idempotencyKey)`; replay returns the existing record iff the payload hash matches, else 409 (spec §8.4).
5. **Markup applies in BOTH rating modes** (rate-table AND provider-reported), resolved to 4 dp and persisted on the record (spec §7.2, §2.3).
6. **`isSystemCost` rows never touch wallet/budget/counter** — in this phase that means: the record path stores the flag; the §11.2 matrix is implemented literally.
7. **Event failures never break metering** — sink errors are logged, not thrown (spec §12.1).
8. **`/security-review` is mandatory** at phase close (money-movement code starts here).
9. 100% coverage per file; TS strict; JSDoc; Conventional Commits; docs updated per task (Completion Protocol).

---

## Reference docs

- [`../technical_specification.md`](../technical_specification.md) — §8 (ledger), §7.2 (markup), §11.1–11.2 (record + side-effect matrix), §12 (events), §15.1–15.3 (ports, error mapping, schema). Read per-task sections only.
- [`../development_plan.md`](../development_plan.md) — §3 (sub-steps §3.1–§3.7), §1.10 (cross-cutting rules).

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 2.1 | LedgerService — append, idempotency, query, sumCost | 📋 ToDo | P0 | L | 1.11 |
| 2.2 | Ledger state machine + compensation (reverse, ledger-only) | 📋 ToDo | P0 | L | 2.1 |
| 2.3 | Opt-in per-tenant hash chain + verifyChain | 📋 ToDo | P1 | M | 2.2 |
| 2.4 | Markup engine wiring (number \| IMarkupPolicy) | 📋 ToDo | P0 | S | 1.11 |
| 2.5 | MeteringService.record() (post-hoc path) + estimateCost() | 📋 ToDo | P0 | M | 2.1, 2.4 |
| 2.6 | Typed events (catalog, EventEmitter2 bridge, IEventSink) | 📋 ToDo | P0 | M | 2.5 |
| 2.7 | PrismaAiTokensStore (ledger+pricing) + schema + migrations | 📋 ToDo | P0 | L | 2.1–2.5 |

---

## Tasks

### Task 2.1 — LedgerService — append, idempotency, query, sumCost

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 1.11

#### Description

The append/replay/query core over `ILedgerStore`: payload-hash computation, exactly-once upsert semantics, `LedgerFilter` queries, `sumCost`, and the `toJsonSafe()` bigint-boundary helper — plus the in-memory ledger fake reused by every later phase.

#### Acceptance criteria

- [ ] Replay with same key + same payload returns the identical record (same `id`), writes nothing
- [ ] Same key + different payload → 409 `AI_TOKENS_IDEMPOTENCY_CONFLICT`
- [ ] `sumCost` over a seeded fixture matches hand-computed totals (posted + reversed only)
- [ ] `query` honors every `LedgerFilter` field
- [ ] `toJsonSafe()` serializes every bigint as a decimal string, round-trip tested

#### Files to create / modify

`src/server/services/ledger.service.ts` · `src/server/utils/payload-hash.ts` · `src/server/utils/to-json-safe.ts` · `test/fakes/in-memory-ledger-store.ts` (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in financial ledgers, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The ledger is append-only and exactly-once: balance = Σ entries; corrections are
compensating records; retries never double-bill. TS strict, bigint money, Jest 100% + fast-check.

CURRENT PHASE: 2 (Ledger + Markup + Events + Prisma Store) — Task 2.1 of 7 (FIRST)

PRECONDITIONS
- Phase 1 done: shared types (UsageRecord, UsageStatus, LedgerFilter, NewUsageRecord),
  AiTokensException, ILedgerStore port, deriveIdempotencyKey all exist.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "8.2 UsageRecord" (columns + statuses), § "8.4 Exactly-once
  via idempotency keys" (upsert + payload-hash replay-or-conflict + random-UUID fallback),
  § "15.1 Store ports" (ILedgerStore signatures ONLY), § "15.5 BigInt at the JSON boundary"
  (toJsonSafe rule), § "8.3" (which statuses sum — first paragraph only).
- docs/development_plan.md § "3.1 LedgerService" (acceptance criteria).

TASK
Implement payload hashing, LedgerService (append/find/query/sumCost + toJsonSafe), and a
faithful in-memory ILedgerStore fake (unique (tenantId, idempotencyKey); stores payloadHash;
transition() left as a stub throwing 'not implemented' — Task 2.2 fills it).

DELIVERABLES

1. src/server/utils/payload-hash.ts — payloadHash(record fields): reuse the canonical-JSON
   sha256 from shared deriveIdempotencyKey internals over the normalized-usage + context
   subset (document WHICH fields participate: tokens, costs, provider, model, operation,
   serviceTier, feature, scope, occurredAt — exclude mutable/annotation fields).
2. test/fakes/in-memory-ledger-store.ts — Map-backed ILedgerStore: append upserts on
   (tenantId, idempotencyKey) returning existing on hash match, throwing a tagged conflict
   object on mismatch (the service maps it to the exception); query/sumCost implement every
   LedgerFilter field; findExpiredHolds by (status='pending', createdAt < olderThan).
3. src/server/services/ledger.service.ts — append(record, ctxKey?): compute idempotencyKey
   (ctx-supplied or randomUUID — document the no-dedupe consequence), payloadHash, totalTokens;
   delegate to store; map store conflict → AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT').
   query/sumCost passthroughs with default status filter ['posted','reversed'].
4. src/server/utils/to-json-safe.ts — deep clone converting bigint → decimal string; exported
   from the server barrel.
5. Spec files per the acceptance criteria (replay/conflict/sumCost/query-matrix/toJsonSafe).

Constraints:
- The service never mutates records after append (transition arrives in 2.2).
- No wallet/budget/event calls here — pure ledger.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='ledger|payload-hash|to-json-safe'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 1/7. 5. Update the Phase 2 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 2.1 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 2.1`.
````

---

### Task 2.2 — Ledger state machine + compensation

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 2.1

#### Description

`transition()` semantics (legal moves only, atomic from-state claim, null-on-mismatch) and `LedgerService.reverse()` — the ledger-only compensation primitive.

#### Acceptance criteria

- [ ] Every legal transition tested; every illegal transition rejected (posted→pending, released→posted, amount patch on posted→reversed, …)
- [ ] `reverse()` produces a compensating record whose amounts exactly negate the original (property test)
- [ ] After reverse, `sumCost` nets to zero for that pair
- [ ] `transition` from-state mismatch returns null (no throw) — race-claim contract verified with two concurrent calls on the fake

#### Files to create / modify

`src/server/services/ledger.service.ts` (extend) · `test/fakes/in-memory-ledger-store.ts` (extend) (+ spec files)

#### Agent prompt

````
You are a senior backend engineer specializing in financial ledgers, working on the
nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Ledger statuses: pending (hold) → posted (settled) | released (voided);
posted → reversed is an annotation-only flip driven by a compensating record.

CURRENT PHASE: 2 (Ledger + Markup + Events + Prisma Store) — Task 2.2 of 7 (MIDDLE)

PRECONDITIONS
- Task 2.1 done: LedgerService append/query/sumCost + in-memory fake (transition stubbed).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "8.3 Lifecycle state machine" (the four statuses + sum
  rule + reaper claim note), § "8.5 Compensation (reversal) semantics" (the 3-step orchestration
  — implement steps 1–2 here as the ledger-only primitive; step 3 is Phase 4's
  MeteringService.reverse), § "15.1" (transition signature + null contract).
- docs/development_plan.md § "3.2 Ledger state machine + compensation" (acceptance criteria).

TASK
Implement transition() in the fake (atomic from-state compare-and-set) and in LedgerService
(legality table + patch validation), then reverse() composing them.

DELIVERABLES

1. Fake store transition(): single-threaded CAS on status; returns null when current status
   !== from; applies patch; rejects amount-field patches unless from='pending' (settlement).
2. LedgerService.transition wrapper enforcing the LEGALITY TABLE:
   pending→posted (patch = actual amounts), pending→released (no amount patch),
   posted→reversed (patch = reversedByRecordId ONLY). Everything else → throw
   AiTokensException('AI_TOKENS_IDEMPOTENCY_CONFLICT', 409, { reason }) — misuse is a caller bug.
3. LedgerService.reverse(recordId, reason): load original; must be status 'posted' (pending/
   released → conflict; already 'reversed' → conflict); append compensating record (negated
   token counts + costs, status 'posted', reversesRecordId, idempotencyKey `reverse:<id>`,
   same scope/feature/flags, enforced copied); transition original posted→reversed with
   reversedByRecordId. Return the compensating record.
4. Spec files: legality matrix (table-driven), negation property test (fast-check over
   generated records), sum-to-zero, concurrent-claim race (two transitions, one null), idempotent
   re-reverse blocked via the `reverse:<id>` key.

Constraints:
- reverse() here touches ONLY the ledger — no wallet/budget/events (that composition is
  Phase 4, spec §8.5 step 3).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='ledger'` — expected: green, 100% on changed files.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 2/7. 5. Update the Phase 2 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 2.2 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 2.2`.
````

---

### Task 2.3 — Opt-in per-tenant hash chain + verifyChain

- **Status**: 📋 ToDo
- **Priority**: P1
- **Size**: M
- **Depends on**: 2.2

#### Description

Tamper-evident per-tenant hash chain over settled records (`ledger.hashChain: true`), with settlement-only hashing, store-serialized appends, and `verifyChain()`.

#### Acceptance criteria

- [ ] Chain off by default — zero hash computation when disabled (no `lastHash` store calls)
- [ ] Enabled: `record → capture-style settle → reverse` yields a verifiable chain; tampering any posted row makes `verifyChain` report exactly that row
- [ ] Settling a hold does not invalidate the chain (pending excluded)

#### Files to create / modify

`src/server/utils/hash-chain.ts` · `src/server/services/ledger.service.ts` (wire) (+ spec files)

#### Agent prompt

````
You are a senior backend engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Optional SOC 2-grade tamper evidence: each settled ledger record hashes the previous
one per tenant; verification detects any post-hoc modification.

CURRENT PHASE: 2 (Ledger + Markup + Events + Prisma Store) — Task 2.3 of 7 (MIDDLE)

PRECONDITIONS
- Task 2.2 done: state machine + reverse; fake store has lastHash stubbed to null.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "8.6 Tamper-evident hash chain (opt-in)" (all four rules:
  settlement-only hashing, per-tenant serialization delegated to the store, no re-hash on
  replay, verifyChain semantics), § "20.2" (the throughput caveat bullet — mirror it in JSDoc).
- docs/development_plan.md § "3.3 Opt-in hash chain" (acceptance criteria).

TASK
Implement the chain computation (canonical record serialization + sha256 with prevHash) and
verifyChain; wire into LedgerService settlement paths behind the resolved option flag; extend
the fake store with lastHash + a serialized-append toggle.

DELIVERABLES

1. src/server/utils/hash-chain.ts — chainHash(prevHash, record): sha256 over prevHash +
   canonical settled-field serialization (same field set as payload-hash PLUS status/ids;
   document it). Pure.
2. LedgerService wiring: when options.ledger.hashChain — on append with status 'posted'
   (record() fast path) and on transition pending→posted / posted→reversed-compensation,
   fetch lastHash(tenantId), compute, persist prevHash+hash via the same write. When disabled:
   guard so lastHash is NEVER called (assert via fake-store call counter).
3. verifyChain(tenantId, from?, to?): walk settled records in append order, recompute, return
   { valid: true } | { valid: false, brokenAtRecordId } and emit an 'ai_tokens.audit' event
   hook point (event wiring exists after 2.6 — leave a documented dispatcher callback the
   module wires; do not import the dispatcher here to avoid a cycle).
4. Spec files per acceptance criteria incl. a tamper test (mutate a stored record in the fake,
   verify detection).

Constraints:
- Per-tenant serialization is the STORE's contract (advisory lock in Prisma — Task 2.7);
  the fake simulates it with a per-tenant mutex; document the contract in ILedgerStore JSDoc.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='hash-chain|ledger'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 3/7. 5. Update the Phase 2 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 2.3 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 2.3`.
````

---

### Task 2.4 — Markup engine wiring

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: S
- **Depends on**: 1.11

#### Description

The internal markup resolver: `number | IMarkupPolicy` → validated 4-dp multiplier per call, applied in both rating modes.

#### Acceptance criteria

- [ ] Static multiplier and async policy both resolve; policy receives the full context (incl. `serviceTier`)
- [ ] Policy returning `1.23456` → applied as `1.2346` and persisted as such
- [ ] Provider-reported mode: OpenRouter cost × markup verified
- [ ] Policy throwing → the metering call fails (no silent 1.0 fallback), wrapped error

#### Files to create / modify

`src/server/services/markup.resolver.ts` (+ spec file)

#### Agent prompt

````
You are a senior backend engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Markup is the SaaS profit lever: billedCost = rawCost × multiplier, resolved
per-call from a static number or an IMarkupPolicy, exact 4-dp bigint math.

CURRENT PHASE: 2 (Ledger + Markup + Events + Prisma Store) — Task 2.4 of 7 (MIDDLE)

PRECONDITIONS
- Phase 1 done: applyMarkup + resolveMultiplier4dp (shared), IMarkupPolicy port, resolved
  options carry the markup config.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "7.2 Markup / margin" (IMarkupPolicy context + the
  "resolved value is persisted" rule), § "2.3 Rating flow" (markup applies in BOTH modes).
- docs/development_plan.md § "3.4 Markup engine wiring" (acceptance criteria).

TASK
Implement the internal MarkupResolver used by the metering paths.

DELIVERABLES

1. src/server/services/markup.resolver.ts — internal @Injectable():
   resolve(ctx: { scope, provider, model, operation, serviceTier, feature? }):
   Promise<{ multiplier: number; apply: (raw: bigint) => bigint }> — static path returns the
   init-validated multiplier; policy path awaits policy.resolve(ctx), validates via
   resolveMultiplier4dp (invalid/throwing → rethrow wrapped in
   AiTokensException('AI_TOKENS_INVALID_CONFIG', 500, { reason })), and returns the 4-dp value
   + a bound applyMarkup.
2. Spec file per acceptance criteria (static/policy/async policy/4-dp persistence value/
   provider-reported composition — compose with a fake providerReportedCostNanoUsd/throwing
   policy).

Constraints:
- NOT exported from the public barrel (internal service; registered by the module).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='markup'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 4/7. 5. Update the Phase 2 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 2.4 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 2.4`.
````

---

### Task 2.5 — MeteringService.record() + estimateCost()

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 2.1, 2.4

#### Description

The observe-only metering facade path: normalize (preset/normalizer/already-normalized detection) → rate (both modes) → markup → ledger append — plus the pure `estimateCost()`. `enforce: true` throws until Phase 3/4 deliver wallets/budgets.

#### Acceptance criteria

- [ ] Raw usage + preset → posted record with correct provider/model/tier/tokens/costs/markup/`enforced: false`
- [ ] Already-`NormalizedUsage` input accepted without preset
- [ ] Raw input without preset → 400 `AI_TOKENS_UNKNOWN_PROVIDER`
- [ ] `isSystemCost` + `systemCostCategory` + `beneficiary` + `requestedBy` + `tags` + `extraUnits` all land on the record
- [ ] `priceMissing` path (non-strict) records cost 0 + flag + `ai_tokens.price.missing` event hook
- [ ] `estimateCost()` returns raw+billed with zero side effects

#### Files to create / modify

`src/server/services/metering.service.ts` (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. MeteringService is the public facade; this task implements its post-hoc record()
path and estimateCost(). The hold/capture lifecycle is Phase 4.

CURRENT PHASE: 2 (Ledger + Markup + Events + Prisma Store) — Task 2.5 of 7 (MIDDLE)

PRECONDITIONS
- Tasks 2.1 + 2.4 done: LedgerService, MarkupResolver; Phase 1 normalizers/presets/pricing.

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "11.1 MeteringService" (record() input contract,
  MeteringContext fields, estimateCost signature — the hold/capture/release/meter/reverse/
  getStatus members are LATER phases: declare them throwing AI_TOKENS_NOT_CONFIGURED with a
  '"…arrives in Phase N"' reason so the class compiles against the spec surface), § "11.2
  Side-effect matrix" (record default row + the enforce row — enforce:true in THIS phase throws
  AI_TOKENS_INVALID_CONFIG reason 'enforce requires wallets/budgets (Phase 3)'), § "2.3 Rating
  flow" (mode selection: context > preset > module default; provider-reported requires
  providerReportedCostNanoUsd → else AI_TOKENS_USAGE_MALFORMED), § "16.2" rows for
  UNKNOWN_PROVIDER / USAGE_MALFORMED / PRICE_NOT_FOUND.
- docs/development_plan.md § "3.5 MeteringService.record()" (acceptance criteria incl. the
  NormalizedUsage detection heuristic: presence of provider + numeric token fields).

TASK
Implement record() and estimateCost() composing normalizer → PricingService → computeCost →
MarkupResolver → LedgerService, with an injectable event-hook callback (wired in 2.6).

DELIVERABLES

1. record(input): resolve the normalizer (input.normalizer > input.preset.normalizer >
   already-normalized detection > throw UNKNOWN_PROVIDER); normalize (wrap plain Errors in
   USAGE_MALFORMED); resolve rating mode; rate-table: PricingService.resolveRate(...,
   context.baseModel) + computeCostNanoUsd (strict miss propagates PRICE_NOT_FOUND; non-strict
   null → zero costs + priceMissing true + fire the price-missing hook); provider-reported:
   use providerReportedCostNanoUsd (absent → USAGE_MALFORMED); markup.apply → billed; build
   NewUsageRecord (status 'posted', enforced false, occurredAt input or now, requestedModel
   from context.baseModel, serviceTier context override > normalized > 'standard', all context
   attribution fields); LedgerService.append; fire usage-recorded hook; return the record.
2. estimateCost(input): resolveRate + computeCost over a synthetic NormalizedUsage
   (inputTokens/maxOutputTokens as outputTokens) + markup; NO ledger/event calls.
3. Spec files per acceptance criteria; verify the §11.2 record-default row: fake wallet/budget
   services (not yet existing) are NOT referenced anywhere.

Constraints:
- No wallet/budget imports. Event hook = injected optional callback token (2.6 replaces with
  the dispatcher); default no-op.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='metering'` — expected: green, 100% on the service.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 5/7. 5. Update the Phase 2 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 2.5 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 2.5`.
````

---

### Task 2.6 — Typed events

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 2.5

#### Description

The event dispatcher: envelope construction, optional-peer `EventEmitter2` bridge, `IEventSink` delivery, wired into `record()` and the ledger hooks.

#### Acceptance criteria

- [ ] `record()` emits `ai_tokens.usage.recorded` with the documented payload
- [ ] Emitter peer absent → no crash, sink still delivers
- [ ] Sink throwing → error logged, metering unaffected
- [ ] Envelope ids unique; `occurredAt` set; payload types exported from `./shared`

#### Files to create / modify

`src/server/events/{event-dispatcher,event-emitter.bridge}.ts` · module wiring (+ spec files)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. Events are a typed public contract: envelope { id, type, occurredAt, tenantId,
scope?, data }, delivered at-least-once via optional @nestjs/event-emitter and/or an
IEventSink port. Event failures NEVER break metering.

CURRENT PHASE: 2 (Ledger + Markup + Events + Prisma Store) — Task 2.6 of 7 (MIDDLE)

PRECONDITIONS
- Task 2.5 done: record() fires a no-op event hook; shared event types exist (Task 1.2).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "12.1 Envelope and delivery" (both channels + the
  never-throw rule + optional-peer guard), § "12.2 Event catalog" (the 11 types + payloads —
  only usage.recorded / usage.reversed / price.missing / audit are LIVE this phase; the
  budget/wallet/hold events get emitted by later phases through this same dispatcher),
  § "15.5" (bigint → decimal strings when leaving the process via a sink).
- docs/development_plan.md § "3.6 Typed events" (acceptance criteria).

TASK
Implement the dispatcher + emitter bridge, register them in the module, and replace the 2.5
no-op hook.

DELIVERABLES

1. src/server/events/event-emitter.bridge.ts — lazy, guarded resolution of EventEmitter2:
   dynamic import of '@nestjs/event-emitter' inside a try/catch at module init; absent →
   channel disabled (documented). Never a hard import.
2. src/server/events/event-dispatcher.ts — internal @Injectable(): emit<T>(type, tenantId,
   scope, data): builds the envelope (randomUUID id, occurredAt now), then (a) emitter channel
   when enabled: emitter.emit(type, envelope) with bigints INTACT (in-process); (b) sink
   channel: sink.deliver(toJsonSafe(envelope)) awaited with try/catch → logger.error, never
   rethrown.
3. Module wiring: dispatcher provider; replace the record() hook; expose an internal
   audit(action, details) convenience used by later admin-plane tasks.
4. Spec files per acceptance criteria (peer-absent simulation via jest module mocking; sink
   failure isolation; envelope uniqueness; payload snapshot for usage.recorded).

Constraints:
- @nestjs/event-emitter stays an OPTIONAL peer — no top-level import anywhere.
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='events'` — expected: green, 100%.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 6/7. 5. Update the Phase 2 row in docs/development_plan.md §1.5
(+§1.4). 6. Append: `- 2.6 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 2.6`.
````

---

### Task 2.7 — PrismaAiTokensStore (ledger + pricing) + schema + migrations

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 2.1–2.5

#### Description

The official adapter's ledger + pricing halves, the full 7-table schema fragment, the SQL migrations (both partial indexes included), the advisory-locked seed, and a Testcontainers migration/round-trip smoke.

#### Acceptance criteria

- [ ] Migrations apply cleanly on a fresh Postgres container; both partial indexes verified via `pg_indexes`
- [ ] `append` + replay + conflict + `transition` race (two connections) behave per spec §15.2 against the real database
- [ ] `resolveRate`/`upsertPrice` honor the open-row unique index (concurrent upsert test)
- [ ] Advisory-locked seed: two concurrent seeds → one seed pass
- [ ] `unitRates` JSON round-trips bigint-as-decimal-string correctly

#### Files to create / modify

`src/prisma/index.ts` · `src/prisma/schema.prisma.fragment` · `src/prisma/migrations/0001_init.sql` · `test/e2e/prisma-migrations.e2e-spec.ts`

#### Agent prompt

````
You are a senior NestJS + PostgreSQL engineer working on the nest-ai-tokens project.

PROJECT: @bymax-one/nest-ai-tokens — AI token metering & usage-based billing library for
NestJS 11. The ./prisma subpath ships PrismaAiTokensStore (the official IAiTokensStore
implementation), a schema fragment hosts merge via Prisma multi-file schema, and raw SQL
migrations. This task delivers the ledger + pricing halves; wallet/budget halves are Phase 3.

CURRENT PHASE: 2 (Ledger + Markup + Events + Prisma Store) — Task 2.7 of 7 (LAST)

PRECONDITIONS
- Tasks 2.1–2.5 done: service contracts stable; in-memory fakes define expected semantics.
- Docker available locally and in CI's e2e job (Testcontainers).

REQUIRED READING (only these sections — Grep the heading, read that range only):
- docs/technical_specification.md § "15.3 Prisma schema" (ALL seven models VERBATIM + the two
  raw-SQL partial indexes + merge mechanics paragraph), § "15.2 Store error mapping" (the whole
  table — P2002 replay-or-conflict via payloadHash comparison, 0-row conditional → domain
  errors, Decimal↔number, unknown → STORE_ERROR), § "15.1" (ILedgerStore + IPricingStore
  signatures), § "6.4" (advisory-locked idempotent seed — use pg_advisory_xact_lock),
  § "8.6" rule 2 (per-tenant advisory lock for hash-chain appends — implement the lock hook
  even though chain e2e lands later).
- docs/development_plan.md § "3.7 PrismaAiTokensStore" (acceptance criteria + risk notes).

TASK
Author the schema fragment + 0001_init.sql (all seven tables, matching §15.3 exactly, plus the
partial unique index on open price rows and the partial pending-status index), implement the
ledger+pricing halves of PrismaAiTokensStore (wallet/budget methods throw 'Phase 3'), and the
Testcontainers smoke.

DELIVERABLES

1. src/prisma/schema.prisma.fragment — the seven §15.3 models verbatim, header documenting the
   multi-file-schema merge workflow + Prisma >= 6 requirement.
2. src/prisma/migrations/0001_init.sql — CREATE TABLE ×7 + all @@index/@@unique from the
   fragment + the two raw-SQL partial indexes:
   ai_model_prices (provider, model, operation, service_tier) WHERE effective_to IS NULL;
   ai_usage_records (created_at) WHERE status = 'pending'.
3. src/prisma/index.ts — PrismaAiTokensStore(prisma: PrismaClient): ledger half (append with
   P2002 → fetch + payloadHash compare → return-or-conflict; transition via updateMany
   WHERE id AND status = from → count 0 = null; query/sumCost with real SQL aggregation;
   findExpiredHolds; lastHash with pg_advisory_xact_lock(hashtext(tenantId)) around
   chain-appends) + pricing half (resolveRate effective-dated select; upsertPrice in a
   transaction closing the open row; getPriceHistory; listModels; seed with
   pg_advisory_xact_lock + ON CONFLICT DO NOTHING). unitRates persisted as JSON of decimal
   strings (bigint ↔ string at the adapter boundary); markupMultiplier Decimal(10,4) ↔ number.
   Wallet/budget port methods: throw AiTokensException('AI_TOKENS_NOT_CONFIGURED', 503,
   { reason: 'wallet/budget store arrives in Phase 3' }).
4. test/e2e/prisma-migrations.e2e-spec.ts — Testcontainers Postgres: apply 0001_init.sql;
   assert both partial indexes in pg_indexes; append/replay/conflict round-trip; transition
   race with two PrismaClient connections; concurrent upsertPrice honoring the open-row index;
   two concurrent seeds → rows seeded once.

Constraints:
- Raw SQL where Prisma cannot express it ($queryRaw / $executeRaw) — never weaken semantics
  to fit the ORM.
- @prisma/client imported type-only at the top level where possible (optional peer).
- Follow /bymax-workflow:standards.

Verification:
- `pnpm test -- --testPathPattern='prisma' --testPathIgnorePatterns=e2e` — expected: unit green.
- `pnpm test:e2e -- --testPathPattern='prisma-migrations'` — expected: green (Docker required).
- `pnpm build && pnpm size` — expected: dist/prisma < 15 KB brotli.

Completion Protocol:
1. Set status ✅ (task block + index). 2. Tick acceptance criteria. 3. Update the index row.
4. Bump header progress to 7/7 and phase Status to 👀 Review (✅ after the plan §1.7 checklist
+ /bymax-quality:code-review + /security-review findings are applied). 5. Update the Phase 2
row in docs/development_plan.md §1.5 (+§1.4; advance Active phase when ✅). 6. Append:
`- 2.7 ✅ <YYYY-MM-DD> — <summary>`. 7. Commit `docs(plan): complete task 2.7`.
````

---

## Completion log

<!-- Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>` -->
