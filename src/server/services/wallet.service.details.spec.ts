/**
 * @fileoverview What `WalletService` hands to the host beyond the error code: the details of its refusals, the audit
 * payloads of its writes and the shape of the granted event.
 * @layer test
 */

import type { WalletRef } from '../../shared'
import type { AiTokensException } from '../errors'
import { InMemoryWalletStore, WalletMissingError } from '../../../test/fakes/in-memory-wallet-store'
import { LedgerIdempotencyConflict } from './ledger-idempotency-conflict'
import { WalletService, type WalletEventHooks } from './wallet.service'

const REF: WalletRef = { tenantId: 't1', ownerType: 'user', ownerId: 'u1' }
const OPTIONS = { enabled: true as const, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' as const }

/** A service over the in-memory store that keeps every payload its hooks are handed. */
function makeService(): { service: WalletService; store: InMemoryWalletStore; granted: object[]; audits: [string, unknown][] } {
  const store = new InMemoryWalletStore({ burnOrder: 'expiry' })
  const granted: object[] = []
  const audits: [string, unknown][] = []
  const hooks: WalletEventHooks = {
    granted: (_ref, data): void => void granted.push(data),
    depleted: (): void => undefined,
    audit: (action, data): void => void audits.push([action, data]),
  }
  return { service: new WalletService(store, OPTIONS, hooks), store, granted, audits }
}

/** The `details` of the refusal `act` rejects with. */
async function detailsOf(act: Promise<unknown>): Promise<unknown> {
  const error = await act.then(
    () => {
      throw new Error('accepted')
    },
    (thrown: unknown) => thrown as AiTokensException,
  )
  return (error.getResponse() as { error: { details: unknown } }).error.details
}

describe('WalletService refusal details', () => {
  /** A host reads which rule refused its call. */
  it.each([
    ['a debit with no usageRecordId and no reason', (s: WalletService) => s.debit(REF, { amountNanoUsd: 1n, idempotencyKey: 'k' }), 'a debit without a usageRecordId must carry a reason'],
    ['a zero settlement adjustment', (s: WalletService) => s.settleAdjustment(REF, { amountNanoUsd: 0n, idempotencyKey: 'k', reason: 'r' }), 'settlement adjustment amount must be a non-zero bigint within -9223372036854775808 to 9223372036854775807'],
    ['a key-scoped owner', (s: WalletService) => s.getBalance({ ...REF, ownerType: 'key' as never }), "'key' scopes cannot own a wallet"],
    ['a fractional priority', (s: WalletService) => s.grant(REF, { amountNanoUsd: 1n, priority: 0.5, idempotencyKey: 'k', reason: 'r' }), 'grant priority must be a whole number'],
  ])('names the reason for %s', async (_name, act, reason) => {
    expect(await detailsOf(act(makeService().service))).toEqual({ reason })
  })

  /** An overdraw names what was there and what was asked for. */
  it('carries the balance and the requested amount of an insufficient debit', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 5n, idempotencyKey: 'g', reason: 'r' })
    expect(await detailsOf(service.debit(REF, { amountNanoUsd: 9n, idempotencyKey: 'd', reason: 'r' }))).toEqual({ balanceNanoUsd: '5', requestedNanoUsd: '9' })
  })

  /** A store conflict names the tenant and the key. */
  it('carries the tenant and the key of an idempotency conflict', async () => {
    const { service, store } = makeService()
    jest.spyOn(store, 'conditionalDebit').mockRejectedValue(new LedgerIdempotencyConflict('t1', 'd'))
    expect(await detailsOf(service.debit(REF, { amountNanoUsd: 1n, idempotencyKey: 'd', reason: 'r' }))).toEqual({ tenantId: 't1', idempotencyKey: 'd' })
  })

  /** A refund into a wallet the store does not have says so. */
  it('says the wallet does not exist', async () => {
    const { service, store } = makeService()
    jest.spyOn(store, 'appendEntry').mockRejectedValue(new WalletMissingError())
    expect(await detailsOf(service.refund(REF, { amountNanoUsd: 1n, idempotencyKey: 'f', reason: 'r' }))).toEqual({ reason: 'wallet does not exist' })
  })

  /** A store may reject with nothing at all; that is still a typed store error. */
  it('maps a store that rejects with undefined to a store error', async () => {
    const { service, store } = makeService()
    jest.spyOn(store, 'appendEntry').mockRejectedValue(undefined)
    const error = await service.refund(REF, { amountNanoUsd: 1n, idempotencyKey: 'f', reason: 'r' }).catch((thrown: unknown) => thrown as AiTokensException)
    expect((error as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR' } })
  })
})

describe('WalletService audit and event payloads', () => {
  /** A grant with no expiry puts no `expiresAt` key on the event. */
  it('leaves expiresAt off the granted event of a grant that has none', async () => {
    const { service, granted } = makeService()
    await service.grant(REF, { amountNanoUsd: 5n, idempotencyKey: 'g', reason: 'r' })
    expect(granted).toHaveLength(1)
    expect('expiresAt' in granted[0]!).toBe(false)
  })

  /** The audit of a grant and of an adjustment name the tenant, wallet, entry, amount and reason. */
  it.each([
    ['ai_tokens.wallet.granted', (s: WalletService) => s.grant(REF, { amountNanoUsd: 5n, idempotencyKey: 'g', reason: 'why' })],
    ['ai_tokens.wallet.adjusted', (s: WalletService) => s.adjust(REF, { amountNanoUsd: 5n, idempotencyKey: 'a', reason: 'why' })],
  ])('records the details of %s', async (action, act) => {
    const { service, audits } = makeService()
    const entry = await act(service)
    expect(audits).toEqual([[action, { tenantId: 't1', walletId: entry.walletId, entryId: entry.id, amountNanoUsd: '5', reason: 'why' }]])
  })

  /** The audit of a reconcile says what was reconciled. */
  it('records the details of a reconcile', async () => {
    const { service, audits } = makeService()
    const entry = await service.grant(REF, { amountNanoUsd: 5n, idempotencyKey: 'g', reason: 'why' })
    audits.length = 0
    await service.reconcile(REF)
    expect(audits).toEqual([['ai_tokens.wallet.reconciled', { tenantId: 't1', walletId: entry.walletId, balanceNanoUsd: '5' }]])
  })
})
