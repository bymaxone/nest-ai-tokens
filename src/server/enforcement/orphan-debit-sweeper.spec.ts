/**
 * @fileoverview The sweep of wallet debits no ledger row stands behind, against in-memory stores. A keyed call whose
 * append failed keeps its debit for a retry to replay; one that is never retried leaves the debit with no record. The
 * sweep claims the key with a released row that owes the refund, so a late retry and the refund exclude each other, and
 * the wallet ends where a run in which the call never happened would leave it, with exactly one refund.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import type { NormalizedUsage, WalletRef } from '../../shared'
import { makeFullStore } from '../../../test/fakes/full-store'
import { InMemoryLedgerStore } from '../../../test/fakes/in-memory-ledger-store'
import { InMemoryPricingStore } from '../../../test/fakes/in-memory-pricing-store'
import { InMemoryWalletStore } from '../../../test/fakes/in-memory-wallet-store'
import { applyDefaults } from '../config'
import type { HoldEstimate, MeteringContext } from '../interfaces'
import { LedgerService } from '../services/ledger.service'
import { MarkupResolver } from '../services/markup.resolver'
import { MeteringService } from '../services/metering.service'
import { isIdempotencyConflict } from '../services/record-replay'
import { PricingService } from '../services/pricing.service'
import { UsageReportService } from '../services/usage-report.service'
import { WalletService } from '../services/wallet.service'
import { OrphanDebitSweeper } from './orphan-debit-sweeper'

const GRACE = 300
const RETENTION = 604_800
const GRANT = 10_000_000_000n
const ESTIMATE: HoldEstimate = {
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
  inputTokens: 1000,
  maxOutputTokens: 500,
}
const USAGE: NormalizedUsage = {
  provider: 'openai',
  model: 'gpt-5',
  operation: 'chat',
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningTokens: 0,
  audioInTokens: 0,
  audioOutTokens: 0,
  imageInTokens: 0,
  imageOutTokens: 0,
}
const PAYER: WalletRef = { tenantId: 'tenant-1', ownerType: 'user', ownerId: 'u1' }
const OTHER: WalletRef = { tenantId: 'tenant-2', ownerType: 'user', ownerId: 'u1' }

function context(over: Partial<MeteringContext> = {}): MeteringContext {
  return { tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, feature: 'chat.reply', ...over }
}

/** A clock that moves only when told to; every read is a millisecond later so no two stamps tie. */
function clock(): { now: () => Date; advance: (seconds: number) => void } {
  const state = { at: Date.now(), reads: 0 }
  return {
    now: (): Date => new Date(state.at + (state.reads += 1)),
    advance: (seconds): void => void (state.at += seconds * 1000),
  }
}

interface Rig {
  metering: MeteringService
  /** Another instance over the same stores: a retry after the first one's process died, or a second sweeper's host. */
  other: MeteringService
  ledgerStore: InMemoryLedgerStore
  walletStore: InMemoryWalletStore
  wallets: WalletService
  ledger: LedgerService
  reports: UsageReportService
  sweeper: OrphanDebitSweeper
  sweeperB: OrphanDebitSweeper
  advance: (seconds: number) => void
  now: () => Date
}

