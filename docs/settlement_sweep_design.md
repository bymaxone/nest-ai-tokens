# Design note: the effects-owed marker, the owed-effects sweep and the budget-reference sweep

Status: **design only. Nothing is implemented.** Approved by the PM as 2a then 2b, with the rulings recorded in each section. Basis: a reading of the code at main (7a900ff), after the keyed once-only budget effects of the previous note (`settlement_design.md`, PR 1 of the series) landed. Every item below gets a red test as its first step.

This is PR 2 of the series. PR 1 made every budget movement safe to repeat, which is what lets a sweep re-run effects. This note covers what the sweep needs to find work and what it does with it.

## Scope: two pull requests (ruled)

The order ruled for the series was: marker and sweep, then counter repair, then the orphan-debit sweep. The orphan give-back and the refund-then-retry-exactly-once tests are the orphan-debit sweep of the first note (item 4). Ruled: **two pull requests, in this order**:

- **2a** (this note, sections 1 to 5): the marker, the owed-effects sweep, the reference sweep (conditions B and C), pruning.
- **2b** (section 6): the orphan debit give-back and the exactly-once refund tests.

Reason: 2b needs a new wallet port call (`listEntries` by key prefix) and its own claim protocol on the unique key, and a mistake there is a double refund of real money, which deserves its own review. 2a does not depend on it.

## 1. What a sweep needs to find: the marker

Today a transition commits and its effects run afterwards. A crash between the two leaves a `posted`, `released` or reversed row whose wallet and budget legs never ran, and nothing records that they are owed.

**Columns on `ai_usage_records`** (migration `0003`, additive, nullable):

- `effectsOwedAt timestamptz NULL`: set in the same statement as the transition; cleared when the effects have run.
- `owedReservedBilledNanoUsd bigint NULL` and `owedReservedTokens integer NULL`: set only by a capture. The transition overwrites the reserved billed amount and token count with the actuals, and the capture's budget adjustment and wallet settlement are the difference between the two, so the reserved values must outlive the transition or the deltas cannot be recomputed after a crash.

**Who sets it:**

- `capture`: `pending → posted`, with the reserved values.
- `release` and the reaper: `pending → released`.
- `reverse`: the compensating append (`reverse:<id>` key) carries it, because that is the first of the two ledger writes and a crash after it and before the annotation of the original is the case to recover (the original still reads `posted`).

**Port changes (`ILedgerStore`), all optional so an existing custom store keeps working with the sweep inactive for it:**

- `transition(id, from, to, patch?, hashChain?, owed?)`: a trailing optional argument; a store that ignores it never sets the marker.
- `append(record, payloadHash, hashChain?, owed?)`: the same trailing optional argument, which is how the compensating append of a reversal carries the marker in its own statement.
- `findEffectsOwed?(olderThan, limit): Promise<OwedEffects[]>` where `OwedEffects` is `{ record, reservedBilledNanoUsd?, reservedTokens? }`. A new type, so the public `UsageRecord` does not grow. For a reversal it returns the compensating row, and the sweep finds the original through the compensating row's `reversesRecordId`.
- `clearEffectsOwed?(id): Promise<boolean>`.

The marker is a fact about when effects were owed, not about the money: no amount of a posted record changes, and the ledger stays append-only. The Prisma store sets it with a column list in the same `UPDATE` or `INSERT` that does the transition, so the two cannot be separated by a crash.

## 2. The owed-effects sweep

The hold reaper's sweep gains a second query next to the expired-hold scan: rows with `effectsOwedAt` older than a grace. For each, it runs the same code the inline path runs, then clears the marker.

| owed by | wallet leg (idempotent by key) | budget leg (idempotent by key) |
| --- | --- | --- |
| capture | `settleAdjustment` under `capture:<id>` | `adjust` under `capture:<id>`, delta from the stored reserved values and the posted actuals |
| release or reaper | `refund` under `release:<id>` | `release`: drop of the `row` reference under `reserve:<ledger key>` |
| reverse | `refund` under `reverse:<id>`, after finishing the annotation of the original (`posted → reversed`, a no-op when it already happened) | `adjust` under `reverse:<id>` |

