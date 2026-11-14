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
- `findEffectsOwed?(olderThan, limit): Promise<OwedEffects[]>` where `OwedEffects` is `{ record, reservedBilledNanoUsd?, reservedTokens? }`. A new type, so the public `UsageRecord` does not grow.
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
- **Grace.** A new option `settlement.graceSeconds` (default 300, approved), whole seconds. A sweep that starts earlier races an inline call that is still running, which the keys make harmless but wasteful. **Validated at boot, not only documented:** it must be a whole number of seconds from 1 to 2,147,483, and `retentionSeconds` must be a whole number that exceeds both `graceSeconds` and `holds.ttlSeconds`. The module options carry no request, append, pool or transaction timeout (the only durations are `holds.ttlSeconds` and `holds.reaperIntervalSeconds`), so there is no timeout for the grace to be compared with, and the note does not invent one; whether the host should declare its longest request time is a question for the PM. Each invalid value or relation is refused with `AI_TOKENS_INVALID_CONFIG` naming the option, and each has a red refusal test.
- **Claim: no lock is held.** The sweep selects owed rows **without a row lock**. Several replicas, or one replica's two overlapping ticks, may run one row: every leg is idempotent by key (the wallet entry keys, the budget application keys), so a duplicate run moves nothing and clearing the marker is idempotent. `FOR UPDATE SKIP LOCKED` is rejected because the wallet and budget calls go through other ports, possibly other connections, and a lock held across them is a long transaction and a lock wait. A test runs two sweepers at once over the same owed rows and asserts the wallet, the window and the references against a run with one sweeper.
- **Tenant.** Every effect the sweep runs carries the row's own `tenantId` (the context is built from the row, never from the sweeper). A red test with two tenants asserts that sweeping one tenant's owed row never moves the other tenant's wallet, budget or references.
- **Failure.** A row whose effects fail again keeps its marker; the next tick retries. The log does not flood: the sweep logs **one summary per tick** under a stable key with the count of failed rows and the first record id, never amounts text, and a tick with no failure logs nothing. No retry counter and no dead-letter table in this PR: a persistent failure is an operator signal, and adding state for it is a separate decision.
- **Events.** The sweep re-emits the event and the span the transition owes (`usageRecorded`, `holdReleased`, `usageReversed`), at least once; consumers are already told to be idempotent on the record id. An ordinary `record()` carries no marker, so the events of a committed-then-error append stay a documented limit (settlement note, item 6).

## 3. The budget-reference sweep (conditions B and C)

PR 1 documented one over-count until the sweep: a reference that is not `row` and whose attempt died. The sweep gives each such reference a verdict by looking at the ledger row of its key. It runs from the same tick and needs one store call to list the stale ones: `findStaleReferences(olderThan, limit)` on `IBudgetStore`, returning `{ key, budgetId, attempt, tenantId }`, optional like the others.

| the reference | the ledger row for its key | verdict |
| --- | --- | --- |
| named by an attempt, older than the grace | none | `dropReference`: the movement is given back when it was the last reference |
| named by an attempt, older than the grace | `pending`, `posted` or `reversed` | **condition B:** `commitReference`: rename to `row`, so a committed call is never under-counted. A reversed row is renamed, not dropped: its reversal already gave the amounts back through the separate application `reverse:<id>`, and dropping the last reference would unapply the original movement a second time. |
| named by an attempt, older than the grace | `released` | `dropReference`, never a rename, so a released row does not keep a reservation. |
| `row` | `released` | `dropReference` on `row`: the hold was released between the append and the commit and nothing released the reference afterwards. This is the interleaving two reviewers found on PR 1, and it is a required test here. |
| `row` | `reversed` | keep, for the reason above: the reversal's own application cancels the amounts, and a drop would subtract them twice. |
| `row` | `pending`, `posted` | keep. |
| `row` | none | keep: a `capture:<id>` or `reverse:<id>` adjust takes `row` directly and has no row of its own under that key. |

Two limits of the lookup, stated so the verdict is not over-read. The ledger key of a `reserve:<key>` reference is `<key>`; a `record:<call key>` reference maps to `<call key>`; `capture:` and `reverse:` references are not swept by this table (they take `row` directly). A call with no idempotency key used a fresh id, so no ledger row can exist under it and the first row of the table applies. Whether a found row is "the same call" (payer, feature, instant, billed amount) is decided by the same `sameCall` the failed-append path uses, so the sweep and the inline path cannot disagree: a row that is not the same call is the third row of the table.

**Test required by the PM:** crash after the take and before the append, then a price change, then the sweep, then a retry that succeeds exactly once and counts once.

## 4. Pruning (condition C)

`ai_budget_applications` and `ai_budget_references` grow by one row per keyed movement and are never deleted today. The sweep prunes them, never earlier than a key can still be replayed.

- A key can be replayed as long as its ledger row exists, but a replay of a ledger row returns the row and takes no budget movement (the lookup precedes the effects). What the application row still protects is a **concurrent** attempt, which lives for less than the grace, and a **sweep re-run** of an owed effect, which lives until the marker is cleared.
- **Rule:** delete an application (its references go with it, `ON DELETE CASCADE`) when it was given back (`unappliedAt` set) or when its ledger row is terminal with no marker, and in both cases it is older than the retention.
- **Retention:** `settlement.retentionSeconds`, default 7 days (approved), validated at boot as in section 2. The figure is a default without a deployment measurement, and the Apply note says so.
- A pending hold's `row` reference is never pruned: only release or reversal ends it.

## 5. What changes for users, and the size

- **Migration `0003`** (additive: three nullable columns on `ai_usage_records`) and the optional port additions above. A custom store that ignores them keeps working, with the sweep inactive for it; the Apply note says so.
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
- The reference table: one test per row, with a reversed row for each reference kind (an attempt-named reference of a reversed record is renamed and the window ends equal to a run that never failed; a `row` reference of a reversed row is kept and the window is not subtracted twice), including the released-between-append-and-commit interleaving and the price-change retry.
- Pruning: an application inside the retention survives, one past it is deleted with its references, a pending hold's `row` survives, an unmarked terminal row's application is deleted.
- Real PostgreSQL, two instances: kill the effects between the transition and the budget call (a store double that throws once), run the sweep on both, and assert the wallet, the window and the references against a run that never failed.
- Contract tests for each new store call, so a custom store is held to the same rule.

## What it does not fix

- The effects are at-least-once for events and spans; the wallet and budget are exact.
- A counter and a window can still disagree between a crash and the next sweep or `reconcileWindow`; counter repair is PR 3, with the `occurredAt` of `reserveHold` the previous review found.
- A caller that never retries and whose process dies before the transition commits leaves the `pending` row it leaves today, which the reaper already reclaims.
- The price-change retry of the settlement note, item 5, stays a documented limit.
