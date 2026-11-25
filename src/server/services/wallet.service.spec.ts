import type { AiTokensErrorResponse, Wallet, WalletEntry, WalletRef } from '../../shared'
import type { IWalletStore } from '../interfaces'
import { AiTokensException } from '../errors'
import { LedgerIdempotencyConflict } from './ledger-idempotency-conflict'
import { WalletService, type WalletEventHooks, type WalletServiceOptions } from './wallet.service'
import { InMemoryWalletStore, WalletMissingError, type BurnOrder } from '../../../test/fakes/in-memory-wallet-store'
import { runWalletStoreContract } from '../../../test/contracts/wallet-store.contract'

/** The wallet owner used across the suite (`'user'` — never `'key'`). */
const REF: WalletRef = { tenantId: 't1', ownerType: 'user', ownerId: 'u1' }

/** Default resolved wallet settings (1 credit = $1, no overdraft). */
const OPTIONS: WalletServiceOptions = {
  enabled: true,
  creditRateNanoUsd: 1_000_000_000n,
  overdraftNanoUsd: 0n,
  burnOrder: 'expiry',
}

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** Assert a promise rejects with a specific `AiTokensException` code. */
async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AiTokensException)
  expect(codeOf(thrown)).toBe(code)
}

/** A recording event-hooks double asserting emitted events. */
function recordingHooks(): {
  hooks: WalletEventHooks
  granted: unknown[]
  depleted: unknown[]
  audits: { action: string; details: Record<string, unknown> }[]
} {
  const granted: unknown[] = []
  const depleted: unknown[] = []
  const audits: { action: string; details: Record<string, unknown> }[] = []
  return {
    granted,
    depleted,
    audits,
    hooks: {
      granted: (_ref, data): void => void granted.push(data),
      depleted: (_ref, data): void => void depleted.push(data),
      audit: (action, details): void => void audits.push({ action, details }),
    },
  }
}

/** A fresh service over an in-memory fake with recording hooks. */
function makeService(
  over: { options?: Partial<WalletServiceOptions>; burnOrder?: BurnOrder; now?: () => Date } = {},
): {
  service: WalletService
  store: InMemoryWalletStore
  granted: unknown[]
  depleted: unknown[]
  audits: { action: string; details: Record<string, unknown> }[]
} {
  const store = new InMemoryWalletStore({
    burnOrder: over.burnOrder ?? 'expiry',
    ...(over.now !== undefined ? { now: over.now } : {}),
  })
  const rec = recordingHooks()
  const service = new WalletService(store, { ...OPTIONS, ...over.options }, rec.hooks, over.now)
  return { service, store, granted: rec.granted, depleted: rec.depleted, audits: rec.audits }
}

/** A stub store whose named method rejects with `thrown`; the rest are inert. */
function throwingStore(method: keyof IWalletStore, thrown: unknown): IWalletStore {
  // The double rejects with any value, to exercise the mapping of a rejection that is not an Error.
  const reject = jest.fn<Promise<never>, []>().mockRejectedValue(thrown)
  const base: IWalletStore = {
    getWallet: (): Promise<Wallet | null> => Promise.resolve(null),
    appendEntry: (): Promise<never> => Promise.reject(new Error('unused')),
    conditionalDebit: (): Promise<never> => Promise.reject(new Error('unused')),
    openGrants: (): Promise<never[]> => Promise.resolve([]),
    listEntries: (): Promise<{ entries: WalletEntry[]; total: number }> => Promise.resolve({ entries: [], total: 0 }),
    reconcile: (): Promise<never> => Promise.reject(new Error('unused')),
  }
  return { ...base, [method]: reject }
}

