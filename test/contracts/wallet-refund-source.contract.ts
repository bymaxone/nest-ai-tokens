/**
 * @fileoverview The refund-to-source part of the wallet-store contract: the cases that prove a refund restores the grants a debit burned, on any
 * {@link IWalletStore}. `runWalletStoreContract` registers them inside its own describe block, so the in-memory fake and the Testcontainers
 * PostgreSQL e2e run the same cases under the same names.
 * @layer test
 */

import type { NewWalletEntry, WalletEntry, WalletRef } from '@bymax-one/nest-ai-tokens/shared'
import type { IWalletStore } from '@bymax-one/nest-ai-tokens'
import { debitEntry, grantEntry, type WalletContractStore } from './wallet-store.contract'

/** What the refund-to-source cases share with the contract that registers them. */
export interface RefundSourceContext {
  ref: WalletRef
  make: () => Promise<WalletContractStore> | WalletContractStore
  /** The code of the typed error a store call rejects with, or the name of what it threw. */
  codeOf: (call: Promise<unknown>) => Promise<string>
  refundOf: (amount: bigint, over: Partial<NewWalletEntry> & Pick<NewWalletEntry, 'idempotencyKey'>) => NewWalletEntry
  remainingOf: (store: IWalletStore, now: Date) => Promise<Record<string, bigint>>
}

