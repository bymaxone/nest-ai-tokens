/**
 * @fileoverview What `reconcile` answers when the store cannot reconcile a wallet. A wallet that does not exist is the same typed
 * refusal every other wallet call gives for it, and a store that fails is a typed store error with the original on `cause`, not
 * the raw signal or the raw driver error the store raised.
 * @layer server
 */

import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { AiTokensException } from '../errors'
import { WalletService } from './wallet.service'

const OPTIONS = { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' } as const
const REF = { tenantId: 't', ownerType: 'user', ownerId: 'u' } as const

/** The code of the typed error `run` rejects with. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AiTokensException) return (error.getResponse() as { error: { code: string } }).error.code
    throw error
  }
  throw new Error('expected the call to be refused')
}

describe('reconcile of a wallet the store cannot reconcile', () => {
  /** Invariant: a wallet that does not exist is refused as it is by a debit, not raised as the store's own signal. */
  it('refuses a wallet that does not exist with the typed error', async () => {
    expect(await codeOf(() => new WalletService(new InMemoryWalletStore(), OPTIONS).reconcile(REF))).toBe('AI_TOKENS_INSUFFICIENT_CREDITS')
  })

  /** Invariant: a store that fails is a typed store error whose cause is the original. */
  it('types a failure of the store and keeps the original as the cause', async () => {
    const failure = Object.assign(new Error('driver text'), { code: 'ECONNREFUSED' })
    const store = new InMemoryWalletStore()
    store.reconcile = (): never => {
      throw failure
    }
    const service = new WalletService(store, OPTIONS)
    const error = await service.reconcile(REF).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AiTokensException)
    expect((error as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_UNAVAILABLE' } })
    expect((error as AiTokensException).cause).toBe(failure)
    expect(JSON.stringify((error as AiTokensException).getResponse())).not.toContain('driver text')
  })
})
