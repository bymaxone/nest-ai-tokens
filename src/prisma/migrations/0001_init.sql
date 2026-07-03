-- @bymax-one/nest-ai-tokens — initial schema (spec §15.3).
-- Seven tables; all money is BIGINT nano-USD; every table carries "tenantId".
-- Apply with `prisma db execute --file` / `psql`, or let `prisma migrate` generate
-- the equivalent from `schema.prisma.fragment`. The two PARTIAL indexes at the end
-- cannot be expressed in the Prisma schema and are the reason for the shipped SQL.

-- ---------------------------------------------------------------------------
-- ai_usage_records — the immutable usage ledger (append-only).
-- ---------------------------------------------------------------------------
CREATE TABLE "ai_usage_records" (
  "id"                 TEXT NOT NULL,
  "tenantId"           TEXT NOT NULL,
  "scopeType"          TEXT NOT NULL,
  "scopeId"            TEXT NOT NULL,
  "beneficiaryType"    TEXT,
  "beneficiaryId"      TEXT,
  "requestedBy"        TEXT,
  "provider"           TEXT NOT NULL,
  "model"              TEXT NOT NULL,
  "requestedModel"     TEXT,
  "operation"          TEXT NOT NULL,
  "serviceTier"        TEXT NOT NULL DEFAULT 'standard',
  "feature"            TEXT NOT NULL,
  "tags"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "inputTokens"        INTEGER NOT NULL DEFAULT 0,
  "outputTokens"       INTEGER NOT NULL DEFAULT 0,
  "cacheReadTokens"    INTEGER NOT NULL DEFAULT 0,
  "cacheWrite5mTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWrite1hTokens" INTEGER NOT NULL DEFAULT 0,
  "reasoningTokens"    INTEGER NOT NULL DEFAULT 0,
  "audioInTokens"      INTEGER NOT NULL DEFAULT 0,
  "audioOutTokens"     INTEGER NOT NULL DEFAULT 0,
  "imageInTokens"      INTEGER NOT NULL DEFAULT 0,
  "imageOutTokens"     INTEGER NOT NULL DEFAULT 0,
  "totalTokens"        INTEGER NOT NULL,
  "extraUnits"         JSONB,
  "priceVersionId"     TEXT,
  "rawCostNanoUsd"     BIGINT NOT NULL,
  "surchargeNanoUsd"   BIGINT NOT NULL DEFAULT 0,
  "billedCostNanoUsd"  BIGINT NOT NULL,
  "markupMultiplier"   DECIMAL(10,4) NOT NULL,
  "currency"           TEXT NOT NULL DEFAULT 'USD',
  "priceMissing"       BOOLEAN NOT NULL DEFAULT false,
  "status"             TEXT NOT NULL DEFAULT 'posted',
  "reversedByRecordId" TEXT,
  "reversesRecordId"   TEXT,
  "idempotencyKey"     TEXT NOT NULL,
  "payloadHash"        TEXT NOT NULL,
  "correlationId"      TEXT,
  "requestId"          TEXT,
  "isSystemCost"       BOOLEAN NOT NULL DEFAULT false,
  "systemCostCategory" TEXT,
  "enforced"           BOOLEAN NOT NULL DEFAULT false,
  "prevHash"           TEXT,
  "hash"               TEXT,
  "occurredAt"         TIMESTAMP(3) NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_usage_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_usage_records_tenantId_idempotencyKey_key" ON "ai_usage_records" ("tenantId", "idempotencyKey");
CREATE INDEX "ai_usage_records_tenantId_occurredAt_idx" ON "ai_usage_records" ("tenantId", "occurredAt");
CREATE INDEX "ai_usage_records_tenantId_scopeType_scopeId_occurredAt_idx" ON "ai_usage_records" ("tenantId", "scopeType", "scopeId", "occurredAt");
CREATE INDEX "ai_usage_records_tenantId_feature_occurredAt_idx" ON "ai_usage_records" ("tenantId", "feature", "occurredAt");
CREATE INDEX "ai_usage_records_tenantId_provider_model_idx" ON "ai_usage_records" ("tenantId", "provider", "model");
CREATE INDEX "ai_usage_records_tenantId_systemCostCategory_idx" ON "ai_usage_records" ("tenantId", "systemCostCategory");
CREATE INDEX "ai_usage_records_tenantId_beneficiaryType_beneficiaryId_idx" ON "ai_usage_records" ("tenantId", "beneficiaryType", "beneficiaryId");
CREATE INDEX "ai_usage_records_priceVersionId_idx" ON "ai_usage_records" ("priceVersionId");
CREATE INDEX "ai_usage_records_status_createdAt_idx" ON "ai_usage_records" ("status", "createdAt");

-- ---------------------------------------------------------------------------
-- ai_model_prices — effective-dated price registry.
-- ---------------------------------------------------------------------------
CREATE TABLE "ai_model_prices" (
  "id"                            TEXT NOT NULL,
  "provider"                      TEXT NOT NULL,
  "model"                         TEXT NOT NULL,
  "operation"                     TEXT NOT NULL,
  "serviceTier"                   TEXT NOT NULL DEFAULT 'standard',
  "inputNanoUsdPerMillion"        BIGINT NOT NULL DEFAULT 0,
  "outputNanoUsdPerMillion"       BIGINT NOT NULL DEFAULT 0,
  "cacheReadNanoUsdPerMillion"    BIGINT NOT NULL DEFAULT 0,
  "cacheWrite5mNanoUsdPerMillion" BIGINT NOT NULL DEFAULT 0,
  "cacheWrite1hNanoUsdPerMillion" BIGINT NOT NULL DEFAULT 0,
  "reasoningNanoUsdPerMillion"    BIGINT NOT NULL DEFAULT 0,
  "audioInNanoUsdPerMillion"      BIGINT NOT NULL DEFAULT 0,
  "audioOutNanoUsdPerMillion"     BIGINT NOT NULL DEFAULT 0,
  "imageInNanoUsdPerMillion"      BIGINT NOT NULL DEFAULT 0,
  "imageOutNanoUsdPerMillion"     BIGINT NOT NULL DEFAULT 0,
  "tierThresholdTokens"           INTEGER,
  "tierInputNanoUsdPerMillion"    BIGINT,
  "tierOutputNanoUsdPerMillion"   BIGINT,
  "unitRates"                     JSONB,
  "currency"                      TEXT NOT NULL DEFAULT 'USD',
  "effectiveFrom"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo"                   TIMESTAMP(3),
  "source"                        TEXT NOT NULL DEFAULT 'snapshot',
  CONSTRAINT "ai_model_prices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_model_prices_provider_model_operation_serviceTier_effecti_idx" ON "ai_model_prices" ("provider", "model", "operation", "serviceTier", "effectiveFrom");

-- ---------------------------------------------------------------------------
-- ai_wallets + ai_wallet_entries + ai_wallet_debit_allocations (wallet feature).
-- ---------------------------------------------------------------------------
CREATE TABLE "ai_wallets" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "ownerType"      TEXT NOT NULL,
  "ownerId"        TEXT NOT NULL,
  "balanceNanoUsd" BIGINT NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_wallets_tenantId_ownerType_ownerId_key" ON "ai_wallets" ("tenantId", "ownerType", "ownerId");

CREATE TABLE "ai_wallet_entries" (
  "id"             TEXT NOT NULL,
  "walletId"       TEXT NOT NULL,
  "type"           TEXT NOT NULL,
  "amountNanoUsd"  BIGINT NOT NULL,
  "priority"       INTEGER NOT NULL DEFAULT 0,
  "effectiveAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"      TIMESTAMP(3),
  "usageRecordId"  TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "reason"         TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_wallet_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_wallet_entries_walletId_idempotencyKey_key" ON "ai_wallet_entries" ("walletId", "idempotencyKey");
CREATE INDEX "ai_wallet_entries_walletId_effectiveAt_idx" ON "ai_wallet_entries" ("walletId", "effectiveAt");
CREATE INDEX "ai_wallet_entries_walletId_type_expiresAt_idx" ON "ai_wallet_entries" ("walletId", "type", "expiresAt");

CREATE TABLE "ai_wallet_debit_allocations" (
  "id"            TEXT NOT NULL,
  "debitEntryId"  TEXT NOT NULL,
  "grantEntryId"  TEXT NOT NULL,
  "amountNanoUsd" BIGINT NOT NULL,
  CONSTRAINT "ai_wallet_debit_allocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_wallet_debit_allocations_grantEntryId_idx" ON "ai_wallet_debit_allocations" ("grantEntryId");
CREATE INDEX "ai_wallet_debit_allocations_debitEntryId_idx" ON "ai_wallet_debit_allocations" ("debitEntryId");

-- ---------------------------------------------------------------------------
-- ai_budgets + ai_budget_windows (budget feature).
-- ---------------------------------------------------------------------------
CREATE TABLE "ai_budgets" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "scopeType"      TEXT NOT NULL,
  "scopeId"        TEXT NOT NULL,
  "features"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "limitNanoUsd"   BIGINT,
  "limitTokens"    BIGINT,
  "limitCount"     INTEGER,
  "window"         TEXT NOT NULL,
  "anchorAt"       TIMESTAMP(3),
  "expiresAt"      TIMESTAMP(3),
  "softThresholds" JSONB NOT NULL,
  "policy"         TEXT NOT NULL DEFAULT 'block',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_budgets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_budgets_tenantId_scopeType_scopeId_idx" ON "ai_budgets" ("tenantId", "scopeType", "scopeId");

CREATE TABLE "ai_budget_windows" (
  "id"           TEXT NOT NULL,
  "budgetId"     TEXT NOT NULL,
  "windowStart"  TIMESTAMP(3) NOT NULL,
  "spentNanoUsd" BIGINT NOT NULL DEFAULT 0,
  "spentTokens"  BIGINT NOT NULL DEFAULT 0,
  "spentCount"   INTEGER NOT NULL DEFAULT 0,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_budget_windows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_budget_windows_budgetId_windowStart_key" ON "ai_budget_windows" ("budgetId", "windowStart");

-- Foreign keys for the wallet/budget relation graph.
ALTER TABLE "ai_wallet_entries" ADD CONSTRAINT "ai_wallet_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "ai_wallets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_wallet_debit_allocations" ADD CONSTRAINT "ai_wallet_debit_allocations_debitEntryId_fkey" FOREIGN KEY ("debitEntryId") REFERENCES "ai_wallet_entries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_wallet_debit_allocations" ADD CONSTRAINT "ai_wallet_debit_allocations_grantEntryId_fkey" FOREIGN KEY ("grantEntryId") REFERENCES "ai_wallet_entries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_budget_windows" ADD CONSTRAINT "ai_budget_windows_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "ai_budgets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PARTIAL indexes (PostgreSQL-only; not expressible in the Prisma schema).
-- ---------------------------------------------------------------------------
-- Exactly one OPEN price row per (provider, model, operation, serviceTier) — the
-- seed/upsert race guard that makes the effective-dated close-and-insert atomic.
CREATE UNIQUE INDEX "ai_model_prices_open_row_key"
  ON "ai_model_prices" ("provider", "model", "operation", "serviceTier")
  WHERE "effectiveTo" IS NULL;

-- Fast reaper scan over pending holds only.
CREATE INDEX "ai_usage_records_pending_createdAt_idx"
  ON "ai_usage_records" ("createdAt")
  WHERE "status" = 'pending';