- The inline path (`capture`, `release`, `reverse`) is unchanged and runs first, and clears the marker after the effects, so the common path pays one extra statement.
- **Grace.** A new option `settlement.graceSeconds` (default 300, approved), whole seconds. The grace is a performance knob and not a correctness bound: a sweep that judges an attempt whose call is still running is made safe by the commit, whatever the grace is (see "An attempt that outlives the grace" below). **Validated at boot, not only documented:** it must be a whole number of seconds from 1 to 2,147,483, and `retentionSeconds` must be a whole number that exceeds both `graceSeconds` and `holds.ttlSeconds`. The module options carry no request, append, pool or transaction timeout, so there is no timeout for the grace to be compared with, and none is invented: the grace does not need one. Each invalid value or relation is refused with `AI_TOKENS_INVALID_CONFIG` naming the option, and each has a red refusal test.
- **Claim: no lock is held.** The sweep selects owed rows **without a row lock**. Several replicas, or one replica's two overlapping ticks, may run one row: every leg is idempotent by key (the wallet entry keys, the budget application keys), so a duplicate run moves nothing and clearing the marker is idempotent. `FOR UPDATE SKIP LOCKED` is rejected because the wallet and budget calls go through other ports, possibly other connections, and a lock held across them is a long transaction and a lock wait. A test runs two sweepers at once over the same owed rows and asserts the wallet, the window and the references against a run with one sweeper.
- **Tenant.** Every effect the sweep runs carries the row's own `tenantId` (the context is built from the row, never from the sweeper). A red test with two tenants asserts that sweeping one tenant's owed row never moves the other tenant's wallet, budget or references.
- **Failure.** A row whose effects fail again keeps its marker; the next tick retries. The log does not flood: the sweep logs **one summary per tick** under a stable key with the count of failed rows and the first record id, never amounts text, and a tick with no failure logs nothing. No retry counter and no dead-letter table in this PR: a persistent failure is an operator signal, and adding state for it is a separate decision.
- **Events.** The sweep re-emits the event and the span the transition owes (`usageRecorded`, `holdReleased`, `usageReversed`), at least once; consumers are already told to be idempotent on the record id. An ordinary `record()` carries no marker, so the events of a committed-then-error append stay a documented limit (settlement note, item 6).

## 3. The budget-reference sweep (conditions B and C)

PR 1 documented one over-count until the sweep: a reference that is not `row` and whose attempt died. The sweep gives each such reference a verdict by looking at the ledger row of its key. It runs from the same tick and needs one store call to list the stale ones: `findStaleReferences(olderThan, limit, after?)` on `IBudgetStore`, returning each stale reference with the fields of its application, `{ key, budgetId, attempt, tenantId, windowStart, spentNanoUsd, spentTokens, spentCount }`, optional like the others. The verdict reads the application's window and delta from that result, because no existing store call returns them.

**Selection.** The call lists references named by an attempt that are older than the grace, and `reserve:` references named `row` that are older than the hold TTL plus the grace (a hold still pending beyond its TTL is released by the reaper, so only a captured, released or reversed hold has a `row` reference that old). It orders by `(createdAt, key, budgetId, attempt)`, the whole primary key of a reference after its creation time, and pages by the cursor `after`, which carries all four: two attempts that take in one millisecond tie on the first three, never by age alone with a limit, because the kept `row` references of every live call stay older than the grace and would otherwise be returned first on every tick and starve the attempt-named references behind them. A tick walks pages until one is empty or a per-tick page budget is spent, and the cursor lives in memory and wraps to the start when the pages run out. The sweep is idempotent, so a restart that loses the cursor repeats work and loses none.

The verdict is a function of the reference kind, the reference name and the row state, enumerated completely, and the implementation holds it with a test that walks the whole product.

**Inputs.** The reference kind: `reserve:` (a hold) or `record:` (an enforced record). The reference name: named by an attempt and older than the grace, or `row`. The ledger row for its key: none, `pending`, `posted`, `reversed` or `released`. For an attempt-named reference, whether that row is the same call (defined below the matrix).

**Rules, in order.**

1. An attempt-named reference with no row: `dropReference`. The movement is given back when it was the last reference.
2. An attempt-named reference whose row is not the same call: `dropReference`.
3. An attempt-named reference whose row is the same call: `commitReference` (rename to `row`) when the row is `pending`, `posted` or `reversed`, so a committed call is never under-counted (condition B).
4. A `reserve:` `row` reference whose row is `released`: `dropReference` (the hold was released between the append and the commit and nothing released the reference afterwards).
5. Every other `row` reference: keep.

**The matrix.** Every cell, with the verdict and why it moves the window the right number of times. "same" and "other" mean the row is or is not the same call.

