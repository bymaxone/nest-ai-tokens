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

import type { NewWalletEntry, WalletEntry, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import type { IWalletStore } from '@bymax-one/nest-ai-tokens'

/** A store under test plus the store-specific hooks the contract needs. */
export interface WalletContractStore {
  store: IWalletStore
  /** Force the materialized balance to a wrong value to prove `reconcile` repairs it. */
  skew(ref: WalletRef, value: bigint): Promise<void>
  /** The store's own clock: the instant it stamps and compares against. */
  now(): Promise<Date>
  /** Move the store's clock forward by at least `ms` (an injected clock jumps; a database clock is waited out). */
  advance(ms: number): Promise<void>
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

    /** Entries of one type, by idempotency-key prefix, in append order. */
    async function entriesWithKey(store: IWalletStore, type: WalletEntry['type'], prefix: string): Promise<WalletEntry[]> {
      const page = await store.listEntries(ref, { type })
      return page.entries.filter((entry) => entry.idempotencyKey.startsWith(prefix))
    }

    /** A grant whose effectiveAt is `afterMs` after the store's own clock. */
    async function grantDueIn(c: WalletContractStore, key: string, amountNanoUsd: bigint, afterMs: number, over: Partial<NewWalletEntry> = {}): Promise<void> {
      const at = new Date((await c.now()).getTime() + afterMs)
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: key, amountNanoUsd, effectiveAt: at, ...over }))
    }

    /** Credit follows the grant's effective time: not before it, and without any later grant call, from it. */
    it('credits a grant at its effectiveAt and not before', async () => {
      const c = await make()
      await grantDueIn(c, 'soon', 40n, 2_000)
      await grantDueIn(c, 'later', 60n, 4_000)
      expect(await c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'early' }), 0n)).toBeNull()
      await c.advance(2_500)
      expect(await c.store.conditionalDebit(ref, debitEntry(50n, { idempotencyKey: 'too-much' }), 0n)).toBeNull()
      expect(await c.store.conditionalDebit(ref, debitEntry(40n, { idempotencyKey: 'first' }), 0n)).not.toBeNull()
      await c.advance(2_000)
      expect(await c.store.conditionalDebit(ref, debitEntry(60n, { idempotencyKey: 'second' }), 0n)).not.toBeNull()
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(0n)
    })

    /** A grant stamped a moment ahead of the store's clock is spendable once that clock reaches it, not never. */
    it('makes a grant that is a moment ahead of the store clock spendable once the clock reaches it', async () => {
      const c = await make()
      await grantDueIn(c, 'ahead', 100n, 1_500)
      expect(await c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'now' }), 0n)).toBeNull()
      await c.advance(2_000)
      expect(await c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'then' }), 0n)).not.toBeNull()
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(90n)
    })

    /** A grant that is due when it is appended is credited then, once, and needs no later activation. */
    it('credits a grant that is due at append once, without an activation entry', async () => {
      const c = await make()
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'due', amountNanoUsd: 100n }))
      await c.store.conditionalDebit(ref, debitEntry(30n, { idempotencyKey: 'd1' }), 0n)
      await c.store.conditionalDebit(ref, debitEntry(20n, { idempotencyKey: 'd2' }), 0n)
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(50n)
      expect(await entriesWithKey(c.store, 'adjustment', 'activate:')).toHaveLength(0)
    })

    /** A grant credited late expires like any other: one expiry entry, and its remainder leaves the balance. */
    it('expires a grant that was credited late', async () => {
      const c = await make()
      const now = await c.now()
      await c.store.appendEntry(
        ref,
        grantEntry({ idempotencyKey: 'brief', amountNanoUsd: 100n, effectiveAt: new Date(now.getTime() + 1_500), expiresAt: new Date(now.getTime() + 4_500) }),
      )
      await c.advance(2_000)
      expect(await c.store.conditionalDebit(ref, debitEntry(30n, { idempotencyKey: 'in-window' }), 0n)).not.toBeNull()
      await c.advance(3_000)
      expect(await c.store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: 'after-expiry' }), 0n)).toBeNull()
      const expiries = await entriesWithKey(c.store, 'expiry', 'expiry:')
      expect(expiries).toHaveLength(1)
      expect(expiries[0]?.amountNanoUsd).toBe(-70n)
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(0n)
    })

    /** A grant that lapses before it ever became due is never credited, so nothing is activated or expired for it. */
    it('never credits a grant that expired before it was due to be used', async () => {
      const c = await make()
      const now = await c.now()
      await c.store.appendEntry(
        ref,
        grantEntry({ idempotencyKey: 'missed', amountNanoUsd: 100n, effectiveAt: new Date(now.getTime() + 1_000), expiresAt: new Date(now.getTime() + 1_500) }),
      )
      await c.advance(2_500)
      expect(await c.store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: 'late' }), 0n)).toBeNull()
      expect(await entriesWithKey(c.store, 'adjustment', 'activate:')).toHaveLength(0)
      expect(await entriesWithKey(c.store, 'expiry', 'expiry:')).toHaveLength(0)
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(0n)
    })

    /** A due grant that nothing has credited yet is credited exactly once, however many debits race for it. */
    it('credits a due grant exactly once when debits race', async () => {
      const c = await make()
      await grantDueIn(c, 'due-later', 100n, 1_500)
      await c.advance(2_000)
      const [a, b] = await Promise.all([
        c.store.conditionalDebit(ref, debitEntry(40n, { idempotencyKey: 'r-a' }), 0n),
        c.store.conditionalDebit(ref, debitEntry(40n, { idempotencyKey: 'r-b' }), 0n),
      ])
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      expect(await entriesWithKey(c.store, 'adjustment', 'activate:')).toHaveLength(1)
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(20n)
    })

    /** After activation the two ways of computing a balance agree: the debit path and `reconcile`. */
    it('agrees with reconcile after the debit path has credited a late grant', async () => {
      const c = await make()
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'base', amountNanoUsd: 50n }))
      await grantDueIn(c, 'late', 100n, 1_500)
      await c.advance(2_000)
      await c.store.conditionalDebit(ref, debitEntry(70n, { idempotencyKey: 'spend' }), 0n)
      const lazy = (await c.store.getWallet(ref))?.balanceNanoUsd
      const reconciled = await c.store.reconcile(ref)
      expect(lazy).toBe(80n)
      expect(reconciled.balanceNanoUsd).toBe(80n)
      expect(await entriesWithKey(c.store, 'adjustment', 'activate:')).toHaveLength(1)
    })

    /** Reconcile on its own credits a due grant the same way, once, and a later debit does not credit it again. */
    it('credits a due grant once whether reconcile or a debit gets there first', async () => {
      const c = await make()
      await grantDueIn(c, 'late', 100n, 1_500)
      await c.advance(2_000)
      expect((await c.store.reconcile(ref)).balanceNanoUsd).toBe(100n)
      expect(await c.store.conditionalDebit(ref, debitEntry(25n, { idempotencyKey: 'after' }), 0n)).not.toBeNull()
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(75n)
      expect(await entriesWithKey(c.store, 'adjustment', 'activate:')).toHaveLength(1)
    })

    /**
     * A stored balance written by an earlier reconcile can already count a grant that is credited late. The
     * debit that credits it must leave the balance at the sum of the entries, not add the grant a second time.
     */
    it('does not credit a grant twice when the stored balance already counts it', async () => {
      const c = await make()
      await grantDueIn(c, 'late', 100n, 1_500)
      await c.advance(2_000)
      await c.skew(ref, 100n)
      expect(await c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'once' }), 0n)).not.toBeNull()
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(90n)
      expect(await entriesWithKey(c.store, 'adjustment', 'activate:')).toHaveLength(1)
    })

    /** A stored balance that has drifted to some other value is re-derived from the ledger by the next activation. */
    it('corrects a drifted stored balance when a grant is credited', async () => {
      const c = await make()
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'base', amountNanoUsd: 50n }))
      await grantDueIn(c, 'late', 100n, 1_500)
      await c.advance(2_000)
      await c.skew(ref, 12_345n)
      expect(await c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'repair' }), 0n)).not.toBeNull()
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(140n)
    })

    /** The key `activate:<grantId>` belongs to the store: a caller's entry cannot use it, as a refund or as a debit. */
    it('rejects a caller entry whose key is in the activation namespace', async () => {
      const c = await make()
      const grant = await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g', amountNanoUsd: 100n }))
      const reserved = { response: { error: { code: 'AI_TOKENS_INVALID_CONFIG' } } }

      await expect(c.store.appendEntry(ref, { ...debitEntry(1n, { idempotencyKey: `activate:${grant.id}` }), type: 'refund', amountNanoUsd: 1n })).rejects.toMatchObject(reserved)
      await expect(c.store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: `activate:${grant.id}` }), 0n)).rejects.toMatchObject(reserved)
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(100n)
    })

    /** A caller that tried the activation key of a scheduled grant does not stop the store from crediting it. */
    it('still credits a scheduled grant after a caller tried its activation key', async () => {
      const c = await make()
      const at = new Date((await c.now()).getTime() + 1_500)
      const scheduled = await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'sched', amountNanoUsd: 100n, effectiveAt: at }))
      await expect(
        c.store.appendEntry(ref, { ...debitEntry(1n, { idempotencyKey: `activate:${scheduled.id}` }), type: 'refund', amountNanoUsd: 1n }),
      ).rejects.toBeDefined()
      await c.advance(2_000)

      expect(await c.store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: 'after' }), 0n)).not.toBeNull()
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(99n)
      const markers = await entriesWithKey(c.store, 'adjustment', 'activate:')
      expect(markers.map((m) => m.reason)).toEqual(['grant activated'])
    })

    /** A due grant that is not credited yet is not open; once a debit credits it, it burns in order with an exact trail. */
    it('burns a late-credited grant in order and keeps the allocation trail exact', async () => {
      const c = await make()
      const now = await c.now()
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'soon', amountNanoUsd: 30n, expiresAt: new Date(now.getTime() + 3_600_000) }))
      await c.store.appendEntry(
        ref,
        grantEntry({ idempotencyKey: 'late', amountNanoUsd: 30n, effectiveAt: new Date(now.getTime() + 1_500), expiresAt: new Date(now.getTime() + 7_200_000) }),
      )
      await c.advance(2_000)
      expect((await c.store.openGrants(ref, 'expiry')).map((g) => g.idempotencyKey)).toEqual(['soon'])
      const debit = await c.store.conditionalDebit(ref, debitEntry(40n, { idempotencyKey: 'span' }), 0n)
      expect(debit).not.toBeNull()
      const open = await c.store.openGrants(ref, 'expiry')
      expect(open.map((g) => [g.idempotencyKey, g.remainingNanoUsd])).toEqual([['late', 20n]])
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(20n)
    })

    /** Two debits sweeping the same expired grant at once both succeed and write its expiry entry once. */
    it('sweeps an expired grant once when debits race', async () => {
      const c = await make()
      const now = await c.now()
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'old', amountNanoUsd: 60n, effectiveAt: new Date(now.getTime() - 60_000), expiresAt: new Date(now.getTime() + 1_500) }))
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'fresh', amountNanoUsd: 100n }))
      await c.advance(2_000)
      const [a, b] = await Promise.all([
        c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 's-a' }), 0n),
        c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 's-b' }), 0n),
      ])
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      expect(await entriesWithKey(c.store, 'expiry', 'expiry:')).toHaveLength(1)
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(80n)
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
