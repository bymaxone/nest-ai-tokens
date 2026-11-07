# Design note: an opt-in, self-verifying repair of shifted `occurredAt` values

Status: **design only. Nothing is implemented.** Basis: measurements against the real v1.1.11 and v1.1.12 builds, Prisma 6.19.3, with `Asia/Tokyo` and `America/Sao_Paulo` sessions. What an affected operator sees, and why, is in the README (section "Records written before 1.1.12 on Prisma 6 under a non-UTC session zone").

## Facts the repair rests on

1. The chain hash is `chainHash(prevHash, {id, ...content})`: a canonical SHA-256 over the previous hash, the record id and the content hash (`src/server/utils/hash-chain.ts`). `occurredAt` is part of the content. A row stored with a shifted `occurredAt` fails `verifyChain` at that row (measured: `valid: false`, `brokenAtRecordId` = the first shifted row).
2. A shifted row holds `W = wallclock(T, Z)`: the true instant `T` written as the wall-clock time of the session zone `Z` (measured: 12:00Z stored as 21:00 in Tokyo and 09:00 in São Paulo). Reading `W` as a local time in `Z` gives `T` back. Two instants are possible only in the hour a daylight-saving clock repeats; the nonexistent hour cannot occur.
3. So the true value is a function of `(W, Z)`, and the stored hash is a function of the true value. Recomputing the hash with the candidate and comparing it with the stored hash is a **proof**, not a heuristic: a wrong zone or a wrong daylight-saving branch produces a different hash, and the row is left as it is.

## Proposal

**A pure planner, with no write path in the library.** Add `planOccurredAtRepair(records, { zones })` to `./shared` (zero dependencies; `Intl.DateTimeFormat` for the zone arithmetic). Input: a tenant's chained records as read from the store, and a list of candidate zones. Output, per record: `ok` (the hash already matches), `repairable` (zone, branch, corrected `occurredAt`; the recomputed hash equals the stored one) or `unproven` (no candidate matches, or the record has no hash). It changes nothing.

**Applying is the operator's act, with a privileged role.** Critical rule 2 (no UPDATE of posted records) and the README advice (revoke `UPDATE` from the application role) both rule out a write path in the library. The planner's output becomes a reviewable list of `UPDATE ... SET "occurredAt" = <corrected UTC wall-clock time> WHERE id = ... AND "hash" = <stored hash> AND "occurredAt" = <shifted value the planner read>` that a DBA runs in one transaction. Each guard covers one thing: `AND "hash"` stops the statement from acting on a row whose stored hash is not the planned one, and `AND "occurredAt"` makes it a no-op on a row whose `occurredAt` changed after planning (the stored hash does not change when only `occurredAt` is edited, so the hash guard alone does not see that edit).

**A dry run is the default and the only mode the library has.** Per tenant (the chain is per tenant). The operator supplies the list of zones: the session zones their connections used on 1.1.11 or earlier. More than one is allowed (a host that moved regions), and each row proves its own zone.

**The check that it worked is the library's own:** after the UPDATE, `verifyChain(tenant)` returns `valid: true`. A wrong guess leaves the chain invalid at exactly the rows that were not proven.

## What it fixes, and what it does not

It fixes the `occurredAt` of every chained usage record, so the `from`/`to` windows of the usage report, of the cost summary and of `verifyChain` ranges are right again for those rows.

It does not fix, and cannot prove by this method:

- Unchained records (the hash chain was off when they were written, or they were written before it was turned on): there is no hash to prove against. They stay shifted and come out as `unproven`.
- `createdAt`/`updatedAt` of records written before 1.1.8: no hash covers them. They could be derived with the offset a proven row of the same era shows, but deriving is not proving; the planner would only report them.
- Budget windows (`windowStart` and the spend counters), wallet entries (`effectiveAt`, `expiresAt`, and so grant expiry), price versions (`effectiveFrom`) and the `createdAt` of budgets: shifted by the same mechanism on 1.1.11 and earlier, and no hash covers them. The 1.1.12 notes already say they cannot be repaired. A repaired ledger lets `reconcileWindow` produce the correct spend for the windows that exist, but the old window rows, keyed by a shifted `windowStart`, remain.

So the wrong report windows are fixed for chained rows only; budgets and wallet expiry stay as the 1.1.12 notes describe them.

## Risks

- The zone arithmetic is the whole difficulty (the repeated daylight-saving hour, historical rule changes such as São Paulo's former daylight-saving time). The proof mitigates it: a planner bug can only produce `unproven` rows, never a wrong write, as long as the planner compares the whole recomputed hash.
- The chain is unkeyed: someone with write access can already recompute a chain (README, limit 2). The repair accepts only a value that reproduces the stored hash, so it grants nothing an attacker lacks.
- Order of application: the UPDATE writes an `occurredAt` that the stored hash already matches, and running it twice is a no-op, because the `occurredAt` guard no longer matches after the first run. Running it on a tenant that is still being written is safe, because the new rows (1.1.12) already verify and come out as `ok`.

## Cost and recommendation

One PR: the planner (about 150 lines with the zone arithmetic, an estimate), tests with real 1.1.11 rows (a fixture written by the v1.1.11 build, as in the measurement behind the README section) in Tokyo, São Paulo and a repeated-hour case, and a procedure in the README; the `shared` bundle has room in its size budget. The reach is narrow (Prisma 6 under a non-UTC session zone, on 1.1.11 or earlier, with the hash chain on). Recommendation: do not build it speculatively. Build it when a real host asks, because then the host also supplies the list of zones and the fixture.