| reference | none | `pending` | `posted` | `reversed` | `released` |
| --- | --- | --- | --- | --- | --- |
| `reserve:` named by an attempt | drop | same: rename, other: drop | same: rename, other: drop | same: rename, other: drop | drop |
| `record:` named by an attempt | drop | drop (a hold row is never the same call as a record) | same: rename, other: drop | same: rename, other: drop | drop (a record row is never released) |
| `reserve:` named `row` | keep | keep | keep | keep | drop |
| `record:` named `row` | keep | keep | keep | keep | keep (a record row is never released) |

- **drop** unapplies the movement when it was the last reference: the window gets one subtraction of the stored delta, once. A drop that is not the last reference moves nothing.
- **rename** keeps the movement applied, so it is counted once for a live row. On a `reversed` row the reversal's own application `reverse:<id>` already adds the negated amounts, so the window nets to zero; a drop there would subtract the original movement a second time, which is why `reversed` renames and keeps.
- **keep** leaves the movement applied: a `row` reference on a `pending`, `posted` or `reversed` row is the one that row's call stands on, and a `reserve:` or `record:` `row` reference with no row is not reachable, because the rename follows the append and the ledger is append-only; it is kept defensively.

**The test that holds the matrix.** A table-driven test iterates the whole product and fails on a cell that has no verdict, and for each cell asserts the window and the references against a run that never failed. A new row state or reference kind makes the enumeration fail until the matrix names it.

The ledger key of a `reserve:<key>` reference is `<key>`; a `record:<call key>` reference maps to `<call key>`; `capture:` and `reverse:` references are not swept by this table (they take `row` directly). A call with no idempotency key appended under a fresh id, so a row can stand under it after a crash between the append and the commit: the lookup runs for every reference. Whether a found row is "the same call" is computed from what the sweep can read, because a reference stores no payer, feature or instant: the budget the reference names (loaded by `budgetId`), the application (its window and its delta) and the ledger row. The call is the same when the budget matches the row's tenant, payer scope and feature restriction (the matching `BudgetService` already applies), and the row's status fits the kind and the row is enforced and not a system cost, as `sameCall` requires of both kinds. A `record:` reference also needs the application's window to be the window of the row's `occurredAt`; a `reserve:` reference does not compare the window, because a hold takes its window from the clock at the take and its row's `occurredAt` is read earlier, so the two can straddle a window boundary. A `record:` reference also needs the application's delta to equal the row's billed amount and tokens with a count of one, and a `posted` or `reversed` row. A `reserve:` reference accepts `pending`, `posted` or `reversed` and does not compare the amount, because a capture overwrites the billed amount of a hold's row with the actuals and the application already pins the delta (a retry at another price is refused at take and never holds a reference). A tenant-wide budget cannot tell two payers apart and need not: both attempts share one application whose movement is counted once, so renaming either reference leaves it counted once. A row that is not the same call is rule 2, the drop.

**Accepted limit.** A keyed `record()` row that won a race against a `hold()` on the same key is `posted` like a captured hold's row, and the sweep cannot tell them apart: it renames the hold's reference onto it and the reservation stays counted until its window rotates, where the inline path would have dropped it. It needs that race on one key, and the over-count fails closed and is bounded by the window.

**An attempt that outlives the grace.** The reference of an attempt lives from the take to the commit around one ledger append: `hold()` reserves, appends the pending row and commits, and `record({ enforce: true })` consumes, appends and commits. The metered call itself (a streaming completion of many minutes) runs after `hold()` has returned or before `record()` is called, so a reference named by an attempt does not span it; once committed the reference is named `row` and is not judged by rules 1 to 3. Only a stuck append, such as a driver that does not return, outlives the grace. If the sweep then drops the attempt's reference, `BudgetService.commit` finds the reference `gone` and applies the movement again once, keyed under the committed name and without limits, so a committed call is always counted and the early drop heals itself. This was already built in the keyed budget effects and is held there by the tests that count a call whose reference was reclaimed while its append was in flight. A heartbeat of the reference, or a host-declared maximum call duration, is not needed and is not added: the first would add a write per running attempt for a case the commit already repairs, and the second would make a correctness bound out of a number the host has to guess. One residual is accepted: between the sweep's drop and the commit the window does not count the call, so another call can be admitted under the limit, and the re-apply can leave the window above it; the interval is the length of one stuck append and the call is counted in the end.

**Test required by the PM:** crash after the take and before the append, then a price change, then the sweep, then a retry that succeeds exactly once and counts once.

## 4. Pruning (condition C)

`ai_budget_applications` and `ai_budget_references` grow by one row per keyed movement and are never deleted today. The sweep prunes them, never earlier than a key can still be replayed.

