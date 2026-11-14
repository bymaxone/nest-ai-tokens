-- ---------------------------------------------------------------------------
-- ai_budget_applications: one row per budget movement that must happen once.
-- ai_budget_references:   one row per attempt that holds a movement.
--
-- A movement of a budget window (a consume, a capture settlement, a release, a reversal) is
-- keyed by what caused it, so that running it again moves nothing. The key and the budget form
-- the primary key of the application, which is what makes the insert the single point where
-- concurrent attempts are serialized. The row keeps the delta and the window it moved, so that
-- giving the movement back needs no arguments and releases the very window it consumed;
-- "unappliedAt" marks it given back and lets the same key be applied again.
--
-- Every attempt that applies or replays a movement takes one reference, named by the attempt;
-- the reference of the call whose ledger row stands is renamed "row". An attempt that fails
-- drops only its own reference, and the movement is given back when its last reference goes.
--
-- Additive: it creates two tables, one index and two foreign keys and touches no existing table.
-- ---------------------------------------------------------------------------
CREATE TABLE "ai_budget_applications" (
  "key"          TEXT NOT NULL,
  "budgetId"     TEXT NOT NULL,
  "windowStart"  TIMESTAMP(3) NOT NULL,
  "spentNanoUsd" BIGINT NOT NULL,
  "spentTokens"  BIGINT NOT NULL,
  "spentCount"   INTEGER NOT NULL,
  "unappliedAt"  TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_budget_applications_pkey" PRIMARY KEY ("key", "budgetId")
);

CREATE TABLE "ai_budget_references" (
  "key"       TEXT NOT NULL,
  "budgetId"  TEXT NOT NULL,
  "attempt"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_budget_references_pkey" PRIMARY KEY ("key", "budgetId", "attempt")
);

-- The foreign key's column leads an index, so that deleting a budget finds its applications without scanning the table.
CREATE INDEX "ai_budget_applications_budgetId_idx" ON "ai_budget_applications" ("budgetId");

ALTER TABLE "ai_budget_applications" ADD CONSTRAINT "ai_budget_applications_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "ai_budgets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_budget_references" ADD CONSTRAINT "ai_budget_references_key_budgetId_fkey" FOREIGN KEY ("key", "budgetId") REFERENCES "ai_budget_applications" ("key", "budgetId") ON DELETE CASCADE ON UPDATE CASCADE;
