-- ---------------------------------------------------------------------------
-- ai_usage_effects_owed: the ledger rows whose effects have not run yet.
--
-- A transition of a usage row (a capture, a release) and the compensating append of a reversal commit before their
-- effects (the wallet legs and the budget legs) run. When the process dies between the two, nothing records that the
-- effects are owed. This table is that record: one row per ledger row, written by the same statement as the write it
-- belongs to and deleted once the effects have run, so a sweep can find the rows whose effects never ran.
--
--   "recordId"              the ledger row whose effects are owed (primary key, and the foreign key to the ledger)
--   "tenantId"              its tenant, so the sweep never needs the ledger row to scope what it moves
--   "owedAt"                when the write that owes the effects committed (the database clock)
--   "reservedBilledNanoUsd" the billed amount a hold reserved, kept by a capture because the settled row carries the
--                           actuals and the outstanding deltas are the difference; NULL for any other write
--   "reservedTokens"        the reserved token count, kept for the same reason
--
-- The marker lives beside the ledger and not in it, so the ledger table gains no column and no mutable value: the
-- only change a posted row ever takes is still the annotation of its reversal. Additive: it creates one table, one
-- index and one foreign key, and touches no existing table. Rows written before this migration owe nothing.
--
-- Rollback (safe at any time; the effects owed at that moment stay unfinished until they are redone by hand):
--   DROP TABLE IF EXISTS "ai_usage_effects_owed";
-- ---------------------------------------------------------------------------
CREATE TABLE "ai_usage_effects_owed" (
  "recordId"              TEXT NOT NULL,
  "tenantId"              TEXT NOT NULL,
  "owedAt"                TIMESTAMP(3) NOT NULL,
  "reservedBilledNanoUsd" BIGINT,
  "reservedTokens"        INTEGER,
  CONSTRAINT "ai_usage_effects_owed_pkey" PRIMARY KEY ("recordId"),
  CONSTRAINT "ai_usage_effects_owed_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "ai_usage_records" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The sweep reads the oldest markers first.
CREATE INDEX "ai_usage_effects_owed_owedAt_idx" ON "ai_usage_effects_owed" ("owedAt");