- A key can be replayed as long as its ledger row exists, but a replay of a ledger row returns the row and takes no budget movement (the lookup precedes the effects). What the application row still protects is a **concurrent** attempt, whose reference the sweep may judge after the grace and whose commit repairs that, and a **sweep re-run** of an owed effect, which lives until the marker is cleared.
- **Rule:** delete an application (its references go with it, `ON DELETE CASCADE`) when it was given back (`unappliedAt` set) or when its ledger row is terminal with no marker, and in both cases it is older than the retention.
- **Retention:** `settlement.retentionSeconds`, default 7 days (approved), validated at boot as in section 2. The figure is a default without a deployment measurement, and the Apply note says so.
- A pending hold's `row` reference is never pruned: only release or reversal ends it.

## 5. What changes for users, and the size

- **Migration `0003`** (additive: three nullable columns on `ai_usage_records`) and the optional port additions above. A custom store that ignores them keeps working, with the sweep inactive for it; the Apply note says so. The Prisma store does not detect the columns at boot: the Apply note makes migration `0003` mandatory before the runtime update, as for `0002`, because a transition on an installation without the columns would fail the inline capture, release or reverse.
- Three new options under `settlement`: `graceSeconds`, `retentionSeconds`, and `enabled` (default true, accepted in a patch), validated at boot. A custom store without the optional calls leaves the sweep inactive: the Apply note says so, and the module logs that once at boot.
- Patch release with an Apply note (DEC-063). The server bundle budget needs a new number, measured after the work; the PM sets the figure.

## 6. The orphan debit give-back (2b, if split)

A keyed call whose append failed with no row keeps its wallet debit for the retry to replay; a call that is never retried leaves the debit with no record.

- A new `idempotencyKeyPrefix` filter on `IWalletStore.listEntries`, optional.
- The sweep lists `record:` and `hold:` debits older than the grace, looks each key up in the ledger, and for those with no row **claims the key first** by appending a released row under it, so the unique index on `(tenantId, idempotencyKey)` makes the give-back and the retry's append mutually exclusive: whichever writes the key first wins. Then it refunds under `orphan:<debit id>`, so a second run is a replay.
- A retry that starts after the claim is refused at its ledger lookup with the idempotency conflict and needs a new key. A retry that passes the lookup first hits the same unique index, and its own withdraw and the sweep's refund must be mutually idempotent, so exactly one refund is written.
- **Red tests:** refund then retry; a retry that completes between the sweep's lookup and its claim; two sweeps at once; each asserts exactly one refund and the wallet balance of a run that never failed.

## Red tests for 2a, in this order

- Unit, in-memory stores: a `capture` whose effects throw after the transition leaves the marker and the reserved values; the sweep finishes the wallet and budget legs exactly once, a second pass changes nothing, and a `capture` retried inline meanwhile does not double them.
- The same for `release`, the reaper, and `reverse`, including the crash between the compensating append and the annotation of the original, and a refund that throws (today it is logged and lost).
- Boot validation: each relation between `graceSeconds`, `retentionSeconds` and the hold TTL, and each non-whole value, is refused naming the option.
- Two tenants, and two sweepers at once (sections 2).
- The failure log: a row that fails every tick produces one summary line per tick, not one per row.
- A call whose append outlives the grace, the sweep running in the middle of it and then the commit: the window counts the call exactly once and its references end as one `row`; the same for a hold and for an enforced record.
- The reference matrix: one test per cell, a listing test with more kept `row` references than the page size that still reaches an attempt-named reference behind them, with a tenant-wide budget shared by two payers and a `record:` reference whose application delta differs from the row's amount, with a reversed row for each reference kind (an attempt-named reference of a reversed record is renamed and the window ends equal to a run that never failed; a `row` reference of a reversed row is kept and the window is not subtracted twice), including the released-between-append-and-commit interleaving and the price-change retry.
- Pruning: an application inside the retention survives, one past it is deleted with its references, a pending hold's `row` survives, an unmarked terminal row's application is deleted.
- Real PostgreSQL, two instances: kill the effects between the transition and the budget call (a store double that throws once), run the sweep on both, and assert the wallet, the window and the references against a run that never failed.
- Contract tests for each new store call, so a custom store is held to the same rule.

## What it does not fix

- The effects are at-least-once for events and spans; the wallet and budget are exact.
- A counter and a window can still disagree between a crash and the next sweep or `reconcileWindow`; counter repair is PR 3, with the `occurredAt` of `reserveHold` the previous review found.
- A caller that never retries and whose process dies before the transition commits leaves the `pending` row it leaves today, which the reaper already reclaims.
- The price-change retry of the settlement note, item 5, stays a documented limit.
