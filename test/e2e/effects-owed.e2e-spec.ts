/**
 * @fileoverview E2E on PostgreSQL 16: the effects-owed marker of migration 0003, kept in its own table beside the
 * ledger. The marker is written by the same statement as the write it belongs to, a capture keeps the reserved amount and
 * tokens, a write that matches no row leaves no marker, the sweep's query finds only the rows that owe effects and the
 * delete of a marker is idempotent, the ledger table gains no column, the migration is additive and reversible (up, down
 * and up again, with the data kept), and a full sweep over the real store finishes what a failed capture left, once, with
 * two sweepers at once.
 * @layer test
 */

import type { NewUsageRecord } from '@bymax-one/nest-ai-tokens/shared'
import { bootMeteringModule, e2eContext, e2eUsage, grantWallet, seedPrice, startPostgres, upsertBudget, E2E_WALLET, type Booted, type PostgresFixture } from './harness'
import { migrationSqlStartingWith } from './migration-files'

let pg: PostgresFixture
beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)
afterAll(async () => {
  await pg.stop()
})

/** A complete `NewUsageRecord`; `over` replaces any field under test. */
function record(over: Partial<NewUsageRecord> = {}): NewUsageRecord {
  return {
    tenantId: 'owed-t', scope: { type: 'user', id: 'u1' }, provider: 'openai', model: 'gpt-5', operation: 'chat',
    serviceTier: 'standard', feature: 'chat.reply', tags: [], inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0,
    cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, audioInTokens: 0, audioOutTokens: 0,
    imageInTokens: 0, imageOutTokens: 0, totalTokens: 1500, priceVersionId: null, rawCostNanoUsd: 6_250_000n,
    surchargeNanoUsd: 0n, billedCostNanoUsd: 25_000_000n, markupMultiplier: 4, currency: 'USD', priceMissing: false,
    status: 'pending', idempotencyKey: 'k', isSystemCost: false, enforced: true, occurredAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  }
}

/** The marker row of a ledger row, with the ledger row's own `updatedAt`, or `undefined` when nothing is owed. */
async function markerOf(id: string): Promise<{ owedAt: Date; reservedBilledNanoUsd: bigint | null; reservedTokens: number | null; tenantId: string; updatedAt: Date } | undefined> {
  const rows = await pg.prisma.$queryRawUnsafe<{ owedAt: Date; reservedBilledNanoUsd: bigint | null; reservedTokens: number | null; tenantId: string; updatedAt: Date }[]>(
    'SELECT o."owedAt", o."reservedBilledNanoUsd", o."reservedTokens", o."tenantId", r."updatedAt" FROM ai_usage_effects_owed o JOIN ai_usage_records r ON r.id = o."recordId" WHERE o."recordId" = $1', id)
  return rows[0]
}

const FUTURE = (): Date => new Date(Date.now() + 3_600_000)