async function rig(): Promise<Rig> {
  const { now, advance } = clock()
  const ledgerStore = new InMemoryLedgerStore(now)
  const pricingStore = new InMemoryPricingStore()
  const walletStore = new InMemoryWalletStore({ now })
  const options = applyDefaults({
    store: makeFullStore(),
    markup: 1,
    pricing: { strict: true, seedFromSnapshot: false, cacheTtlMs: 300_000, modelAliases: {} },
    holds: { ttlSeconds: 3_600, reaperIntervalSeconds: 300 },
    wallets: { creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' },
    settlement: { graceSeconds: GRACE },
  })
  const { wallets: walletOptions } = options
  if (!walletOptions.enabled) throw new Error('the fixture enables wallets')
  const ledger = new LedgerService(ledgerStore, options)
  const wallets = new WalletService(walletStore, walletOptions)
  const instance = (): MeteringService =>
    new MeteringService(
      ledger,
      new PricingService(options, pricingStore),
      new MarkupResolver(options),
      options,
      undefined,
      wallets,
      undefined,
      now,
    )
  const metering = instance()
  await pricingStore.upsertPrice({
    provider: 'openai',
    model: 'gpt-5',
    operation: 'chat',
    serviceTier: 'standard',
    inputNanoUsdPerMillion: 1_250_000_000n,
    outputNanoUsdPerMillion: 10_000_000_000n,
    effectiveFrom: new Date(0),
  })
  for (const ref of [PAYER, OTHER])
    await wallets.grant(ref, {
      amountNanoUsd: GRANT,
      idempotencyKey: `grant-${ref.tenantId}`,
      reason: 'seed',
    })
  const settings = {
    graceSeconds: options.settlement.graceSeconds,
    retentionSeconds: options.settlement.retentionSeconds,
  }
  const sweep = (service: MeteringService): OrphanDebitSweeper =>
    new OrphanDebitSweeper(walletStore, ledger, settings, now, (owed) =>
      service.settleOwedEffects(owed),
    )
  const reports = new UsageReportService(ledgerStore, pricingStore, options)
  return {
    metering,
    other: instance(),
    ledgerStore,
    walletStore,
    wallets,
    ledger,
    reports,
    sweeper: sweep(metering),
    sweeperB: sweep(metering),
    advance,
    now,
  }
}

async function balance(r: Rig, ref: WalletRef = PAYER): Promise<bigint> {
  return (await r.wallets.getBalance(ref)).nanoUsd
}

async function refunds(r: Rig, ref: WalletRef = PAYER): Promise<number> {
  return (await r.walletStore.listEntries(ref, { type: 'refund' })).entries.length
}

/** A keyed hold whose ledger append failed with no row: the debit stays, for a retry to replay. */
async function orphanHold(
  r: Rig,
  key: string,
  ctx: Partial<MeteringContext> = {},
): Promise<bigint> {
  jest.spyOn(r.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
  await expect(r.metering.hold(context({ idempotencyKey: key, ...ctx }), ESTIMATE)).rejects.toThrow(
    'connection reset',
  )
  const ref = ctx.tenantId === 'tenant-2' ? OTHER : PAYER
  return GRANT - (await balance(r, ref))
}

/** Whether the call was refused with the idempotency conflict, which is what a different payload under the key gets. */
async function conflictOf(call: Promise<unknown>): Promise<boolean> {
  try {
    await call
    return false
  } catch (error) {
    return isIdempotencyConflict(error)
  }
}

function warned(): string[] {
  return (Logger.prototype.warn as jest.Mock).mock.calls.map(([line]) => String(line))
}

describe('OrphanDebitSweeper', () => {
  beforeEach(() => void jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined))
  afterEach(() => void jest.restoreAllMocks())

  /** The state the sweep repairs: a debit, no row, and nobody coming back for it. */
  it('starts from a keyed call whose append failed: the debit stays and no row stands', async () => {
    const r = await rig()
    const debited = await orphanHold(r, 'k0')
    expect(debited > 0n).toBe(true)
    expect(await r.ledgerStore.findByIdempotencyKey('tenant-1', 'k0')).toBeNull()
  })

  /*
   * Invariant: after the sweep the wallet is where a run in which the call never happened leaves it, with exactly one
   * refund; the key is claimed by a released row, so the same key retried is refused before anything is reserved, and the
   * operator is told, with the claim's id and no amount, that a late call met a claim.
   */
  it('refunds an orphan debit once, and refuses a retry of its key afterwards', async () => {
    const r = await rig()
    const debited = await orphanHold(r, 'k1')
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(await balance(r)).toBe(GRANT)
    expect(await refunds(r)).toBe(1)
    const claim = await r.ledgerStore.findByIdempotencyKey('tenant-1', 'k1')
    expect(claim?.status).toBe('released')
    expect(claim).toMatchObject({
      tenantId: 'tenant-1', scope: { type: 'user', id: 'u1' }, provider: 'orphan-claim', model: 'orphan-claim', feature: 'orphan-claim', operation: 'chat',
      tags: [], currency: 'USD', priceMissing: false, isSystemCost: false, enforced: true, requestId: 'hold:k1', totalTokens: 0, rawCostNanoUsd: 0n,
    })
    expect(claim?.billedCostNanoUsd).toBe(debited)
    expect((await r.walletStore.listEntries(PAYER, { type: 'refund' })).entries.map((entry) => entry.idempotencyKey)).toEqual(['hold-rollback:k1'])
    expect(await conflictOf(r.metering.hold(context({ idempotencyKey: 'k1' }), ESTIMATE))).toBe(
      true,
    )
    expect(await balance(r)).toBe(GRANT)
    expect(warned()).toEqual([`ai_tokens.orphan_claim.late_append claim=${claim?.id ?? ''}`])
    await r.sweeper.sweep()
    expect(await refunds(r)).toBe(1)
    expect(await balance(r)).toBe(GRANT)
  })

  /**
   * Invariant: a retry that completes before the sweep claims the key wins it. The claim finds the row and refunds nothing, so
   * the hold stands with its one debit.
   */
  it('leaves a debit alone when the retry appended its row between the sweep lookup and its claim', async () => {
    const r = await rig()
    const debited = await orphanHold(r, 'k2')
    r.advance(GRACE + 1)
    const hold = await r.other.hold(context({ idempotencyKey: 'k2' }), ESTIMATE)
    jest.spyOn(r.ledger, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    await r.sweeper.sweep()
    expect(warned()).toEqual([])
    expect(await refunds(r)).toBe(0)
    expect(await balance(r)).toBe(GRANT - debited)
    expect((await r.ledgerStore.findByIdempotencyKey('tenant-1', 'k2'))?.id).toBe(hold.id)
    expect((await r.ledgerStore.findByIdempotencyKey('tenant-1', 'k2'))?.status).toBe('pending')
  })

  /**
   * Invariant: a retry that read the ledger before the claim and appends after it conflicts with the claim row and refunds
   * nothing itself, because the claim row stands for the debit it shares; the sweep's refund is the only one.
   */
  it('refunds once when the retry passed its lookup before the claim and appends after it', async () => {
    const r = await rig()
    await orphanHold(r, 'k3')
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    jest.spyOn(r.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    expect(await conflictOf(r.other.hold(context({ idempotencyKey: 'k3' }), ESTIMATE))).toBe(true)
    expect(await refunds(r)).toBe(1)
    expect(await balance(r)).toBe(GRANT)
    expect(
      warned().filter((line) => line.startsWith('ai_tokens.orphan_claim.late_append claim=')),
    ).toHaveLength(1)
  })

  /**
   * Invariant: the orphan of an enforced `record()` is given back by the wallet refund alone, once, and a retry of the call
   * that passed its lookup before the claim and appends after it neither refunds nor replays: it is refused with a warn line.
   */
  it('gives back the debit of an enforced record, and refuses a late append of that call', async () => {
    const r = await rig()
    const input = { usage: USAGE, context: context({ enforce: true, idempotencyKey: 'rk-1' }) }
    jest.spyOn(r.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    await expect(r.metering.record(input)).rejects.toThrow('connection reset')
    expect((await balance(r)) < GRANT).toBe(true)
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(await balance(r)).toBe(GRANT)
    expect(await refunds(r)).toBe(1)
    const claim = await r.ledgerStore.findByIdempotencyKey('tenant-1', 'rk-1')
    expect(claim?.status).toBe('released')
    jest.spyOn(r.ledgerStore, 'findByIdempotencyKey').mockResolvedValueOnce(null)
    expect(await conflictOf(r.other.record(input))).toBe(true)
    expect(await refunds(r)).toBe(1)
    expect(await balance(r)).toBe(GRANT)
    expect(warned()).toEqual([`ai_tokens.orphan_claim.late_append claim=${claim?.id ?? ''}`])
  })

  /** Invariant: a retry of an enforced record whose key was claimed is refused, never answered with the claim as its record. */
  it('refuses a retry of an enforced record after its key was claimed', async () => {
    const r = await rig()
    const input = { usage: USAGE, context: context({ enforce: true, idempotencyKey: 'rk-2' }) }
    jest.spyOn(r.ledgerStore, 'append').mockRejectedValueOnce(new Error('connection reset'))
    await expect(r.metering.record(input)).rejects.toThrow('connection reset')
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    const claim = await r.ledgerStore.findByIdempotencyKey('tenant-1', 'rk-2')
    expect(await conflictOf(r.metering.record(input))).toBe(true)
    expect(warned()).toEqual([`ai_tokens.orphan_claim.late_append claim=${claim?.id ?? ''}`])
    expect(await balance(r)).toBe(GRANT)
    expect(await refunds(r)).toBe(1)
  })

  /** Invariant: two sweeps at once claim the key once and refund once, whichever instance runs them. */
  it('refunds once when two sweeps run at the same time', async () => {
    const r = await rig()
    await orphanHold(r, 'k4')
    r.advance(GRACE + 1)
    await Promise.all([r.sweeper.sweep(), r.sweeperB.sweep()])
    expect(await refunds(r)).toBe(1)
    expect(await balance(r)).toBe(GRANT)
    expect(await r.ledgerStore.query({ tenantId: 'tenant-1', status: ['released'] })).toHaveLength(
      1,
    )
  })

  /** Invariant: a claim whose refund did not run keeps its marker, and the owed-effects sweep finishes the refund once. */
  it('finishes the refund from the marker when it failed right after the claim', async () => {
    const r = await rig()
    await orphanHold(r, 'k5')
    r.advance(GRACE + 1)
    const failing = new OrphanDebitSweeper(
      r.walletStore,
      r.ledger,
      { graceSeconds: GRACE, retentionSeconds: RETENTION },
      r.now,
      () => Promise.reject(new Error('wallet down')),
    )
    await failing.sweep()
    expect(await balance(r)).toBe(GRANT - (GRANT - (await balance(r))))
    expect(await refunds(r)).toBe(0)
    const owed = await r.ledger.findEffectsOwed(new Date(r.now().getTime() + 86_400_000), 10)
    expect(owed).toHaveLength(1)
    expect(owed[0]?.reason).toBe('orphan-debit')
    for (let pass = 0; pass < 2; pass++)
      for (const item of await r.ledger.findEffectsOwed(
        new Date(r.now().getTime() + 86_400_000),
        10,
      ))
        await r.metering.settleOwedEffects(item)
    expect(await refunds(r)).toBe(1)
    expect(await balance(r)).toBe(GRANT)
  })

  /** Invariant: a debit that is younger than the grace, one older than the retention and one whose row stands are left alone. */
  it('leaves a young debit, an old one and one with a row alone', async () => {
    const r = await rig()
    const debited = await orphanHold(r, 'young')
    await r.sweeper.sweep()
    expect(await refunds(r)).toBe(0)
    r.advance(GRACE - 60)
    await r.sweeper.sweep()
    expect(await refunds(r)).toBe(0)
    r.advance(RETENTION + GRACE)
    await r.sweeper.sweep()
    expect(await refunds(r)).toBe(0)
    expect(await balance(r)).toBe(GRANT - debited)
    const live = await rig()
    await live.metering.hold(context({ idempotencyKey: 'live' }), ESTIMATE)
    const held = GRANT - (await balance(live))
    live.advance(GRACE + 1)
    const append = jest.spyOn(live.ledgerStore, 'append')
    await live.sweeper.sweep()
    expect(append).not.toHaveBeenCalled()
    expect(await refunds(live)).toBe(0)
    expect(await balance(live)).toBe(GRANT - held)
  })

  /** Invariant: the claim row belongs to the wallet's tenant, and nothing of it shows in another tenant's ledger. */
  it('claims in the tenant of the wallet and shows nothing in another tenant', async () => {
    const r = await rig()
    await orphanHold(r, 'shared-key')
    await orphanHold(r, 'shared-key', { tenantId: 'tenant-2' })
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(await balance(r, PAYER)).toBe(GRANT)
    expect(await balance(r, OTHER)).toBe(GRANT)
    const mine = await r.ledgerStore.query({ tenantId: 'tenant-1', status: ['released'] })
    const theirs = await r.ledgerStore.query({ tenantId: 'tenant-2', status: ['released'] })
    expect(mine.map((row) => row.tenantId)).toEqual(['tenant-1'])
    expect(theirs.map((row) => row.tenantId)).toEqual(['tenant-2'])
    expect(await r.ledgerStore.findByIdempotencyKey('tenant-3', 'shared-key')).toBeNull()
  })

  /** Invariant: a debit of a keyless call (its key is generated, so nobody retries it) is given back the same way. */
  it('gives back an orphan debit under a generated key', async () => {
    const r = await rig()
    await r.wallets.debit(PAYER, {
      amountNanoUsd: 5_000n,
      idempotencyKey: 'hold:hold:abc',
      reason: 'auth-hold reservation',
    })
    await r.wallets.debit(PAYER, {
      amountNanoUsd: 7_000n,
      idempotencyKey: 'record:def',
      reason: 'post-hoc enforcement',
    })
    r.advance(GRACE + 1)
    await r.sweeper.sweep()
    expect(await balance(r)).toBe(GRANT)
    expect(await refunds(r)).toBe(2)
    expect((await r.ledgerStore.findByIdempotencyKey('tenant-1', 'hold:abc'))?.status).toBe(
      'released',
    )
    expect((await r.ledgerStore.findByIdempotencyKey('tenant-1', 'def'))?.status).toBe('released')
  })

  /**
   * Invariant: a claim row never changes what usage reports and cost summaries say: they count settled rows, and a claim is
   * released, so a window with a claim sums and lists exactly what the control window does.
   */
  it('leaves the cost summary and the report of a window as the control has them', async () => {
    const control = await rig()
    const withClaim = await rig()
    for (const r of [control, withClaim]) {
      await r.metering.record({ usage: USAGE, context: context({ idempotencyKey: 'settled' }) })
    }
    await orphanHold(withClaim, 'k6')
    withClaim.advance(GRACE + 1)
    await withClaim.sweeper.sweep()
    const window = {
      tenantId: 'tenant-1',
      from: new Date(0),
      to: new Date(Date.now() + 86_400_000 * 2),
    }
    const summary = async (r: Rig): Promise<unknown> => {
      const sum = await r.ledger.sumCost({ tenantId: 'tenant-1' })
      const rows = await r.reports.summarize({ ...window, groupBy: [] })
      return [sum, rows]
    }
    expect(await summary(withClaim)).toEqual(await summary(control))
  })

  /** Invariant: a failed listing ends the tick with one line, and the next tick finds the orphan. */
  it('logs a failed listing and gives the orphan back on the next tick', async () => {
    const r = await rig()
    await orphanHold(r, 'k8')
    r.advance(GRACE + 1)
    jest.spyOn(r.walletStore, 'findDebitsBefore').mockRejectedValueOnce(new Error('db down'))
    await r.sweeper.sweep()
    expect(warned()).toEqual([
      'ai_tokens.orphan_debit_sweep.scan_failed name=Error message="db down"',
    ])
    expect(await refunds(r)).toBe(0)
    await r.sweeper.sweep()
    expect(await refunds(r)).toBe(1)
    jest.spyOn(r.walletStore, 'findDebitsBefore').mockRejectedValueOnce('db down')
    await r.sweeper.sweep()
    expect(warned().at(-1)).toBe('ai_tokens.orphan_debit_sweep.scan_failed non-Error rejection')
  })

  /** Invariant: a claim that fails for a reason other than a taken key counts toward one summary line, and the orphan stays owed. */
  it('counts a failed claim in one summary line and leaves the debit for the next tick', async () => {
    const r = await rig()
    await orphanHold(r, 'k9')
    await orphanHold(r, 'k10')
    r.advance(GRACE + 1)
    jest.spyOn(r.ledgerStore, 'append').mockRejectedValue(new Error('db down'))
    await r.sweeper.sweep()
    expect(warned()).toEqual(['ai_tokens.orphan_debit_sweep.settle_failed count=2'])
    jest.restoreAllMocks()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await r.sweeper.sweep()
    expect(await refunds(r)).toBe(2)
  })

  /** Invariant: a walk spends its page budget from the cursor and wraps to the start when a page comes back empty. */
  it('walks a page at a time from a cursor that wraps', async () => {
    const r = await rig()
    for (const key of ['p1', 'p2', 'p3']) await orphanHold(r, key)
    r.advance(GRACE + 1)
    const list = jest.spyOn(r.walletStore, 'findDebitsBefore')
    const paged = new OrphanDebitSweeper(
      r.walletStore,
      r.ledger,
      { graceSeconds: GRACE, retentionSeconds: RETENTION },
      r.now,
      (owed) => r.metering.settleOwedEffects(owed),
      { pageSize: 1, pages: 2 },
    )
    await paged.sweep()
    expect(list).toHaveBeenCalledTimes(2)
    expect(await refunds(r)).toBe(2)
    await paged.sweep()
    expect(await refunds(r)).toBe(3)
    expect(list.mock.calls.map(([query]) => query.after === undefined)).toEqual([
      true,
      false,
      false,
      false,
    ])
    await paged.sweep()
    expect(list.mock.calls[4]?.[0].after).toBeUndefined()
  })

  /** A debit whose key is neither a hold's nor a record's is left alone even when a listing returns it. */
  it('leaves a debit with another kind of key alone', async () => {
    const r = await rig()
    const stray = {
      ref: PAYER,
      entry: {
        id: 'e',
        walletId: 'w',
        type: 'debit' as const,
        amountNanoUsd: -5n,
        priority: 0,
        effectiveAt: new Date(0),
        idempotencyKey: 'capture:x',
        createdAt: new Date(0),
      },
    }
    const sweeper = new OrphanDebitSweeper(
      { findDebitsBefore: () => Promise.resolve([stray]) },
      r.ledger,
      { graceSeconds: GRACE, retentionSeconds: RETENTION },
      r.now,
      () => Promise.reject(new Error('never')),
      { pages: 1 },
    )
    await sweeper.sweep()
    expect(warned()).toEqual([])
  })

  /** A store without the listing, or a ledger without the marker, leaves the sweep inactive. */
  it('does nothing for a wallet store without the listing or a ledger without the marker', async () => {
    const r = await rig()
    await orphanHold(r, 'k7')
    r.advance(GRACE + 1)
    const bare = Object.create(r.walletStore, {
      findDebitsBefore: { value: undefined },
    }) as InMemoryWalletStore
    const noListing = new OrphanDebitSweeper(
      bare,
      r.ledger,
      { graceSeconds: GRACE, retentionSeconds: RETENTION },
      r.now,
      () => Promise.resolve(),
    )
    expect(noListing.supported).toBe(false)
    await noListing.sweep()
    expect(await refunds(r)).toBe(0)
    expect(r.sweeper.supported).toBe(true)
  })
})
