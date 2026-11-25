-- ---------------------------------------------------------------------------
-- Wallet entry order and the link of a refund to its debit: COLUMNS ONLY.
--
-- A refund that restores the grants a debit burned (a refund to its source) has to name the debit it restores, and a
-- statement of the wallet has to show the entries in the order they were committed with the balance each one left. The
-- entries were ordered by "createdAt", the database clock at the start of the transaction, with the random "id" as the
-- tie-break: two entries of one wallet that committed in one order could carry the opposite one. This migration adds the
-- columns; migration 0005 adds the indexes and the foreign key that go with them.
--
--   "ai_wallets"."entrySeq"                  the last sequence handed out in this wallet; the store increments it under the
--                                            wallet row lock in the statement that inserts the entry, so it is the commit order
--   "ai_wallet_entries"."seq"                the sequence of the entry in its wallet (NULL for an entry written before this
--                                            migration; those sort first, in the old order)
--   "ai_wallet_entries"."balanceAfterNanoUsd" the wallet balance as the store left it after the entry (NULL before this migration)
--   "ai_wallet_entries"."refundsEntryId"     the debit a refund restored to its source (NULL for every other entry)
--
-- Why this file holds nothing else: ADD COLUMN takes an ACCESS EXCLUSIVE lock on the table, which blocks reads as well as
-- writes, and the file runs as one implicit transaction. Each statement here is a metadata change (a column added with a
-- constant default, or none), so the lock is held for an instant. The indexes and the foreign key are in 0005, where the
-- locks they take block writes but not reads. There is no backfill: an old row keeps NULL and the order it always had.
--
-- Rollback (safe at any time once 0005 is rolled back first; the refund links and the sequence are lost):
--   ALTER TABLE "ai_wallet_entries" DROP COLUMN IF EXISTS "refundsEntryId";
--   ALTER TABLE "ai_wallet_entries" DROP COLUMN IF EXISTS "balanceAfterNanoUsd";
--   ALTER TABLE "ai_wallet_entries" DROP COLUMN IF EXISTS "seq";
--   ALTER TABLE "ai_wallets" DROP COLUMN IF EXISTS "entrySeq";
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_wallets" ADD COLUMN "entrySeq" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "ai_wallet_entries" ADD COLUMN "seq" BIGINT;
ALTER TABLE "ai_wallet_entries" ADD COLUMN "balanceAfterNanoUsd" BIGINT;
ALTER TABLE "ai_wallet_entries" ADD COLUMN "refundsEntryId" TEXT;
