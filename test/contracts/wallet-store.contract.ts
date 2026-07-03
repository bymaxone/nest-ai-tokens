/**
 * @fileoverview The store-agnostic wallet contract suite (spec §9.4/§9.5, §15.2).
 * `runWalletStoreContract` proves that ANY {@link IWalletStore} moves money
 * race-safely: two concurrent debits with headroom for one leave exactly one
 * winner, the overdraft boundary is honored to the nano-USD, a debit replay is
 * idempotent, a key reused with a different payload conflicts, and `reconcile`
 * repairs a skewed materialized balance. It runs against the in-memory fake here
 * and, unchanged, against Testcontainers PostgreSQL in the Prisma e2e — the same
 * assertions on both stores are the phase's atomicity proof.
 * @layer test
 */

import type { NewWalletEntry, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import type { IWalletStore } from '@bymax-one/nest-ai-tokens'

/** A store under test plus a store-specific skew hook for the reconcile-repair case. */
export interface WalletContractStore {
  store: IWalletStore
  /** Force the materialized balance to a wrong value to prove `reconcile` repairs it. */
  skew(ref: WalletRef, value: bigint): Promise<void>
}

/** Build a grant entry for a wallet contract test. */
export function grantEntry(over: Partial<NewWalletEntry> & Pick<NewWalletEntry, 'idempotencyKey'>): NewWalletEntry {
  return {
    walletId: '',
    type: 'grant',
    amountNanoUsd: 100n,
    priority: 0,
    effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
    reason: 'grant',
    ...over,
  }
}

/** Build a debit entry (negative amount) for a wallet contract test. */
export function debitEntry(
  amountNanoUsd: bigint,
  over: Partial<NewWalletEntry> & Pick<NewWalletEntry, 'idempotencyKey'>,
): NewWalletEntry {
  return {
    walletId: '',
    type: 'debit',
    amountNanoUsd: -amountNanoUsd,
    priority: 0,
    effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
    reason: 'debit',
    ...over,
  }
}

/**
 * Register the shared wallet-store contract against a store factory.
 *
 * @param label A human-readable store name for the describe block.
 * @param make Produces a fresh store (+ skew hook) per test.
 */
export function runWalletStoreContract(label: string, make: () => Promise<WalletContractStore> | WalletContractStore): void {
  const ref: WalletRef = { tenantId: 'wallet-contract', ownerType: 'user', ownerId: 'u1' }

  describe(`IWalletStore contract — ${label}`, () => {
    /** Two concurrent debits against a balance with headroom for one: exactly one wins. */
    it('lets exactly one of two concurrent debits win', async () => {
      const { store } = await make()
      await store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
      const [a, b] = await Promise.all([
        store.conditionalDebit(ref, debitEntry(80n, { idempotencyKey: 'd-a' }), 0n),
        store.conditionalDebit(ref, debitEntry(80n, { idempotencyKey: 'd-b' }), 0n),
      ])
      expect([a, b].filter((entry) => entry === null)).toHaveLength(1)
      const wallet = await store.getWallet(ref)
      expect(wallet?.balanceNanoUsd).toBe(20n)
    })

    /** The overdraft boundary is exact: the balance may reach `-overdraft`, never below. */
    it('honors the overdraft boundary to the nano-USD', async () => {
      const { store } = await make()
      await store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
      const tooFar = await store.conditionalDebit(ref, debitEntry(151n, { idempotencyKey: 'over' }), 50n)
      expect(tooFar).toBeNull()
      const exact = await store.conditionalDebit(ref, debitEntry(150n, { idempotencyKey: 'edge' }), 50n)
      expect(exact).not.toBeNull()
      const wallet = await store.getWallet(ref)
      expect(wallet?.balanceNanoUsd).toBe(-50n)
      const beyond = await store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: 'beyond' }), 50n)
      expect(beyond).toBeNull()
    })

    /** A debit replay with a matching payload returns the stored entry and never double-charges. */
    it('replays a debit idempotently', async () => {
      const { store } = await make()
      await store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
      const first = await store.conditionalDebit(ref, debitEntry(30n, { idempotencyKey: 'd1' }), 0n)
      const replay = await store.conditionalDebit(ref, debitEntry(30n, { idempotencyKey: 'd1' }), 0n)
      expect(replay?.id).toBe(first?.id)
      const wallet = await store.getWallet(ref)
      expect(wallet?.balanceNanoUsd).toBe(70n)
    })

    /** A debit key reused with a different payload is a conflict, not a silent replay. */
    it('conflicts on a debit key reuse with a different payload', async () => {
      const { store } = await make()
      await store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
      await store.conditionalDebit(ref, debitEntry(30n, { idempotencyKey: 'd1' }), 0n)
      await expect(
        store.conditionalDebit(ref, debitEntry(40n, { idempotencyKey: 'd1' }), 0n),
      ).rejects.toMatchObject({ isAiTokensLedgerConflict: true })
    })

    /**
     * A grant that is not spendable at its PERSISTED append instant — future-effective or
     * born already expired — contributes nothing to the materialized balance, while a
     * normal grant contributes in full. The decision keys off the append instant (the
     * stored `createdAt` / `CURRENT_TIMESTAMP`), so it is identical and deterministic on
     * every store regardless of the read-time clock.
     */
    it('excludes a future-effective or born-expired grant from the materialized balance', async () => {
      const { store } = await make()
      await store.appendEntry(
        ref,
        grantEntry({ idempotencyKey: 'future', amountNanoUsd: 500n, effectiveAt: new Date('2999-01-01T00:00:00.000Z') }),
      )
      await store.appendEntry(
        ref,
        grantEntry({
          idempotencyKey: 'born-expired',
          amountNanoUsd: 500n,
          effectiveAt: new Date('2000-01-01T00:00:00.000Z'),
          expiresAt: new Date('2000-02-01T00:00:00.000Z'),
        }),
      )
      expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(0n) // neither grant is spendable at append
      await store.appendEntry(ref, grantEntry({ idempotencyKey: 'live', amountNanoUsd: 100n }))
      expect((await store.getWallet(ref))?.balanceNanoUsd).toBe(100n) // only the spendable grant counts
    })

    /** `reconcile` recomputes and repairs a materialized balance skewed out of band. */
    it('reconciles a skewed materialized balance', async () => {
      const { store, skew } = await make()
      await store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
      await store.conditionalDebit(ref, debitEntry(30n, { idempotencyKey: 'd1' }), 0n)
      await skew(ref, 999_999n)
      const before = await store.getWallet(ref)
      expect(before?.balanceNanoUsd).toBe(999_999n)
      const reconciled = await store.reconcile(ref)
      expect(reconciled.balanceNanoUsd).toBe(70n)
    })
  })
}