describe('the effects-owed marker in PostgreSQL', () => {
  /** A capture's transition writes the marker and the reserved values in its own statement, and the row reads them back as bigint. */
  it('writes the marker with the transition and reads the reserved values back', async () => {
    const hold = await pg.store.append(record({ idempotencyKey: 'capture-1' }), 'h')
    const posted = await pg.store.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 10_000_000n }, false, { reservedBilledNanoUsd: 25_000_000n, reservedTokens: 1500 })
    expect(posted?.status).toBe('posted')
    const marker = await markerOf(hold.id)
    expect(marker).toBeDefined()
    expect(marker?.tenantId).toBe('owed-t')
    expect(marker?.owedAt.getTime()).toBe(marker?.updatedAt.getTime())
    const owed = (await pg.store.findEffectsOwed?.(FUTURE(), 100))?.find((item) => item.record.id === hold.id)
    expect(owed?.reservedBilledNanoUsd).toBe(25_000_000n)
    expect(owed?.reservedTokens).toBe(1500)
    expect(owed?.record.billedCostNanoUsd).toBe(10_000_000n)
  })

  /** A transition without the marker leaves the row owing nothing, so the existing callers are unchanged. */
  it('leaves a row without a marker when the write names none', async () => {
    const hold = await pg.store.append(record({ idempotencyKey: 'plain-1' }), 'h')
    await pg.store.transition(hold.id, 'pending', 'released')
    expect(await markerOf(hold.id)).toBeUndefined()
    expect((await pg.store.findEffectsOwed?.(FUTURE(), 100))?.some((item) => item.record.id === hold.id)).toBe(false)
  })

  /** The compensating append of a reversal carries the marker from its own insert. */
  it('writes the marker with an append', async () => {
    const compensating = await pg.store.append(record({ idempotencyKey: 'reverse:x', status: 'posted', reversesRecordId: 'orig' }), 'h', false, {})
    expect(await markerOf(compensating.id)).toBeDefined()
    const owed = (await pg.store.findEffectsOwed?.(FUTURE(), 100))?.find((item) => item.record.id === compensating.id)
    expect(owed?.record.reversesRecordId).toBe('orig')
    expect(owed?.reservedBilledNanoUsd).toBeUndefined()
    expect(owed?.reason).toBeUndefined()
  })

  /** The sweep's query reads only markers older than the cutoff, oldest first, up to the limit; clearing is idempotent. */
  it('lists the owed rows older than the cutoff, oldest first, and clears each once', async () => {
    const ids: string[] = []
    for (const key of ['order-1', 'order-2', 'order-3']) {
      const hold = await pg.store.append(record({ idempotencyKey: key }), 'h')
      await pg.store.transition(hold.id, 'pending', 'released', undefined, false, {})
      ids.push(hold.id)
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    expect((await pg.store.findEffectsOwed?.(new Date(Date.now() - 3_600_000), 100))?.some((item) => ids.includes(item.record.id))).toBe(false)
    const listed = (await pg.store.findEffectsOwed?.(FUTURE(), 100))?.map((item) => item.record.id).filter((id) => ids.includes(id))
    expect(listed).toEqual(ids)
    expect((await pg.store.findEffectsOwed?.(FUTURE(), 1))).toHaveLength(1)
    expect(await pg.store.clearEffectsOwed?.(ids[0] ?? '')).toBe(true)
    expect(await pg.store.clearEffectsOwed?.(ids[0] ?? '')).toBe(false)
    expect(await markerOf(ids[0] ?? '')).toBeUndefined()
  })

  /** The marker of one row is read by its id with what it kept, and is absent once cleared or for a row that owes nothing. */
  it('reads the marker of one row by id', async () => {
    const hold = await pg.store.append(record({ idempotencyKey: 'for-1' }), 'h')
    await pg.store.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 5n }, false, { reservedBilledNanoUsd: 25_000_000n, reservedTokens: 1500 })
    const found = await pg.store.findEffectsOwedFor?.(hold.id)
    expect(found?.reservedBilledNanoUsd).toBe(25_000_000n)
    expect(found?.reservedTokens).toBe(1500)
    expect(found?.record.id).toBe(hold.id)
    expect(await pg.store.findEffectsOwedFor?.('missing')).toBeNull()
    await pg.store.clearEffectsOwed?.(hold.id)
    expect(await pg.store.findEffectsOwedFor?.(hold.id)).toBeNull()
  })

  /** The caller's reason for a reversal rides in the marker and reads back with it, for the sweep to refund with the same payload. */
  it('keeps the reason of a reversal in the marker', async () => {
    const compensating = await pg.store.append(record({ idempotencyKey: 'reverse:reason', status: 'posted', reversesRecordId: 'orig-2' }), 'h', false, { reason: 'customer-dispute' })
    expect((await pg.store.findEffectsOwedFor?.(compensating.id))?.reason).toBe('customer-dispute')
    expect((await pg.store.findEffectsOwed?.(FUTURE(), 100))?.find((item) => item.record.id === compensating.id)?.reason).toBe('customer-dispute')
  })

  /** A write that matches no row leaves no marker: the transition from the wrong state returns null and writes nothing. */
  it('leaves no marker when the transition matched no row', async () => {
    const hold = await pg.store.append(record({ idempotencyKey: 'wrong-state-1' }), 'h')
    await pg.store.transition(hold.id, 'pending', 'released')
    const before = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM ai_usage_effects_owed')
    expect(await pg.store.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 1n }, false, { reservedBilledNanoUsd: 1n, reservedTokens: 1 })).toBeNull()
    const after = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM ai_usage_effects_owed')
    expect(after[0]?.n).toBe(before[0]?.n)
    expect(await markerOf(hold.id)).toBeUndefined()
  })

  /** A hash-chained settlement writes the marker too, in the same transaction as the chain. */
  it('writes the marker of a chained settlement', async () => {
    const hold = await pg.store.append(record({ idempotencyKey: 'chained-1' }), 'h')
    const posted = await pg.store.transition(hold.id, 'pending', 'posted', { billedCostNanoUsd: 5n }, true, { reservedBilledNanoUsd: 25_000_000n, reservedTokens: 1500 })
    expect(posted?.hash).toBeDefined()
    expect((await markerOf(hold.id))?.reservedBilledNanoUsd).toBe(25_000_000n)
  })

  /** The ledger table gains no column, so its only post-posting change is still the annotation of a reversal. */
  it('adds no column to the ledger table', async () => {
    const columns = await pg.prisma.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_usage_records' AND (column_name ILIKE '%owed%' OR column_name ILIKE '%effects%')`)
    expect(columns).toEqual([])
  })
})

