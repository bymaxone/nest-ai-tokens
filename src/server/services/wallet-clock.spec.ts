/**
 * @fileoverview A grant is judged on one clock: the application's, passed to the store with every call,
 * whatever clock the store's own machine keeps (the database server's, for the SQL store).
 * @layer test
 */

import type { WalletRef } from '../../shared'
import { AiTokensException } from '../errors'
import { WalletService, type WalletServiceOptions } from './wallet.service'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'

const REF: WalletRef = { tenantId: 't1', ownerType: 'user', ownerId: 'u1' }
const OPTIONS: WalletServiceOptions = { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' }
const START = Date.parse('2030-01-01T00:00:00.000Z')
const SKEW_MS = 2_000

/** An application clock the test moves, and a store whose own clock runs `SKEW_MS` behind it. */
function skewed(): { service: WalletService; store: InMemoryWalletStore; advance: (ms: number) => void } {
  let app = START
  const store = new InMemoryWalletStore({ now: () => new Date(app - SKEW_MS) })
  const service = new WalletService(store, OPTIONS, undefined, () => new Date(app))
  return { service, store, advance: (ms): void => void (app += ms) }
}

describe('wallet grants are judged on the application clock', () => {
  /*
   * Invariant: a grant that expired 1 s ago by the application's clock is not spendable, even though a store
   * clock 2 s behind it still reads the grant as live.
   */
  it('refuses a debit against a grant that lapsed by the application clock while the store clock is behind', async () => {
    const { service, advance } = skewed()
    await service.grant(REF, { amountNanoUsd: 5n, expiresAt: new Date(START + 1_000), idempotencyKey: 'g', reason: 'r' })
    advance(2_000)
    await expect(service.debit(REF, { amountNanoUsd: 1n, idempotencyKey: 'd', reason: 'r' })).rejects.toBeInstanceOf(AiTokensException)
  })

  /*
   * Invariant: reconcile counts a lapsed grant as gone on the application clock too, so the balance it
   * repairs to equals what a debit would find.
   */
  it('reconciles a lapsed grant to nothing on the application clock', async () => {
    const { service, advance } = skewed()
    await service.grant(REF, { amountNanoUsd: 5n, expiresAt: new Date(START + 1_000), idempotencyKey: 'g', reason: 'r' })
    advance(2_000)
    expect((await service.reconcile(REF)).nanoUsd).toBe(0n)
  })

  /*
   * Invariant: a grant that has become effective by the application clock is spendable although the store clock
   * has not reached its `effectiveAt`.
   */
  it('credits a grant that became effective by the application clock while the store clock is behind', async () => {
    const { service, advance } = skewed()
    await service.grant(REF, { amountNanoUsd: 5n, effectiveAt: new Date(START + 1_000), idempotencyKey: 'g', reason: 'r' })
    advance(2_000)
    await expect(service.debit(REF, { amountNanoUsd: 1n, idempotencyKey: 'd', reason: 'r' })).resolves.toMatchObject({ amountNanoUsd: -1n })
  })

  /*
   * Invariant: an entry's `createdAt` is the instant the service passed, so a grant stamped due at append
   * is judged due on that same clock.
   */
  it('stamps an entry with the instant it was given', async () => {
    const { service, store } = skewed()
    const entry = await service.grant(REF, { amountNanoUsd: 5n, idempotencyKey: 'g', reason: 'r' })
    expect(entry.createdAt.getTime()).toBe(START)
    expect(store.entriesOf(REF)[0]?.createdAt.getTime()).toBe(START)
  })
})