/** Register the refund-to-source cases in the describe block that is open. */
export function runRefundToSourceContract({ ref, make, codeOf, refundOf, remainingOf }: RefundSourceContext): void {
  describe('refund to source', () => {
    /** Two grants, a debit of 150 that burns g1 (100) and g2 (50); the debit and the clock are handed back. */
    const burned = async (): Promise<{ c: WalletContractStore; debit: WalletEntry; now: Date }> => {
      const c = await make()
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n, expiresAt: new Date('2099-01-01T00:00:00.000Z') }))
      await c.advance(5)
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g2', amountNanoUsd: 100n, expiresAt: new Date('2099-06-01T00:00:00.000Z') }))
      const debit = (await c.store.conditionalDebit(ref, debitEntry(150n, { idempotencyKey: 'host-debit', usageRecordId: 'u-1' }), 0n))!
      return { c, debit, now: await c.now() }
    }

    /** A debit written with several allocation rows on one grant is restored by that grant's total, so partial refunds sum to the debit and the last is accepted. */
    describe('a debit whose allocations repeat a grant', () => {
      const written = async (rows: readonly (readonly [string, bigint])[]): Promise<{ c: WalletContractStore; debit: WalletEntry }> => {
        const c = await make()
        const ids: Record<string, string> = {}
        for (const key of ['g1', 'g2']) {
          ids[key] = (await c.store.appendEntry(ref, grantEntry({ idempotencyKey: key, amountNanoUsd: 100n, expiresAt: new Date('2099-01-01T00:00:00.000Z') }))).id
          await c.advance(5)
        }
        const total = rows.reduce((sum, [, amount]) => sum + amount, 0n)
        const debit = await c.store.appendEntry(ref, debitEntry(total, { idempotencyKey: 'host-debit', usageRecordId: 'u-1' }), rows.map(([key, amount]) => ({ grantEntryId: ids[key] as string, amountNanoUsd: amount })))
        return { c, debit }
      }

      it('restores two rows of 50 on one grant by refunds of 60 and 40', async () => {
        const { c, debit } = await written([['g1', 50n], ['g1', 50n]])
        const now = await c.now()
        await c.store.refundToSource!(ref, { entry: refundOf(60n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
        expect(await remainingOf(c.store, now)).toEqual({ g1: 60n, g2: 100n })
        const rest = await c.store.refundToSource!(ref, { entry: refundOf(40n, { idempotencyKey: 'r2', usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
        expect(rest.amountNanoUsd).toBe(40n)
        expect(await remainingOf(c.store, now)).toEqual({ g1: 100n, g2: 100n })
        expect(await c.store.balanceAt!(ref, now)).toBe(200n)
      })

      it('restores three rows of 30, 30 and 40 on one grant by refunds of 25, 25 and 50', async () => {
        const { c, debit } = await written([['g1', 30n], ['g1', 30n], ['g1', 40n]])
        const now = await c.now()
        for (const [key, amount] of [['a', 25n], ['b', 25n], ['c', 50n]] as const) {
          await c.store.refundToSource!(ref, { entry: refundOf(amount, { idempotencyKey: key, usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
        }
        expect(await remainingOf(c.store, now)).toEqual({ g1: 100n, g2: 100n })
        expect(await c.store.balanceAt!(ref, now)).toBe(200n)
      })

      it('restores rows of 70 and 30 on one grant and 50 on another, in proportion to what each grant burned', async () => {
        const { c, debit } = await written([['g1', 70n], ['g1', 30n], ['g2', 50n]])
        const now = await c.now()
        await c.store.refundToSource!(ref, { entry: refundOf(90n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
        expect(await remainingOf(c.store, now)).toEqual({ g1: 60n, g2: 80n })
        expect(await c.store.balanceAt!(ref, now)).toBe(140n)
        await c.store.refundToSource!(ref, { entry: refundOf(60n, { idempotencyKey: 'r2', usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
        expect(await remainingOf(c.store, now)).toEqual({ g1: 100n, g2: 100n })
        const breakdown = await c.store.balanceBreakdown!(ref, now)
        expect(breakdown.nanoUsd).toBe(200n)
      })
    })

    /** The refund restores what the debit burned, in proportion to what each grant gave; no grant is created and nothing posted is touched. */
    it('puts the refund back on the grants the debit burned, in proportion, and creates no grant', async () => {
      const { c, debit, now } = await burned()
      expect(await remainingOf(c.store, now)).toEqual({ g2: 50n })
      const refund = await c.store.refundToSource!(ref, { entry: refundOf(90n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
      expect(refund.refundsEntryId).toBe(debit.id)
      expect(await remainingOf(c.store, now)).toEqual({ g1: 60n, g2: 80n })
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(140n)
      const entries = (await c.store.listEntries(ref)).entries
      expect(entries.filter((entry) => entry.type === 'grant')).toHaveLength(2)
      expect(entries.find((entry) => entry.id === debit.id)?.amountNanoUsd).toBe(-150n)
    })

    /** The debit is found by `usageRecordId` when no id is given; the last refund fills every grant exactly. */
    it('finds the debit by usageRecordId and fills every grant exactly with the last refund', async () => {
      const { c, now } = await burned()
      await c.store.refundToSource!(ref, { entry: refundOf(90n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), now })
      await c.store.refundToSource!(ref, { entry: refundOf(60n, { idempotencyKey: 'r2', usageRecordId: 'u-1' }), now })
      expect(await remainingOf(c.store, now)).toEqual({ g1: 100n, g2: 100n })
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(200n)
      expect(await codeOf(c.store.refundToSource!(ref, { entry: refundOf(1n, { idempotencyKey: 'r3', usageRecordId: 'u-1' }), now }))).toBe('AI_TOKENS_INVALID_CONFIG')
    })

    /** A refund above what is left of the debit is refused and writes nothing. */
    it('refuses a refund above what the debit has left', async () => {
      const { c, debit, now } = await burned()
      expect(await codeOf(c.store.refundToSource!(ref, { entry: refundOf(151n, { idempotencyKey: 'big', usageRecordId: 'u-1' }), debitEntryId: debit.id, now }))).toBe('AI_TOKENS_INVALID_CONFIG')
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(50n)
    })

    /** A debit the library wrote itself (hold:/record:) is refused: its credits are unlinked, so no cap could see them. */
    it.each(['hold:call-1', 'record:call-1'])('refuses a source refund of the library debit %s', async (key) => {
      const c = await make()
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
      const debit = (await c.store.conditionalDebit(ref, debitEntry(40n, { idempotencyKey: key }), 0n))!
      expect(await codeOf(c.store.refundToSource!(ref, { entry: refundOf(10n, { idempotencyKey: 'r1' }), debitEntryId: debit.id, now: await c.now() }))).toBe('AI_TOKENS_INVALID_CONFIG')
    })

    /** Unlinked credits with the same usageRecordId count against the cap: an unallocated refund first, then a source refund of the full amount. */
    it('counts an unlinked refund with the same usageRecordId against the cap', async () => {
      const { c, debit, now } = await burned()
      await c.store.appendEntry(ref, refundOf(100n, { idempotencyKey: 'plain', usageRecordId: 'u-1' }))
      expect(await codeOf(c.store.refundToSource!(ref, { entry: refundOf(150n, { idempotencyKey: 'full', usageRecordId: 'u-1' }), debitEntryId: debit.id, now }))).toBe('AI_TOKENS_INVALID_CONFIG')
      const ok = await c.store.refundToSource!(ref, { entry: refundOf(50n, { idempotencyKey: 'rest', usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
      expect(ok.amountNanoUsd).toBe(50n)
    })

    /** A debit that overdrew has an unfunded part: it comes back unallocated, and the funded grants are not over-restored. */
    it('credits the unfunded part of an overdrawn debit unallocated', async () => {
      const c = await make()
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
      const debit = (await c.store.conditionalDebit(ref, debitEntry(150n, { idempotencyKey: 'over', usageRecordId: 'u-1' }), 50n))!
      const now = await c.now()
      await c.store.refundToSource!(ref, { entry: refundOf(150n, { idempotencyKey: 'all', usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
      expect(await remainingOf(c.store, now)).toEqual({ g1: 100n })
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(100n)
    })

    /** A retry returns the stored refund; another amount on the key conflicts; and a plain refund reusing the key of a source refund conflicts too, and the other way round. */
    it('replays, and conflicts on a changed payload or a changed mode in either direction', async () => {
      const { c, debit, now } = await burned()
      const first = await c.store.refundToSource!(ref, { entry: refundOf(30n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), debitEntryId: debit.id, now })
      const again = await c.store.refundToSource!(ref, { entry: refundOf(30n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), now })
      expect(again.id).toBe(first.id)
      expect((await c.store.getWallet(ref))?.balanceNanoUsd).toBe(80n)
      expect(await codeOf(c.store.refundToSource!(ref, { entry: refundOf(31n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), now }))).toBe('CONFLICT')
      expect(await codeOf(c.store.appendEntry(ref, refundOf(30n, { idempotencyKey: 'r1', usageRecordId: 'u-1' })))).toBe('CONFLICT')
      await c.store.appendEntry(ref, refundOf(5n, { idempotencyKey: 'plain', usageRecordId: 'u-1' }))
      expect(await codeOf(c.store.refundToSource!(ref, { entry: refundOf(5n, { idempotencyKey: 'plain', usageRecordId: 'u-1' }), debitEntryId: debit.id, now }))).toBe('CONFLICT')
    })

    /** A retry is answered from the key alone: a second debit that took the same usageRecordId in between does not make it ambiguous. */
    it('replays by key even when a second debit with the same usageRecordId appeared', async () => {
      const { c, now } = await burned()
      const first = await c.store.refundToSource!(ref, { entry: refundOf(30n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), now })
      await c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'host-debit-2', usageRecordId: 'u-1' }), 0n)
      const again = await c.store.refundToSource!(ref, { entry: refundOf(30n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), now })
      expect(again.id).toBe(first.id)
    })

    /** The debit is not resolved when it is none, several, another wallet's or not a debit. */
    it('refuses a debit that is not found, is ambiguous, belongs to another wallet or is no debit', async () => {
      const { c, debit, now } = await burned()
      const other: WalletRef = { ...ref, ownerId: 'u2' }
      await c.store.appendEntry(other, grantEntry({ idempotencyKey: 'og', amountNanoUsd: 100n }))
      const foreign = (await c.store.conditionalDebit(other, debitEntry(10n, { idempotencyKey: 'od', usageRecordId: 'u-9' }), 0n))!
      const grant = (await c.store.listEntries(ref)).entries.find((entry) => entry.type === 'grant')!
      const invalid = async (input: { debitEntryId?: string; usageRecordId?: string }): Promise<string> =>
        codeOf(c.store.refundToSource!(ref, { entry: refundOf(1n, { idempotencyKey: `x-${Math.random()}`, ...(input.usageRecordId === undefined ? {} : { usageRecordId: input.usageRecordId }) }), ...(input.debitEntryId === undefined ? {} : { debitEntryId: input.debitEntryId }), now }))
      expect(await invalid({ usageRecordId: 'nobody' })).toBe('AI_TOKENS_INVALID_CONFIG')
      expect(await invalid({})).toBe('AI_TOKENS_INVALID_CONFIG')
      expect(await invalid({ debitEntryId: foreign.id })).toBe('AI_TOKENS_INVALID_CONFIG')
      expect(await invalid({ debitEntryId: grant.id })).toBe('AI_TOKENS_INVALID_CONFIG')
      await c.store.conditionalDebit(ref, debitEntry(1n, { idempotencyKey: 'host-debit-dup', usageRecordId: 'u-1' }), 0n)
      expect(await invalid({ usageRecordId: 'u-1' })).toBe('AI_TOKENS_INVALID_CONFIG')
      expect(debit.id).toBeDefined()
    })

    /** A part restored to a grant that expired by date and was not swept is taken out again, under its own key and not the sweep's. */
    it('takes a part restored to a grant expired by date out again, under the refund key', async () => {
      const c = await make()
      const soon = new Date((await c.now()).getTime() + 200)
      const grant = await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n, expiresAt: soon }))
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g2', amountNanoUsd: 100n, priority: 5 }))
      const debit = (await c.store.conditionalDebit(ref, debitEntry(60n, { idempotencyKey: 'host-debit', usageRecordId: 'u-1' }), 0n))!
      await c.advance(400)
      const before = (await c.store.getWallet(ref))!.balanceNanoUsd
      const refund = await c.store.refundToSource!(ref, { entry: refundOf(60n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), debitEntryId: debit.id, now: await c.now() })
      const entries = (await c.store.listEntries(ref)).entries
      const taken = entries.filter((entry) => entry.type === 'expiry')
      expect(taken.map((entry) => [entry.idempotencyKey, entry.amountNanoUsd])).toEqual([[`expiry:refund:${refund.id}:${grant.id}`, -60n]])
      expect((await c.store.getWallet(ref))!.balanceNanoUsd).toBe(before)
      expect(await remainingOf(c.store, await c.now())).toEqual({ g2: 100n })
    })

    /** After a refund writes its part off an expired grant, the sweep takes only what the grant still holds: here the 40 the debit left unspent. */
    it('lets the sweep take only the residual of a grant after a refund wrote its part off', async () => {
      const c = await make()
      const soon = new Date((await c.now()).getTime() + 200)
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n, expiresAt: soon }))
      const debit = (await c.store.conditionalDebit(ref, debitEntry(60n, { idempotencyKey: 'host-debit', usageRecordId: 'u-1' }), 0n))!
      await c.advance(400)
      await c.store.refundToSource!(ref, { entry: refundOf(60n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), debitEntryId: debit.id, now: await c.now() })
      const balance = (await c.store.getWallet(ref))!.balanceNanoUsd
      await c.store.reconcile(ref)
      const swept = (await c.store.listEntries(ref)).entries.filter((entry) => entry.type === 'expiry')
      expect(swept.map((entry) => entry.amountNanoUsd)).toEqual([-60n, -40n])
      expect((await c.store.getWallet(ref))!.balanceNanoUsd).toBe(balance - 40n)
    })

    /** A refund that writes off a grant's whole remaining part leaves the sweep nothing: no second expiry entry, and the balance does not move. */
    it('leaves the sweep nothing to take from a grant a refund emptied', async () => {
      const c = await make()
      const soon = new Date((await c.now()).getTime() + 200)
      const grantId = (await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n, expiresAt: soon }))).id
      const debit = (await c.store.conditionalDebit(ref, debitEntry(100n, { idempotencyKey: 'host-debit', usageRecordId: 'u-1' }), 0n))!
      await c.advance(400)
      const refund = await c.store.refundToSource!(ref, { entry: refundOf(100n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), debitEntryId: debit.id, now: await c.now() })
      const expiries = async (): Promise<string[]> => (await c.store.listEntries(ref)).entries.filter((entry) => entry.type === 'expiry').map((entry) => `${entry.idempotencyKey}:${entry.amountNanoUsd}`)
      const writtenOff = [`expiry:refund:${refund.id}:${grantId}:-100`]
      expect(await expiries()).toEqual(writtenOff)
      const written = (await c.store.listEntries(ref)).entries
      expect(written.filter((entry) => entry.id === refund.id || entry.type === 'expiry').map((entry) => entry.balanceAfterNanoUsd)).toEqual([100n, 0n])
      const balance = (await c.store.getWallet(ref))!.balanceNanoUsd
      await c.store.reconcile(ref)
      expect(await expiries()).toEqual(writtenOff)
      expect((await c.store.getWallet(ref))!.balanceNanoUsd).toBe(balance)
      expect(balance).toBe(0n)
    })

    /** A grant the sweep already expired is treated as expired whatever the caller's clock says: the part is not written off a second time. */
    it('treats a grant with an expiry entry as expired even when the caller clock is behind', async () => {
      const c = await make()
      const soon = new Date((await c.now()).getTime() + 200)
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n, expiresAt: soon }))
      await c.store.appendEntry(ref, grantEntry({ idempotencyKey: 'g2', amountNanoUsd: 100n }))
      const debit = (await c.store.conditionalDebit(ref, debitEntry(50n, { idempotencyKey: 'host-debit', usageRecordId: 'u-1' }), 0n))!
      const behind = await c.now()
      await c.advance(400)
      await c.store.reconcile(ref)
      const swept = (await c.store.listEntries(ref)).entries.filter((entry) => entry.type === 'expiry')
      expect(swept).toHaveLength(1)
      await c.store.refundToSource!(ref, { entry: refundOf(50n, { idempotencyKey: 'r1', usageRecordId: 'u-1' }), debitEntryId: debit.id, now: behind })
      const after = (await c.store.listEntries(ref)).entries
      expect(after.filter((entry) => entry.type === 'expiry' && entry.idempotencyKey === swept[0]!.idempotencyKey)).toHaveLength(1)
      expect(await remainingOf(c.store, await c.now())).toEqual({ g2: 100n })
      const next = await c.store.conditionalDebit(ref, debitEntry(10n, { idempotencyKey: 'later' }), 0n)
      expect(next).not.toBeNull()
    })
  })
}