describe('migration 0003', () => {
  /** The statements the migration's header documents as its rollback, read from the shipped file. */
  function rollbackStatements(): string[] {
    const file = migrationSqlStartingWith('0003')
    const start = file.indexOf('-- Rollback')
    expect(start).toBeGreaterThan(-1)
    return file
      .slice(start)
      .split('\n')
      .filter((line) => /^--\s{3}DROP/.test(line))
      .map((line) => line.replace(/^--\s+/, '').trim())
      .map((statement) => statement.replace(/;$/, ''))
  }

  /** The additive statements of the migration itself. */
  function upStatements(): string[] {
    const text = migrationSqlStartingWith('0003')
    const from = text.indexOf('CREATE TABLE "ai_usage_effects_owed"')
    expect(from).toBeGreaterThan(-1)
    return text
      .slice(from)
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
  }

  /** The table, its foreign key to the ledger and the index on the oldest-first read exist with the migration. */
  it('creates one table with a foreign key to the ledger and an index on owedAt', async () => {
    const columns = await pg.prisma.$queryRawUnsafe<{ column_name: string; is_nullable: string }[]>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'ai_usage_effects_owed' ORDER BY column_name`)
    expect(columns).toEqual([
      { column_name: 'owedAt', is_nullable: 'NO' },
      { column_name: 'reason', is_nullable: 'YES' },
      { column_name: 'recordId', is_nullable: 'NO' },
      { column_name: 'reservedBilledNanoUsd', is_nullable: 'YES' },
      { column_name: 'reservedTokens', is_nullable: 'YES' },
      { column_name: 'tenantId', is_nullable: 'NO' },
    ])
    const fk = await pg.prisma.$queryRawUnsafe<{ conname: string }[]>(`SELECT conname FROM pg_constraint WHERE conrelid = 'ai_usage_effects_owed'::regclass AND contype = 'f'`)
    expect(fk.map((row) => row.conname)).toEqual(['ai_usage_effects_owed_recordId_fkey'])
    const index = await pg.prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'ai_usage_effects_owed' ORDER BY indexname`)
    expect(index.map((row) => row.indexname)).toEqual(['ai_usage_effects_owed_owedAt_idx', 'ai_usage_effects_owed_pkey'])
  })

  /** Up, down and up again on a database that holds rows: the ledger rows survive each step and the store keeps working after the rollback. */
  it('is reversible with the documented rollback, keeping the ledger rows', async () => {
    const before = await pg.store.append(record({ idempotencyKey: 'cycle-1' }), 'h')
    await pg.store.transition(before.id, 'pending', 'released', undefined, false, {})
    const down = rollbackStatements()
    expect(down.length).toBeGreaterThanOrEqual(1)
    for (const statement of down) await pg.prisma.$executeRawUnsafe(statement)
    const gone = await pg.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'ai_usage_effects_owed'`)
    expect(gone[0]?.n).toBe(0n)
    expect((await pg.prisma.$queryRawUnsafe<{ id: string }[]>('SELECT id FROM ai_usage_records WHERE id = $1', before.id))[0]?.id).toBe(before.id)
    const plain = await pg.store.append(record({ idempotencyKey: 'cycle-plain' }), 'h')
    await pg.store.transition(plain.id, 'pending', 'released')
    for (const statement of upStatements()) await pg.prisma.$executeRawUnsafe(statement)
    expect(await markerOf(before.id)).toBeUndefined()
    const again = await pg.store.append(record({ idempotencyKey: 'cycle-2' }), 'h')
    await pg.store.transition(again.id, 'pending', 'released', undefined, false, {})
    expect(await markerOf(again.id)).toBeDefined()
  })
})

describe('a failed capture over the real store', () => {
  let booted: Booted
  let bootedB: Booted
  beforeAll(async () => {
    booted = await bootMeteringModule({ store: pg.store })
    bootedB = await bootMeteringModule({ store: pg.storeB })
    await seedPrice(booted.pricing)
    await grantWallet(booted.wallets, 10_000_000_000n)
    await upsertBudget(booted.budgets, { id: 'owed-budget', scope: { type: 'user', id: 'u1' }, limitNanoUsd: 5_000_000_000n })
  }, 120_000)
  afterAll(async () => {
    await booted.close()
    await bootedB.close()
  })

  /** What a settled run leaves: the wallet balance and the budget spend. */
  async function state(): Promise<{ wallet: bigint; spent: bigint }> {
    const wallet = await booted.wallets.reconcile(E2E_WALLET)
    const [status] = await booted.budgets.status('e2e', { type: 'user', id: 'u1' })
    return { wallet: wallet.nanoUsd, spent: status?.spent.nanoUsd ?? -1n }
  }

  /** A capture whose wallet leg fails leaves the marker; two sweepers over the real store, at once, finish it once. */
  it('is finished once by two sweepers racing over PostgreSQL', async () => {
    const hold = await booted.metering.hold(e2eContext(), { provider: 'openai', model: 'gpt-5', operation: 'chat', inputTokens: 1000, maxOutputTokens: 500 })
    const caller = { tenantId: 'e2e', scope: { type: 'user' as const, id: 'u1' } }
    const heldState = await state()
    jest.spyOn(booted.wallets, 'settleAdjustment').mockRejectedValueOnce(new Error('wallet down'))
    await expect(booted.metering.capture(hold, caller, e2eUsage({ inputTokens: 400, outputTokens: 100 }))).rejects.toThrow('wallet down')
    const owed = (await booted.ledger.findEffectsOwed(FUTURE(), 100)).filter((item) => item.record.id === hold.id)
    expect(owed).toHaveLength(1)

    const sweepOnce = async (service: Booted): Promise<void> => {
      for (const item of (await service.ledger.findEffectsOwed(FUTURE(), 100)).filter((row) => row.record.id === hold.id)) await service.metering.settleOwedEffects(item)
    }
    await Promise.all([sweepOnce(booted), sweepOnce(bootedB)])
    expect((await booted.ledger.findEffectsOwed(FUTURE(), 100)).some((item) => item.record.id === hold.id)).toBe(false)
    const settled = await state()
    expect(settled.wallet).toBeGreaterThan(heldState.wallet)
    expect(settled.spent).toBeLessThan(heldState.spent)
    await sweepOnce(booted)
    expect(await state()).toEqual(settled)
  })
})
