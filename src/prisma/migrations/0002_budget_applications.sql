-- ---------------------------------------------------------------------------
-- ai_budget_applications: one row per budget movement that must happen once.
--
-- A movement of a budget window (a consume, a capture settlement, a release, a reversal) is
-- keyed by what caused it, so that running it again moves nothing. The key and the budget form
-- the primary key, which is what makes the insert the single point where concurrent attempts
-- are serialized. The row keeps the delta and the window it moved, so that giving the
-- movement back (a compensation) needs no arguments and releases the very window it consumed;
-- "unappliedAt" marks it given back and lets the same key be applied again.
--
-- Additive: it creates one table and one foreign key and touches no existing table.
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

ALTER TABLE "ai_budget_applications" ADD CONSTRAINT "ai_budget_applications_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "ai_budgets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
