# Design note: settlement, effects after a committed transition, and the leftovers of the enforcement rewrite

Status: **design only. Nothing is implemented.** Basis: a reading of `main` at 36a8325 (v1.1.14 plus the unreleased 1.1.15 work). Every item below gets a red test as its first step, so each claim here is one the implementation proves before it changes anything; none was measured on a running system for this note.

This collects what the earlier notes ([`hold_same_key_design.md`](hold_same_key_design.md) and the #193 recovery) deliberately left open, plus the three findings of the production review that share their root: the ledger transition and the effects it implies are two steps, and only the first is atomic.

## The root: a transition commits, its effects are best-effort

`capture`, `release` and `reverse` each do `ledger.transition(...)` or `ledger.reverse(...)` (one atomic statement) and then apply the effects one after the other: the event, the telemetry span, the content capture, the budget movement, the wallet movement.

What a crash, a store error or a lost connection between the two steps leaves:

| operation | after the transition commits | what is lost |
| --- | --- | --- |
| `capture` | the row is `posted` with the actual cost | the budget still holds the estimate and the wallet still holds the reservation, never settled; no `usageRecorded` event, no span |
| `release` | the row is `released` | the budget consumption and the wallet reservation are never given back; the reaper only reclaims `pending` rows, so nothing ever does |
| `reverse` | the compensating row exists, the original is annotated | the refund and the budget release run under a `try`/`catch` that only logs, so a failed one is never retried |

The wallet legs are safe to repeat: their keys (`capture:<id>`, `release:<id>`, `reverse:<id>`) make a second attempt a replay. The budget legs are not: `adjust` and `release` are signed `adjustWindow` calls with no key, so repeating one applies it twice. That asymmetry is why "just retry the effects" is not a fix today.

## The other open items, in the same terms

1. **Budget consumed twice across instances for one keyed call** (the limit named in the hold note): the loser's append returns the stored row without an error, so no compensation runs. The same shape applies to `record({ enforce: true })` retried on another instance.
2. **A multi-budget consume that throws part-way.** `consume` walks the matching windows; the rollback of the windows already consumed runs only when a block verdict arrives. A store error, or a soft-policy `adjustWindow` that throws, in a later window leaves the earlier ones consumed with no record.
3. **The Redis counter is not repaired by `reconcileWindow`.** It recomputes the database window from the ledger and adjusts that row; the counter keys are untouched, so a counter that drifted (a crash between its increment and the database consume, an expired key) keeps blocking or allowing on the wrong number until its TTL.
4. **An orphan debit.** A keyed call whose append failed with no row keeps its wallet debit for the retry to replay; a call that is never retried leaves the debit with no record. Finding it needs a listing of wallet entries by key prefix, which the store port does not have.
5. **A price or markup change between a failed append and its retry** changes the amount, so the retry fails with the key conflict while the kept debit stays.
6. **Committed, then an error reached the caller**: the retry replays the row, so `usageRecorded`, the span and the content capture of that call are never emitted.

## Proposal

The shape is forward recovery, not rollback: make every effect safe to repeat, record that a transition's effects are still owed, and let the process that already sweeps (the hold reaper) finish them.

1. **An effects-owed marker written by the transition itself.** One nullable column on `ai_usage_records`, set in the same statement as the transition (`pending → posted`, `pending → released`, the reversal), cleared once the effects have run. A row with the marker set and an old `updatedAt` is work. `ledger.transition` and `ledger.reverse` set it; the effects clear it through one new store call. No second table and no distributed transaction.
2. **Keyed, once-only budget effects.** A small table `ai_budget_applications (budgetId, windowStart, key, kind)` with a unique key, and one store call that inserts the marker and moves the window in one transaction (`adjustWindowOnce`). `key` is the call key, or `<recordId>:capture|release|reverse`. A repeat inserts nothing and moves nothing. This is also the per-call marker item 1 needs: the loser of a cross-instance race finds the winner's marker and consumes nothing. It also removes the need for item 2's rollback on a throw, because a retry of the failed call finishes the windows that were not applied and skips the ones that were.
3. **The reaper finishes owed effects.** Its sweep gains a second query: rows with the marker set older than a threshold are settled by running the effects (wallet legs by their keys, budget legs by `adjustWindowOnce`, then the event and the span), then clearing the marker. `capture`, `release` and `reverse` run the same code inline first, so the common path pays nothing extra.
4. **Repair the counter from the window.** `reconcileWindow` resets each counter key of the budget and reseeds it with the recomputed spend, exactly as `resyncCounter` already does after an overflow. It is a cache repair, never a source of truth.
5. **Sweep orphan debits.** Add an `idempotencyKeyPrefix` filter to `IWalletStore.listEntries`. The reaper lists `record:` and `hold:` debits older than a threshold, looks each key up in the ledger, and refunds the ones with no row under a key of its own (`orphan:<debit id>`), so the refund is a replay if it runs twice.
6. **A changed price between a failed append and its retry** stays a documented limit unless it is measured to matter: the debit is the cost the caller was charged, and the retry's key conflict is the honest answer. Re-pricing a retry from the kept debit would hide a real change.
7. **Emit the lost events from the same marker.** An event or span owed by a committed row is re-emitted by the sweep from item 3, so item 6 of the list above is recovered, at least once. Consumers must already be idempotent on the record id.

## What changes for users

- **A schema migration** (`0002`): the marker column and `ai_budget_applications`. A port addition: `IWalletStore.listEntries` takes the key-prefix filter, and `IBudgetStore` gains `adjustWindowOnce`. `ILedgerStore` gains the marker call.
- That is a **minor release (1.2.0)**, not a patch, with an Apply note: custom stores implement the new calls, existing databases run the migration.
- The `server` bundle budget needs a new number, measured after the work and set by the owner of the budget, not by the author.

## Red tests, in this order

- Unit, in-memory stores: `capture` whose effects throw after the transition leaves the marker set; a second `capture` and the sweep finish the wallet and budget legs exactly once, and a third pass changes nothing.
- Unit: `release` and `reverse` the same way, including a `reverse` whose refund throws: today it is logged and lost.
- Unit: a multi-budget consume where the second window throws leaves no consumption once the call is retried to completion, and the first window is not applied twice.
- Unit: the counter diverges from the window; `reconcileWindow` reseeds it.
- End to end, real PostgreSQL and two instances: the keyed race of the hold note and a keyed `record({ enforce: true })` race, with the budget window asserted after each run: consumed once.
- End to end: kill the effects between the transition and the budget call (a store double that throws once), run the sweep, assert the wallet, the window and the counter against a run that never failed.
- Contract tests for each new store call, so a custom store is held to the same rule.

## What it does not fix

- The effects are at-least-once, not exactly-once, for events and spans. The wallet and the budget are exact; the event stream can repeat.
- A counter and a window can still disagree for the interval between a crash and the next sweep or `reconcileWindow`; the window is authoritative and the counter fails over to it.
- The price-change retry of item 5 above.
- A caller that never retries and whose process dies before the transition commits leaves the same `pending` row it leaves today, which the reaper already reclaims.

## Whether the Prisma store's decision logic can be mutation-tested

`src/prisma/index.ts` is outside the Stryker `mutate` set because it only runs against PostgreSQL, so the money fixes made in it (the activation, the sweep, the debit guard, `reconcile`) are held by the end-to-end suite alone. Two ways to change that:

1. **Move the decision logic into `adapter-sql.ts`, which is mutated.** Most of what decides is already a statement: `pendingGrantsSql`, `spendableBalanceSql`, the open-grants ordering and the activation `WHERE` are pure text and bound values. Turning the remaining inline statements of `index.ts` (the activation select, the sweep select, the reserve `UPDATE`) into builders next to them puts their text under the unit specs and under Stryker, as the builders already are. `index.ts` keeps what a unit test cannot hold, the order of the steps inside a transaction (lock, replay, activate, sweep, reserve, insert, allocate), and that order stays with the e2e suite. The cost is a mechanical extraction, a verbatim move per statement, in the style of the `budget-math.ts` and `record-columns.ts` moves, with a builder spec for each.
2. **Run Stryker on `index.ts` over Testcontainers.** Each surviving-or-killed verdict needs a real database round trip, and `index.ts` has several hundred mutants. Even with Stryker's per-test coverage selecting only the e2e suites that reach a mutant, one run per mutant costs a Postgres start plus the suite, so a whole-file run is hours, not minutes. It is not affordable per pull request. It could run nightly on the file or on a diff of its changed functions; that has not been measured here, only estimated from the length of one e2e run.

Recommendation: (1), as a backlog item after this work, since it also shrinks what only the e2e suite guards; keep (2) as a possible nightly job once (1) has left `index.ts` with only the orchestration.

## Cost

The largest of the review items: a migration, three store calls, one reaper extension and the effects code moved behind one idempotent path. It is meant to land as a series, in this order, each its own pull request with its own red test: the marker and `capture`/`release`/`reverse` effects first (the table above), then the budget applications table and the cross-instance case, then the counter repair, then the orphan sweep.
