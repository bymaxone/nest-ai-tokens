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
    ['a zero grant', (s: WalletService) => s.grant(REF, { amountNanoUsd: 0n, idempotencyKey: 'k', reason: 'r' }), 'grant amount must be a bigint from 1 to 9223372036854775807'],
    ['a zero debit', (s: WalletService) => s.debit(REF, { amountNanoUsd: 0n, idempotencyKey: 'k', reason: 'r' }), 'debit amount must be a bigint from 1 to 9223372036854775807'],
    ['a zero refund', (s: WalletService) => s.refund(REF, { amountNanoUsd: 0n, idempotencyKey: 'k', reason: 'r' }), 'refund amount must be a bigint from 1 to 9223372036854775807'],
    ['a zero adjustment', (s: WalletService) => s.adjust(REF, { amountNanoUsd: 0n, idempotencyKey: 'k', reason: 'r' }), 'adjustment amount must be a non-zero bigint within -9223372036854775808 to 9223372036854775807'],
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

describe('WalletService, what the store is handed', () => {
  /** An optional field the caller leaves out is no key of the entry, and the wallet id is left for the store to assign. */
  it.each([
    ['grant', (s: WalletService) => s.grant(REF, { amountNanoUsd: 5n, idempotencyKey: 'k', reason: 'r' }), 'appendEntry', ['amountNanoUsd', 'effectiveAt', 'idempotencyKey', 'priority', 'reason', 'type', 'walletId']],
    ['refund', (s: WalletService) => s.refund(REF, { amountNanoUsd: 5n, idempotencyKey: 'k', reason: 'r' }), 'appendEntry', ['amountNanoUsd', 'effectiveAt', 'idempotencyKey', 'priority', 'reason', 'type', 'walletId']],
    ['settlement adjustment', (s: WalletService) => s.settleAdjustment(REF, { amountNanoUsd: 5n, idempotencyKey: 'k', reason: 'r' }), 'appendEntry', ['amountNanoUsd', 'effectiveAt', 'idempotencyKey', 'priority', 'reason', 'type', 'walletId']],
    ['debit with a reason only', (s: WalletService) => s.debit(REF, { amountNanoUsd: 5n, idempotencyKey: 'k', reason: 'r' }), 'conditionalDebit', ['amountNanoUsd', 'effectiveAt', 'idempotencyKey', 'priority', 'reason', 'type', 'walletId']],
    ['debit with a record only', (s: WalletService) => s.debit(REF, { amountNanoUsd: 5n, idempotencyKey: 'k', usageRecordId: 'u' }), 'conditionalDebit', ['amountNanoUsd', 'effectiveAt', 'idempotencyKey', 'priority', 'type', 'usageRecordId', 'walletId']],
  ] as const)('hands the store only the fields of a %s', async (_name, act, method, keys) => {
    const { service, store } = makeService()
    await store.appendEntry(REF, { walletId: '', type: 'grant', amountNanoUsd: 100n, priority: 0, effectiveAt: new Date(0), idempotencyKey: 'seed', reason: 'r' })
    const write = jest.spyOn(store, method)
    await act(service)
    const entry = write.mock.calls[0]?.[1]
    expect(Object.keys(entry ?? {}).sort()).toEqual(keys)
    expect(entry?.walletId).toBe('')
  })

  /** A record id the caller gives is passed on by a refund and by a settlement adjustment. */
  it.each([
    ['refund', (s: WalletService) => s.refund(REF, { amountNanoUsd: 5n, usageRecordId: 'u', idempotencyKey: 'k', reason: 'r' })],
    ['settlement adjustment', (s: WalletService) => s.settleAdjustment(REF, { amountNanoUsd: 5n, usageRecordId: 'u', idempotencyKey: 'k', reason: 'r' })],
  ])('passes the record id of a %s', async (_name, act) => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 5n, idempotencyKey: 'g', reason: 'r' })
    expect(await act(service)).toMatchObject({ usageRecordId: 'u' })
  })

  /** The expiry of a grant reaches both the entry and the event. */
  it('passes the expiry of a grant to the entry and the event', async () => {
    const { service, granted } = makeService()
    const expiresAt = new Date('2999-01-01T00:00:00.000Z')
    const entry = await service.grant(REF, { amountNanoUsd: 5n, expiresAt, idempotencyKey: 'g', reason: 'r' })
    expect(entry.expiresAt).toEqual(expiresAt)
    expect(granted).toEqual([{ walletId: entry.walletId, entryId: entry.id, amountNanoUsd: 5n, expiresAt }])
  })

  /** A function is not the store's missing-wallet signal, whatever it carries. */
  it('reads a thrown function that carries the missing-wallet mark as a store error', async () => {
    const { service, store } = makeService()
    jest.spyOn(store, 'appendEntry').mockRejectedValue(Object.assign(() => undefined, { isWalletMissing: true }))
    const error = await service.refund(REF, { amountNanoUsd: 1n, idempotencyKey: 'f', reason: 'r' }).catch((thrown: unknown) => thrown as AiTokensException)
    expect((error as AiTokensException).getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR' } })
  })
})
