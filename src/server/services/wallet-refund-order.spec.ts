/**
 * @fileoverview The order a split of a refund to source breaks its ties in is the SQL store's, `seq NULLS FIRST, createdAt, id`: the in-memory
 * fake follows the sequence even when the clock that stamped the grants says otherwise.
 * @layer test
 */

import type { NewWalletEntry, WalletRef } from '../../shared'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { debitEntry, grantEntry } from '../../../test/contracts/wallet-store.contract'

const REF: WalletRef = { tenantId: 't1', ownerType: 'user', ownerId: 'u1' }

describe('refund to source tie order', () => {
  /** One unit over two equal grants goes to the grant appended first, although its timestamp is the later one. */
  it('gives the odd unit to the grant with the lower sequence, not the older timestamp', async () => {
    let clock = new Date('2030-01-02T00:00:00.000Z')
    const store = new InMemoryWalletStore({ now: () => clock })
    const first = await store.appendEntry(REF, grantEntry({ idempotencyKey: 'g1', amountNanoUsd: 100n }))
    clock = new Date('2030-01-01T00:00:00.000Z')
    await store.appendEntry(REF, grantEntry({ idempotencyKey: 'g2', amountNanoUsd: 100n }))
    clock = new Date('2030-01-03T00:00:00.000Z')
    const debit = await store.conditionalDebit(REF, debitEntry(200n, { idempotencyKey: 'host-debit', usageRecordId: 'u-1' }), 0n)
    const refund: NewWalletEntry = { ...grantEntry({ idempotencyKey: 'r1' }), type: 'refund', amountNanoUsd: 1n, usageRecordId: 'u-1', reason: 'tie' }

    await store.refundToSource(REF, { entry: refund, debitEntryId: debit?.id ?? '', now: clock })

    const open = await store.openGrants(REF, 'fifo')
    expect(open.map((grant) => [grant.id, grant.remainingNanoUsd])).toEqual([[first.id, 1n]])
  })
})