describe('WalletService', () => {
  /** getBalance reports the materialized balance and its credits; a missing wallet is zero. */
  it('reports balance and credits, zero for a missing wallet', async () => {
    const { service } = makeService()
    expect(await service.getBalance(REF)).toEqual({ nanoUsd: 0n, credits: 0 })
    await service.grant(REF, { amountNanoUsd: 2_500_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    expect(await service.getBalance(REF)).toEqual({ nanoUsd: 2_500_000_000n, credits: 2.5 })
  })

  /** grant appends a credit and emits wallet.granted + audit (with the expiresAt payload field). */
  it('grants credits and emits granted + audit', async () => {
    const { service, granted, audits } = makeService()
    const expiresAt = new Date('2027-01-01T00:00:00.000Z')
    const entry = await service.grant(REF, { amountNanoUsd: 1_000_000_000n, expiresAt, idempotencyKey: 'g1', reason: 'promo' })
    expect(entry.type).toBe('grant')
    expect(granted).toEqual([{ walletId: entry.walletId, entryId: entry.id, amountNanoUsd: 1_000_000_000n, expiresAt }])
    expect(audits.map((a) => a.action)).toContain('ai_tokens.wallet.granted')
  })

  /** grant rejects a non-positive amount. */
  it('rejects a non-positive grant', async () => {
    const { service } = makeService()
    await expectRejectCode(service.grant(REF, { amountNanoUsd: 0n, idempotencyKey: 'g0', reason: 'x' }), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** debit reserves atomically and links a usageRecordId; the balance drops by the cost. */
  it('debits against a granted balance', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 1_000_000_000n, idempotencyKey: 'g1', reason: 'seed' })
    const debit = await service.debit(REF, { amountNanoUsd: 400_000_000n, usageRecordId: 'ur1', idempotencyKey: 'd1' })
    expect(debit.amountNanoUsd).toBe(-400_000_000n)
    expect(debit.usageRecordId).toBe('ur1')
    expect((await service.getBalance(REF)).nanoUsd).toBe(600_000_000n)
  })

  /** A non-usage debit is allowed when it carries a reason (the voucher-reservation path). */
  it('debits a non-usage reservation with a reason', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    const debit = await service.debit(REF, { amountNanoUsd: 40n, idempotencyKey: 'd1', reason: 'voucher hold' })
    expect(debit.reason).toBe('voucher hold')
  })

  /** A debit with neither usageRecordId nor reason is a validation error. */
  it('rejects a debit missing both usageRecordId and reason', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    await expectRejectCode(service.debit(REF, { amountNanoUsd: 10n, idempotencyKey: 'd1' }), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** A non-positive debit is a validation error. */
  it('rejects a non-positive debit', async () => {
    const { service } = makeService()
    await expectRejectCode(service.debit(REF, { amountNanoUsd: 0n, idempotencyKey: 'd1', reason: 'x' }), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** A debit that exhausts the balance emits wallet.depleted. */
  it('emits depleted when a debit hits zero', async () => {
    const { service, depleted } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    await service.debit(REF, { amountNanoUsd: 100n, idempotencyKey: 'd1', reason: 'drain' })
    expect(depleted).toHaveLength(1)
    const event = depleted[0] as { walletId: string; balanceNanoUsd: bigint }
    expect(typeof event.walletId).toBe('string')
    expect(event.balanceNanoUsd).toBe(0n)
  })

  /** A partial debit leaving a positive balance does NOT emit depleted — kills CE→true on the whole guard condition. */
  it('does not emit depleted when the balance remains positive', async () => {
    const { service, depleted } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    await service.debit(REF, { amountNanoUsd: 40n, idempotencyKey: 'd1', reason: 'partial' })
    expect(depleted).toHaveLength(0)
    expect((await service.getBalance(REF)).nanoUsd).toBe(60n)
  })

  /** A debit leaving exactly balance=0 DOES emit depleted — kills EQ mutation (<= → <). */
  it('emits depleted when the balance lands exactly at zero', async () => {
    const { service, depleted } = makeService()
    await service.grant(REF, { amountNanoUsd: 50n, idempotencyKey: 'g1', reason: 'seed' })
    await service.debit(REF, { amountNanoUsd: 50n, idempotencyKey: 'd1', reason: 'drain-exact' })
    expect(depleted).toHaveLength(1)
    const event = depleted[0] as { balanceNanoUsd: bigint }
    expect(event.balanceNanoUsd).toBe(0n)
  })

  /** A debit beyond the balance (no overdraft) throws insufficient credits. */
  it('throws insufficient credits past the balance', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 50n, idempotencyKey: 'g1', reason: 'seed' })
    await expectRejectCode(service.debit(REF, { amountNanoUsd: 80n, idempotencyKey: 'd1', reason: 'over' }), 'AI_TOKENS_INSUFFICIENT_CREDITS')
  })

  /** A debit against a nonexistent wallet is insufficient credits (§9.1). */
  it('throws insufficient credits for a nonexistent wallet', async () => {
    const { service } = makeService()
    await expectRejectCode(service.debit(REF, { amountNanoUsd: 10n, idempotencyKey: 'd1', reason: 'x' }), 'AI_TOKENS_INSUFFICIENT_CREDITS')
  })

  /** Overdraft lets the balance reach exactly -overdraft. */
  it('honors the configured overdraft', async () => {
    const { service } = makeService({ options: { overdraftNanoUsd: 50n } })
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    await service.debit(REF, { amountNanoUsd: 150n, idempotencyKey: 'd1', reason: 'overdraw' })
    expect((await service.getBalance(REF)).nanoUsd).toBe(-50n)
  })

  /** refund appends a credit; the balance returns to the pre-debit value. */
  it('refunds a debit', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    await service.debit(REF, { amountNanoUsd: 40n, usageRecordId: 'ur1', idempotencyKey: 'd1' })
    const refund = await service.refund(REF, { amountNanoUsd: 40n, usageRecordId: 'ur1', idempotencyKey: 'r1', reason: 'refund' })
    expect(refund.type).toBe('refund')
    // Kills CE→false and EqualityOperator on the usageRecordId conditional spread:
    expect(refund.usageRecordId).toBe('ur1')
    expect((await service.getBalance(REF)).nanoUsd).toBe(100n)
  })

  /** refund rejects a non-positive amount. */
  it('rejects a non-positive refund', async () => {
    const { service } = makeService()
    await expectRejectCode(service.refund(REF, { amountNanoUsd: 0n, idempotencyKey: 'r1', reason: 'x' }), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** An entry key in the namespace the store keeps for itself (activation and expiry keys) is refused with a typed configuration error, whatever the operation. */
  it.each([
    ['grant', (key: string, service: WalletService) => service.grant(REF, { amountNanoUsd: 10n, idempotencyKey: key, reason: 'x' })],
    ['refund', (key: string, service: WalletService) => service.refund(REF, { amountNanoUsd: 10n, idempotencyKey: key, reason: 'x' })],
    ['adjust', (key: string, service: WalletService) => service.adjust(REF, { amountNanoUsd: 10n, idempotencyKey: key, reason: 'x' })],
    ['debit', (key: string, service: WalletService) => service.debit(REF, { amountNanoUsd: 1n, idempotencyKey: key, reason: 'x' })],
  ])('refuses a %s whose key is in the store namespace', async (_name, call) => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'base', reason: 'seed' })

    await expectRejectCode(call('activate:grant-1', service), 'AI_TOKENS_INVALID_CONFIG')
    await expectRejectCode(call('expiry:grant-1', service), 'AI_TOKENS_INVALID_CONFIG')
    expect((await service.getBalance(REF)).nanoUsd).toBe(100n)
  })

  /** adjust applies a signed correction and emits audit. */
  it('adjusts and emits audit', async () => {
    const { service, audits } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    const entry = await service.adjust(REF, { amountNanoUsd: -30n, idempotencyKey: 'a1', reason: 'correction' })
    expect(entry.amountNanoUsd).toBe(-30n)
    expect((await service.getBalance(REF)).nanoUsd).toBe(70n)
    expect(audits.map((a) => a.action)).toContain('ai_tokens.wallet.adjusted')
  })

  /** A positive adjustment auto-creates the wallet. */
  it('auto-creates the wallet on a positive adjustment', async () => {
    const { service } = makeService()
    await service.adjust(REF, { amountNanoUsd: 500n, idempotencyKey: 'a1', reason: 'seed' })
    expect((await service.getBalance(REF)).nanoUsd).toBe(500n)
  })

  /** adjust rejects a zero amount. */
  it('rejects a zero adjustment', async () => {
    const { service } = makeService()
    await expectRejectCode(service.adjust(REF, { amountNanoUsd: 0n, idempotencyKey: 'a1', reason: 'x' }), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** getEntries paginates and filters by type. */
  it('lists entries with a type filter', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    await service.debit(REF, { amountNanoUsd: 10n, idempotencyKey: 'd1', reason: 'x' })
    const page = await service.getEntries(REF, { type: 'grant' })
    expect(page.total).toBe(1)
    expect(page.entries[0]?.type).toBe('grant')
    const all = await service.getEntries(REF)
    expect(all.total).toBe(2)
  })

  /** reconcile recomputes the balance and emits audit. */
  it('reconciles and emits audit', async () => {
    const { service, store, audits } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    store.forceBalance(REF, 999n)
    const reconciled = await service.reconcile(REF)
    expect(reconciled.nanoUsd).toBe(100n)
    expect(audits.map((a) => a.action)).toContain('ai_tokens.wallet.reconciled')
  })

  /** A grant key reused with a different payload conflicts. */
  it('conflicts on a grant key reuse with a different payload', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    await expectRejectCode(service.grant(REF, { amountNanoUsd: 200n, idempotencyKey: 'g1', reason: 'seed' }), 'AI_TOKENS_IDEMPOTENCY_CONFLICT')
  })

  /** A grant replay with a matching payload returns the stored entry. */
  it('replays a matching grant', async () => {
    const { service } = makeService()
    const first = await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    const replay = await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    expect(replay.id).toBe(first.id)
  })

  /** A refund on a nonexistent wallet maps the missing-wallet signal to insufficient credits. */
  it('maps a missing wallet on refund to insufficient credits', async () => {
    const { service } = makeService()
    await expectRejectCode(service.refund(REF, { amountNanoUsd: 10n, idempotencyKey: 'r1', reason: 'x' }), 'AI_TOKENS_INSUFFICIENT_CREDITS')
  })

  /** A store idempotency conflict on a debit maps to the catalog conflict. */
  it('maps a store conflict on debit', async () => {
    const service = new WalletService(throwingStore('conditionalDebit', new LedgerIdempotencyConflict('t1', 'd1')), OPTIONS)
    await expectRejectCode(service.debit(REF, { amountNanoUsd: 10n, idempotencyKey: 'd1', reason: 'x' }), 'AI_TOKENS_IDEMPOTENCY_CONFLICT')
  })

  /** An unknown store failure on appendEntry becomes a store error. */
  it('maps an unknown store failure to a store error', async () => {
    const service = new WalletService(throwingStore('appendEntry', new Error('driver down')), OPTIONS)
    await expectRejectCode(service.grant(REF, { amountNanoUsd: 10n, idempotencyKey: 'g1', reason: 'x' }), 'AI_TOKENS_STORE_ERROR')
  })

  /** A store that cannot be reached is reported as unavailable, 503, with the driver error as the cause. */
  it('maps an unreachable store to the unavailable code', async () => {
    const original = Object.assign(new Error('connect ECONNREFUSED'), { name: 'PrismaClientKnownRequestError', code: 'ECONNREFUSED' })
    const service = new WalletService(throwingStore('appendEntry', original), OPTIONS)
    const error = await service.grant(REF, { amountNanoUsd: 10n, idempotencyKey: 'g1', reason: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AiTokensException)
    expect((error as AiTokensException).getStatus()).toBe(503)
    expect(((error as AiTokensException).getResponse() as { error: { code: string } }).error.code).toBe('AI_TOKENS_STORE_UNAVAILABLE')
    expect((error as AiTokensException).cause).toBe(original)
  })

  /** A custom store is classified by the same shape rules: a plain error naming a closed connection is unavailable, 503. */
  it('classifies a custom store error by its message', async () => {
    const service = new WalletService(throwingStore('appendEntry', new Error('Connection closed')), OPTIONS)
    const error = await service.grant(REF, { amountNanoUsd: 10n, idempotencyKey: 'g1', reason: 'x' }).catch((e: unknown) => e)
    expect((error as AiTokensException).getStatus()).toBe(503)
    expect(((error as AiTokensException).getResponse() as { error: { code: string } }).error.code).toBe('AI_TOKENS_STORE_UNAVAILABLE')
  })

  /** An idempotency conflict is decided before availability and keeps its 409, even when the same error carries an availability code. */
  it('keeps a conflict as a conflict', async () => {
    const conflict = Object.assign(new LedgerIdempotencyConflict('t1', 'd1'), { code: 'ECONNRESET' })
    const service = new WalletService(throwingStore('conditionalDebit', conflict), OPTIONS)
    const error = await service.debit(REF, { amountNanoUsd: 10n, idempotencyKey: 'd1', reason: 'x' }).catch((e: unknown) => e)
    expect((error as AiTokensException).getStatus()).toBe(409)
  })

  /** The original store failure rides on the store error as its cause, for a server-side log, and never in the body. */
  it('keeps the original store failure as the cause of the store error', async () => {
    const original = new Error('driver down: connect ECONNREFUSED db.internal:5432')
    const service = new WalletService(throwingStore('appendEntry', original), OPTIONS)
    const error = await service.grant(REF, { amountNanoUsd: 10n, idempotencyKey: 'g1', reason: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AiTokensException)
    expect((error as AiTokensException).cause).toBe(original)
    expect(JSON.stringify((error as AiTokensException).getResponse())).not.toContain('db.internal')
  })

  /** A non-object store throw becomes a store error (guards reject non-objects). */
  it('maps a non-object store throw to a store error', async () => {
    const service = new WalletService(throwingStore('appendEntry', 'boom'), OPTIONS)
    await expectRejectCode(service.grant(REF, { amountNanoUsd: 10n, idempotencyKey: 'g1', reason: 'x' }), 'AI_TOKENS_STORE_ERROR')
  })

  /**
   * A store that throws `null` must be caught as STORE_ERROR — not a TypeError.
   * Kills LogicalOperator (||→&&) and CE→false on `error === null` in isWalletMissing:
   * without the null guard, `null.isWalletMissing` throws a TypeError which is NOT caught
   * and leaks as an unhandled rejection, not a typed AiTokensException.
   */
  it('maps a null store throw to a store error', async () => {
    const service = new WalletService(throwingStore('appendEntry', null), OPTIONS)
    await expectRejectCode(service.grant(REF, { amountNanoUsd: 10n, idempotencyKey: 'g1', reason: 'x' }), 'AI_TOKENS_STORE_ERROR')
  })

  /** A store that already throws an AiTokensException passes it through unchanged. */
  it('passes a store AiTokensException through', async () => {
    const thrown = new AiTokensException('AI_TOKENS_PRICE_NOT_FOUND', undefined, {})
    const service = new WalletService(throwingStore('appendEntry', thrown), OPTIONS)
    await expect(service.grant(REF, { amountNanoUsd: 10n, idempotencyKey: 'g1', reason: 'x' })).rejects.toBe(thrown)
  })

  /** A `'key'` owner cannot own a wallet (§9.1). */
  it('rejects a key-scoped owner', async () => {
    const { service } = makeService()
    const keyRef = { tenantId: 't1', ownerType: 'key', ownerId: 'k1' } as unknown as WalletRef
    await expectRejectCode(service.getBalance(keyRef), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** The default no-op hooks let grant/debit/deplete run without a dispatcher. */
  it('runs with default no-op hooks', async () => {
    const store = new InMemoryWalletStore()
    const service = new WalletService(store, OPTIONS)
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'seed' })
    await expect(service.debit(REF, { amountNanoUsd: 100n, idempotencyKey: 'd1', reason: 'drain' })).resolves.toBeDefined()
  })
})

describe('WalletService.settleAdjustment (capture ±delta, §11.2)', () => {
  /** A positive settlement adjustment credits the balance (refund of an over-reservation). */
  it('credits the balance on a positive adjustment', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 1_000n, idempotencyKey: 'g1', reason: 'seed' })
    const entry = await service.settleAdjustment(REF, { amountNanoUsd: 500n, usageRecordId: 'rec-1', idempotencyKey: 'capture:rec-1', reason: 'refund' })
    expect(entry.type).toBe('adjustment')
    // Kills CE→false and EqualityOperator on the usageRecordId conditional spread:
    expect(entry.usageRecordId).toBe('rec-1')
    expect((await service.getBalance(REF)).nanoUsd).toBe(1_500n)
  })

  /** A negative settlement adjustment debits the balance unconditionally (past zero). */
  it('debits the balance on a negative adjustment without a guard', async () => {
    const { service } = makeService()
    await service.grant(REF, { amountNanoUsd: 1_000n, idempotencyKey: 'g1', reason: 'seed' })
    await service.settleAdjustment(REF, { amountNanoUsd: -2_000n, idempotencyKey: 'capture:rec-2', reason: 'top-up' })
    expect((await service.getBalance(REF)).nanoUsd).toBe(-1_000n)
  })

  /** A zero settlement adjustment is rejected. */
  it('rejects a zero settlement adjustment', async () => {
    const { service } = makeService()
    await expectRejectCode(service.settleAdjustment(REF, { amountNanoUsd: 0n, idempotencyKey: 'z', reason: 'noop' }), 'AI_TOKENS_INVALID_CONFIG')
  })
})

describe('WalletService — grant burn-down (§9.3)', () => {
  /** With 'expiry' order, a debit draws from the soonest-expiring grant first. */
  it("allocates soonest-expiring first ('expiry')", async () => {
    const { service, store } = makeService({ burnOrder: 'expiry' })
    await service.grant(REF, { amountNanoUsd: 50n, expiresAt: new Date('2030-01-01T00:00:00.000Z'), idempotencyKey: 'g-late', reason: 'a' })
    const soon = await service.grant(REF, { amountNanoUsd: 50n, expiresAt: new Date('2027-01-01T00:00:00.000Z'), idempotencyKey: 'g-soon', reason: 'b' })
    const debit = await service.debit(REF, { amountNanoUsd: 30n, idempotencyKey: 'd1', reason: 'x' })
    expect(store.allocationsOf(debit.id)).toEqual([{ debitEntryId: debit.id, grantEntryId: soon.id, amountNanoUsd: 30n }])
  })

  /** With 'priority' order, the lowest-priority grant is burned first. */
  it("allocates by priority ('priority')", async () => {
    const { service, store } = makeService({ burnOrder: 'priority' })
    const high = await service.grant(REF, { amountNanoUsd: 50n, priority: 1, idempotencyKey: 'g-hi', reason: 'a' })
    await service.grant(REF, { amountNanoUsd: 50n, priority: 5, idempotencyKey: 'g-lo', reason: 'b' })
    const debit = await service.debit(REF, { amountNanoUsd: 20n, idempotencyKey: 'd1', reason: 'x' })
    expect(store.allocationsOf(debit.id)).toEqual([{ debitEntryId: debit.id, grantEntryId: high.id, amountNanoUsd: 20n }])
  })

  /** With 'fifo' order, the first-created grant is burned first. */
  it("allocates first-created first ('fifo')", async () => {
    const { service, store } = makeService({ burnOrder: 'fifo' })
    const first = await service.grant(REF, { amountNanoUsd: 50n, idempotencyKey: 'g-1', reason: 'a' })
    await service.grant(REF, { amountNanoUsd: 50n, idempotencyKey: 'g-2', reason: 'b' })
    const debit = await service.debit(REF, { amountNanoUsd: 20n, idempotencyKey: 'd1', reason: 'x' })
    expect(store.allocationsOf(debit.id)).toEqual([{ debitEntryId: debit.id, grantEntryId: first.id, amountNanoUsd: 20n }])
  })

  /** A debit spanning two grants creates two allocations summing to the debit. */
  it('splits a debit across two grants', async () => {
    const { service, store } = makeService()
    await service.grant(REF, { amountNanoUsd: 20n, expiresAt: new Date('2027-01-01T00:00:00.000Z'), idempotencyKey: 'g-1', reason: 'a' })
    await service.grant(REF, { amountNanoUsd: 20n, expiresAt: new Date('2030-01-01T00:00:00.000Z'), idempotencyKey: 'g-2', reason: 'b' })
    const debit = await service.debit(REF, { amountNanoUsd: 30n, idempotencyKey: 'd1', reason: 'x' })
    const trail = store.allocationsOf(debit.id)
    expect(trail).toHaveLength(2)
    expect(trail.reduce((sum, a) => sum + a.amountNanoUsd, 0n)).toBe(30n)
  })

  /** An expired grant with a remainder is negated by an exact expiry entry and excluded from allocation. */
  it('writes a lazy expiry entry negating the unspent remainder', async () => {
    let clock = new Date('2026-06-01T00:00:00.000Z')
    const { service, store } = makeService({ now: () => clock })
    const effectiveAt = new Date('2026-05-01T00:00:00.000Z')
    const expiring = await service.grant(REF, { amountNanoUsd: 100n, effectiveAt, expiresAt: new Date('2026-07-01T00:00:00.000Z'), idempotencyKey: 'g-exp', reason: 'a' })
    const fresh = await service.grant(REF, { amountNanoUsd: 100n, effectiveAt, idempotencyKey: 'g-fresh', reason: 'b' })
    await service.debit(REF, { amountNanoUsd: 30n, idempotencyKey: 'd1', reason: 'x' }) // burns the expiring grant first
    clock = new Date('2026-08-01T00:00:00.000Z')
    const debit = await service.debit(REF, { amountNanoUsd: 10n, idempotencyKey: 'd2', reason: 'y' })
    const expiryEntry = store.entriesOf(REF).find((entry) => entry.type === 'expiry')
    expect(expiryEntry?.amountNanoUsd).toBe(-70n)
    expect(store.allocationsOf(debit.id)).toEqual([{ debitEntryId: debit.id, grantEntryId: fresh.id, amountNanoUsd: 10n }])
    expect(store.allocationsOf(debit.id).some((a) => a.grantEntryId === expiring.id)).toBe(false)
  })

  /** A refund after expiry restores balance without resurrecting the expired grant. */
  it('refund does not resurrect an expired grant', async () => {
    let clock = new Date('2026-06-01T00:00:00.000Z')
    const { service, store } = makeService({ now: () => clock })
    const effectiveAt = new Date('2026-05-01T00:00:00.000Z')
    const expiring = await service.grant(REF, { amountNanoUsd: 100n, effectiveAt, expiresAt: new Date('2026-07-01T00:00:00.000Z'), idempotencyKey: 'g-exp', reason: 'a' })
    await service.grant(REF, { amountNanoUsd: 100n, effectiveAt, idempotencyKey: 'g-fresh', reason: 'b' })
    clock = new Date('2026-08-01T00:00:00.000Z')
    await service.debit(REF, { amountNanoUsd: 10n, idempotencyKey: 'd1', reason: 'x' }) // sweeps the expired grant
    await service.refund(REF, { amountNanoUsd: 40n, idempotencyKey: 'r1', reason: 'goodwill' })
    const open = await store.openGrants(REF, 'expiry')
    expect(open.some((grant) => grant.id === expiring.id)).toBe(false)
    expect((await service.getBalance(REF)).nanoUsd).toBe(130n) // 100 fresh − 10 debit + 40 refund
  })
})

runWalletStoreContract('in-memory fake', () => {
  // An injected clock stamps every entry's persisted append instant deterministically, so the
  // balance-contribution decision never depends on the wall clock at read time; `advance` moves it.
  let clock = new Date('2026-06-15T00:00:00.000Z')
  const store = new InMemoryWalletStore({ now: () => clock })
  return {
    store,
    skew: (ref, value): Promise<void> => {
      store.forceBalance(ref, value)
      return Promise.resolve()
    },
    now: (): Promise<Date> => Promise.resolve(clock),
    advance: (ms): Promise<void> => {
      clock = new Date(clock.getTime() + ms)
      return Promise.resolve()
    },
  }
})

/** The wallet-missing signal is structurally branded for cross-bundle detection. */
describe('WalletMissingError', () => {
  it('brands the missing-wallet signal', () => {
    expect(new WalletMissingError().isWalletMissing).toBe(true)
  })
})

describe('WalletService.refund — restore to the source grants', () => {
  const start = new Date('2030-01-01T00:00:00.000Z')

  /** A service over a pinned clock, with two grants burned by a host debit of 150 under usage id `u-1`. */
  async function burned(): Promise<{ service: WalletService; store: InMemoryWalletStore; debit: WalletEntry }> {
    const { service, store } = makeService({ now: () => start })
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g1', reason: 'g', expiresAt: new Date('2031-01-01T00:00:00.000Z') })
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g2', reason: 'g', expiresAt: new Date('2032-01-01T00:00:00.000Z') })
    const debit = await service.debit(REF, { amountNanoUsd: 150n, usageRecordId: 'u-1', idempotencyKey: 'd1', reason: 'd' })
    return { service, store, debit }
  }

  /** Restoring to the source puts the amount back on the burned grants and leaves the entry linked to its debit. */
  it('restores the burned grants and links the refund to the debit', async () => {
    const { service, store, debit } = await burned()
    const refund = await service.refund(REF, { amountNanoUsd: 90n, usageRecordId: 'u-1', idempotencyKey: 'r1', reason: 'r', restore: 'source' })
    expect(refund.refundsEntryId).toBe(debit.id)
    expect((await store.openGrants(REF, 'fifo', start)).map((grant) => grant.remainingNanoUsd).sort()).toEqual([60n, 80n])
    expect((await service.getBalance(REF)).nanoUsd).toBe(140n)
  })

  /** A named debit is passed to the store as given. */
  it('restores the debit named by id', async () => {
    const { service, debit } = await burned()
    const refund = await service.refund(REF, { amountNanoUsd: 10n, idempotencyKey: 'r1', reason: 'r', restore: 'source', debitEntryId: debit.id })
    expect(refund.refundsEntryId).toBe(debit.id)
  })

  /** The default refund is unallocated: no link to a debit and no allocation. */
  it.each([undefined, 'unallocated' as const])('keeps the unallocated refund when restore is %s', async (restore) => {
    const { service, store } = await burned()
    const refund = await service.refund(REF, { amountNanoUsd: 90n, idempotencyKey: 'r1', reason: 'r', ...(restore === undefined ? {} : { restore }) })
    expect(refund.refundsEntryId).toBeUndefined()
    expect(store.allocationsOf(refund.id)).toEqual([])
  })

  /** A debitEntryId names the debit to restore, so without restore: 'source' it contradicts the call and is refused. */
  it.each([undefined, 'unallocated' as const])('refuses a debitEntryId when restore is %s', async (restore) => {
    const { service, debit } = await burned()
    await expectRejectCode(
      service.refund(REF, { amountNanoUsd: 1n, idempotencyKey: 'r1', reason: 'r', debitEntryId: debit.id, ...(restore === undefined ? {} : { restore }) }),
      'AI_TOKENS_INVALID_CONFIG',
    )
    expect((await service.getBalance(REF)).nanoUsd).toBe(50n)
  })

  /** An unknown restore mode is refused rather than read as the default. */
  it('refuses a restore mode it does not know', async () => {
    const { service } = await burned()
    await expectRejectCode(service.refund(REF, { amountNanoUsd: 1n, idempotencyKey: 'r1', reason: 'r', restore: 'sourse' as never }), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** A store without refundToSource makes the call fail; it never becomes an unallocated refund. */
  it('refuses restore source on a store that cannot do it, and writes nothing', async () => {
    const { store } = makeService()
    const bare = { getWallet: store.getWallet.bind(store), appendEntry: jest.fn(), conditionalDebit: jest.fn(), openGrants: jest.fn(), listEntries: jest.fn(), reconcile: jest.fn() } as unknown as IWalletStore
    const service = new WalletService(bare, OPTIONS)
    await expectRejectCode(service.refund(REF, { amountNanoUsd: 1n, idempotencyKey: 'r1', reason: 'r', restore: 'source' }), 'AI_TOKENS_INVALID_CONFIG')
    expect(bare.appendEntry).not.toHaveBeenCalled()
  })
})

describe('WalletService.getBalance and getBalanceBreakdown with an instant', () => {
  const start = new Date('2030-01-01T00:00:00.000Z')

  /** No options: the balance is the materialized one, with no asOf on the answer and no call to `balanceAt`. */
  it('answers a call without options from the materialized balance, with no asOf', async () => {
    const { service, store } = makeService({ now: () => start })
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g', reason: 'g' })
    const spy = jest.spyOn(store, 'balanceAt')
    expect(await service.getBalance(REF)).toEqual({ nanoUsd: 100n, credits: 1e-7 })
    expect(spy).not.toHaveBeenCalled()
  })

  /** With options, asOf defaults to now; an instant up to 5 s behind is evaluated at now; the answer says which was used. */
  it.each([
    ['no asOf', undefined, start],
    ['an asOf 4 s behind', new Date(start.getTime() - 4000), start],
    ['an asOf ahead', new Date(start.getTime() + 60_000), new Date(start.getTime() + 60_000)],
  ] as const)('evaluates at the instant for %s', async (_name, asOf, used) => {
    const { service } = makeService({ now: () => start })
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'g', reason: 'g' })
    const balance = await service.getBalance(REF, asOf === undefined ? {} : { asOf })
    expect(balance.asOf).toEqual(used)
    expect(balance.nanoUsd).toBe(100n)
  })

  /** An instant further behind than the tolerance is refused: nothing answers for the past. */
  it('refuses an asOf more than 5 seconds behind now', async () => {
    const { service } = makeService({ now: () => start })
    await expectRejectCode(service.getBalance(REF, { asOf: new Date(start.getTime() - 5001) }), 'AI_TOKENS_INVALID_CONFIG')
    await expectRejectCode(service.getBalanceBreakdown(REF, { asOf: new Date(start.getTime() - 60_000) }), 'AI_TOKENS_INVALID_CONFIG')
    await expectRejectCode(service.getBalance(REF, { asOf: new Date('nope') }), 'AI_TOKENS_INVALID_CONFIG')
  })

  /** A grant not yet effective is out, a due one is in, and the breakdown agrees with the total. */
  it('counts what could be spent at the instant: pending out, due in', async () => {
    const { service } = makeService({ now: () => start })
    await service.grant(REF, { amountNanoUsd: 100n, idempotencyKey: 'live', reason: 'g' })
    await service.grant(REF, { amountNanoUsd: 40n, idempotencyKey: 'later', reason: 'g', effectiveAt: new Date(start.getTime() + 3_600_000) })
    expect((await service.getBalance(REF, {})).nanoUsd).toBe(100n)
    const ahead = new Date(start.getTime() + 7_200_000)
    const breakdown = await service.getBalanceBreakdown(REF, { asOf: ahead })
    expect(breakdown.nanoUsd).toBe(140n)
    expect(breakdown.buckets.map((bucket) => bucket.remainingNanoUsd).sort()).toEqual([100n, 40n])
    expect(breakdown.unallocatedNanoUsd).toBe(0n)
    expect(breakdown.asOf).toEqual(ahead)
  })

  /** A bucket carries its expiry and reason only when the store reported them. */
  it('maps a bucket with and without an expiry and a reason', async () => {
    const expiresAt = new Date(start.getTime() + 1000)
    const store = {
      getWallet: jest.fn(),
      balanceBreakdown: jest.fn().mockResolvedValue({
        asOf: start,
        nanoUsd: 3_000_000_000n,
        unallocatedNanoUsd: 0n,
        buckets: [
          { grantEntryId: 'a', remainingNanoUsd: 1_000_000_000n, priority: 0, expiresAt, reason: 'why' },
          { grantEntryId: 'b', remainingNanoUsd: 2_000_000_000n, priority: 1 },
        ],
      }),
    } as unknown as IWalletStore
    const found = await new WalletService(store, OPTIONS, undefined, () => start).getBalanceBreakdown(REF)
    expect(found.buckets).toEqual([
      { grantEntryId: 'a', remainingNanoUsd: 1_000_000_000n, remainingCredits: 1, priority: 0, expiresAt, reason: 'why' },
      { grantEntryId: 'b', remainingNanoUsd: 2_000_000_000n, remainingCredits: 2, priority: 1 },
    ])
  })

  /** A store without the methods is refused with a typed error, never answered from the materialized balance. */
  it('refuses a store without balanceAt or balanceBreakdown', async () => {
    const bare = { getWallet: jest.fn() } as unknown as IWalletStore
    const service = new WalletService(bare, OPTIONS, undefined, () => start)
    await expectRejectCode(service.getBalance(REF, {}), 'AI_TOKENS_INVALID_CONFIG')
    await expectRejectCode(service.getBalanceBreakdown(REF), 'AI_TOKENS_INVALID_CONFIG')
    expect(bare.getWallet).not.toHaveBeenCalled()
  })

  /** A failure of the store on the instant reads, and on the source refund, crosses as a typed error. */
  it.each([
    ['balanceAt', (service: WalletService) => service.getBalance(REF, {})],
    ['balanceBreakdown', (service: WalletService) => service.getBalanceBreakdown(REF)],
    ['refundToSource', (service: WalletService) => service.refund(REF, { amountNanoUsd: 1n, idempotencyKey: 'r1', reason: 'r', restore: 'source' })],
  ] as const)('maps a failure of %s to a typed store error', async (method, call) => {
    const service = new WalletService(throwingStore(method, new Error('driver down')), OPTIONS, undefined, () => start)
    await expectRejectCode(call(service), 'AI_TOKENS_STORE_ERROR')
  })
})
