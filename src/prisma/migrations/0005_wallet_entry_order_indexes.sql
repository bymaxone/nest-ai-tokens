-- ---------------------------------------------------------------------------
-- Wallet entry order and refund link: INDEXES AND FOREIGN KEY (the columns are in 0004).
--
--   "ai_wallet_entries_refundsEntryId_fkey"   a refund's "refundsEntryId" must be an entry (ON DELETE RESTRICT: a debit a
--                                             refund points at cannot be deleted)
--   "ai_wallet_entries_walletId_seq_key"      the sequence is unique inside a wallet; partial, so the rows written before
--                                             0004 (NULL) are outside it
--   "ai_wallet_entries_order_idx"             serves the statement order, ascending and descending: (walletId, seq NULLS
--                                             FIRST, createdAt, id), so a page of either direction reads the index
--   "ai_wallet_entries_refundsEntryId_idx"    a full index, because the foreign-key rule of this repo refuses a partial one: the lookup of the refunds a debit already has
--
-- Locking: CREATE INDEX (without CONCURRENTLY, which cannot run in the implicit transaction of this file) blocks writes to
-- the table for its duration, and does not block reads; ADD CONSTRAINT ... FOREIGN KEY validates the existing rows under a
-- SHARE ROW EXCLUSIVE lock, which also blocks writes and not reads. Apply it in a quiet period on a large table, or create
-- the three indexes by hand with CONCURRENTLY under other names and skip them here.
--
-- Rollback (safe at any time):
--   DROP INDEX IF EXISTS "ai_wallet_entries_refundsEntryId_idx";
--   DROP INDEX IF EXISTS "ai_wallet_entries_order_idx";
--   DROP INDEX IF EXISTS "ai_wallet_entries_walletId_seq_key";
--   ALTER TABLE "ai_wallet_entries" DROP CONSTRAINT IF EXISTS "ai_wallet_entries_refundsEntryId_fkey";
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_wallet_entries" ADD CONSTRAINT "ai_wallet_entries_refundsEntryId_fkey" FOREIGN KEY ("refundsEntryId") REFERENCES "ai_wallet_entries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ai_wallet_entries_walletId_seq_key" ON "ai_wallet_entries" ("walletId", "seq") WHERE "seq" IS NOT NULL;
CREATE INDEX "ai_wallet_entries_order_idx" ON "ai_wallet_entries" ("walletId", "seq" NULLS FIRST, "createdAt", "id");
CREATE INDEX "ai_wallet_entries_refundsEntryId_idx" ON "ai_wallet_entries" ("refundsEntryId");
