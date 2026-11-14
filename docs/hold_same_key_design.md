# Design note: `hold()` with one idempotency key racing itself

Status: **design only. Nothing is implemented.** Basis: a measured race on PostgreSQL 16 and Redis, two Nest instances over two Prisma clients, against v1.1.14 (main 4e9a29f), and the enforcement rework of #193 (main 55cf7b2).

## What is measured

Measured against main 01df8ed (the same mechanism as the first measurement on 4e9a29f), two Nest instances over two Prisma clients, one PostgreSQL, the wallet funded for 100 holds (625,000,000 nano; one hold is 6,250,000), the table read straight from `ai_usage_records`:

| case | outcomes | pending rows | released rows | wallet balance (a correct run) |
| --- | --- | --- | --- | --- |
| `hold()` x2, one key | 1 ok, 1 `AI_TOKENS_IDEMPOTENCY_CONFLICT` | 1 | 0 | 625,000,000 (618,750,000) |
| `hold()` x10, one key | 1 ok, 9 conflicts in the last run (7 ok, 3 conflicts in the first, where six callers replayed the winner's row at the lookup) | 1 | 0 | 625,000,000 (618,750,000) |
| the winner holds and releases, the loser misses the row at its lookup and loses the append | the loser gets the conflict | 0 | 1 | **631,250,000** (625,000,000) |

The budget window is right in the first two rows (spent 6,250,000, count 1): the loser releases its own consumption.

One reservation should be missing from the wallet in the first two rows. None is: the live hold reserves nothing, so its `capture()` credits the difference between the estimate and the actual cost to a wallet that was never debited, and a later release or reaper sweep refunds the estimate a second time.

The third row is worse: the wallet ends above its starting balance by one reservation of credit that nothing paid for, because the winner's release refunded the one debit (`release:<id>`) and the loser's rollback refunded it again (`hold-rollback:<key>`). That makes the defect a P1: it creates credit from nothing.

## Why

`hold()` is: lookup by key, then `reserveHold` (budget consume, then wallet debit keyed `hold:<key>`), then the pending append keyed `<key>`. The lookup is not serialized (`record()` has a per-key serializer, `hold()` does not), so two attempts both pass it, both consume the budget, and both debit under `hold:<key>`. The wallet replays the second debit onto the first entry, so the wallet moves once. One append wins; the other fails with a key conflict (its occurredAt differs), and `compensateHold` then refunds under `hold-rollback:<key>`, a key nobody replays, so it credits back the debit that belongs to the winner. The budget release is right (that consumption was the loser's own); the wallet refund is wrong. Of the 7 ok callers of N=10, one is the winner; the other six arrived after its row existed and replayed it, or lost the append with a payload that matched the stored row and got that row back, which is correct.

The same shape cost `record({ enforce: true })` its retry in #193; the fix there is the reference.

## Proposal

1. **Serialize `hold()` per `(tenantId, key)` inside an instance**, with the `KeyedSerial` that `record()` uses, so concurrent calls on one instance wait and the later ones find the row at the lookup and replay it. This removes the race for one instance.
2. **Across instances, compensate only what this attempt did.** After a failed pending append, look the row up by the key (as `afterFailedAppend` does for `record()`), and decide with one allowlist, `sharesDebit`, extended to the hold call shape: the row is a hold (pending, posted after a capture, or released) of the same payer, enforced, not a system cost, whose payer owns a wallet. A losing attempt whose row is the same call shape gives back its budget consumption and keeps nothing else (its `hold:<key>` debit replayed the winner's entry). A released hold counts: the winner's release already refunded that one debit under `release:<id>`, and a second refund by the loser would credit the wallet twice. Any other row, or no row and no key, refunds the attempt's own debit.
3. **A keyed hold whose append failed with no row keeps its debit**, as a keyed record does: a refund under another key would be replayed by the retry's `hold:<key>` debit, so the retry would return a pending hold that reserves nothing. A keyless hold, which no retry can replay, refunds. When the ledger cannot say whether the row exists, nothing is undone.
4. **An append that committed before its error reached the caller** (the row carries this attempt's instant) keeps its charge; a retry with the key replays the row. This is the "committed, then the client timed out" case, and it is the one the current rollback gets wrong, because it refunds a hold whose row exists.

Nothing is migrated and no public type changes.

## The atomic primitive, and what each caller sees

The database already provides the primitive: the unique index on `(tenantId, idempotencyKey)` of `ai_usage_records`. Exactly one concurrent insert of a key succeeds; every other gets a unique violation, which the store maps to the key conflict or, when the stored payload hash matches, to the stored row. A conditional insert (`INSERT ... ON CONFLICT DO NOTHING`) would add nothing, since the loser must still learn what the winner wrote, and a new lock would not cover two instances. The design therefore keeps the unique index as the only arbiter and makes the losing side undo exactly what it did, which is the whole defect.

What a caller sees, per outcome:

- The winner: its pending hold, with the wallet reduced once and the budget consumed once.
- A caller that arrives after the winner's row exists: the same hold, replayed at the lookup (unchanged).
- A caller that loses the append with a row of the same call shape: `AI_TOKENS_IDEMPOTENCY_CONFLICT` when its payload differs, or the winner's hold when the payloads match; in both cases its own budget consumption is given back and the winner's wallet reservation is left alone.
- A caller that loses with a row of another shape (a record, another payer, a system cost): the conflict, with its own wallet debit and budget consumption given back.

## Red tests, in this order

- Unit, in-memory stores: a concurrent pair with one key on one instance returns one hold and reduces the wallet by one reservation; a later `capture()` and a reaper sweep never refund more than was debited.
- Unit: the loser of a key conflict (the replay lookup missed) with the same call shape keeps the winner's debit and gives back only its budget; with another payer, a record row, or a system-cost row it refunds its own.
- Unit: an append that commits then throws keeps the reservation and its retry replays the hold.
- Unit: a loser that meets a captured-hold row, and a loser that meets a `record()` row of the same payer, keep their debit and refund nothing (the stated direction of the ambiguity).
- Unit and end to end: the winner releases its hold before the loser's recovery lookup; the wallet ends at its starting balance, not above it.
- End to end, real PostgreSQL and two instances: the measured race above with the wallet balance, the pending row count and the budget window asserted after each run, N = 2 and 10.

## What it does not fix

- Two instances racing one key can still consume the budget twice for the one hold when the loser's append returns the stored row without an error (the payloads match), so no release runs; the key-conflict path does release. Budget consumption has no per-call marker. That is the settlement design (a per-call budget marker keyed by the idempotency key).
- A price or markup change between a failed append and its retry changes the estimate, and the retry then fails with the key conflict while the kept debit stays without a row. Same limit as `record()`.
- **A captured hold and a `record()` row are both posted and nothing on the row tells them apart.** There is no hold id, capture link or call-kind column on `ai_usage_records`; `updatedAt` differs for a settled hold only as a side effect of the settlement, which is not a contract, so the design does not read it. The ambiguity is resolved in one direction on purpose: a posted row of the same payer, enforced and not a system cost, is treated as sharing the debit, for a record loser and for a hold loser alike, so the loser keeps its debit and refunds nothing. The cost of a wrong guess is then an overcharge of one reservation when a `record()` and a `hold()` that was captured collide on one key (the two use different wallet keys, `record:<key>` and `hold:<key>`, so the loser's debit was its own); the other direction would refund a settled debit, which is free usage and is not allowed. Unit cases pin both: a loser that meets a captured-hold row, and a loser that meets a `record()` row of the same payer, each keep their debit.
- **An orphan debit.** A keyed hold whose append failed with no row keeps its `hold:<key>` debit for the retry to replay. If the client never retries, that debit has no row: the reaper sweeps rows, so it cannot find it, and nothing releases it, so the reservation stays out of the wallet. The bound is one reservation per failed append that is never retried, with no time limit. Owner: the settlement design (the next item), which adds the sweep: refund the `hold:<key>` and `record:<key>` debits that have no ledger row once they are older than the hold TTL. It needs a way to list wallet entries by key prefix, which the store port does not have; this PR does not add it.

## Cost

About the size of the #193 recovery: one helper shared with `record()`, an extension of `sharesDebit`, and the serializer. The server bundle budget will need a small raise, which the PR states.
