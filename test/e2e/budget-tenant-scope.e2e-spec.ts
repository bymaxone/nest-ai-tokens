/**
 * @fileoverview E2E: a budget is reachable only by its own tenant on the admin paths, on real PostgreSQL. Tenant B
 * cannot delete, rotate, reconcile or overwrite tenant A's budget by its id: each call answers as an unknown id does,
 * and A's budget row and its window rows are byte-identical afterwards (compared as the database's own JSON).
 * @layer test
 */

import type { AiTokensErrorResponse } from '@bymax-one/nest-ai-tokens/shared'
import type { AiTokensException } from '@bymax-one/nest-ai-tokens'
import { bootMeteringModule, e2eContext, startPostgres, type Booted, type PostgresFixture } from './harness'

const A = 'e2e'
const B = 'tenant-b'
const WINDOW = new Date('2026-06-01T00:00:00.000Z')

let pg: PostgresFixture
let app: Booted

beforeAll(async () => {
  pg = await startPostgres()
  app = await bootMeteringModule({ store: pg.store })
}, 180_000)
afterAll(async () => {
  await app.close()
  await pg.stop()
})

/** The code and message a rejection carries, or `undefined` when the promise resolved. */
async function answer(promise: Promise<unknown>): Promise<{ code: string; message: string; reason: string } | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    const body = ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error
    return { code: body.code, message: body.message, reason: String((body.details as { reason?: string } | undefined)?.reason) }
  }
}

/** Every row of the budget and its windows as the database's JSON, so "unchanged" means byte for byte. */
async function snapshot(id: string): Promise<string> {
  const budget = await pg.prisma.$queryRawUnsafe<{ j: string }[]>('SELECT row_to_json(b)::text AS j FROM "ai_budgets" b WHERE "id" = $1', id)
  const windows = await pg.prisma.$queryRawUnsafe<{ j: string }[]>('SELECT row_to_json(w)::text AS j FROM "ai_budget_windows" w WHERE "budgetId" = $1 ORDER BY "windowStart"', id)
  return JSON.stringify({ budget: budget.map((r) => r.j), windows: windows.map((r) => r.j) })
}

describe('budget admin paths are tenant-scoped on PostgreSQL', () => {
  it('answers tenant B on tenant A budget as it answers an unknown id, and leaves A byte-identical', async () => {
    const a = await app.budgets.upsertBudget({ tenantId: A, scope: { type: 'tenant', id: A }, window: 'month', limitNanoUsd: 100_000_000n })
    await app.budgets.consume(e2eContext(), { nanoUsd: 5n, tokens: 1, count: 1 })
    const before = await snapshot(a.id)
    expect(JSON.parse(before).windows.length).toBeGreaterThan(0)

    const removed = await answer(app.budgets.removeBudget(a.id, B))
    const removedUnknown = await answer(app.budgets.removeBudget('00000000-0000-0000-0000-000000000000', B))
    const rotated = await answer(app.budgets.rotateWindow(a.id, B, new Date('2026-06-20T00:00:00.000Z')))
    const rotatedUnknown = await answer(app.budgets.rotateWindow('00000000-0000-0000-0000-000000000000', B, new Date('2026-06-20T00:00:00.000Z')))
    const reconciled = await answer(app.budgets.reconcileWindow(a.id, B, WINDOW))
    const reconciledUnknown = await answer(app.budgets.reconcileWindow('00000000-0000-0000-0000-000000000000', B, WINDOW))
    const overwritten = await answer(app.budgets.upsertBudget({ tenantId: B, scope: { type: 'tenant', id: B }, window: 'day', limitNanoUsd: 1n, id: a.id } as never))
    console.log('B9 ' + JSON.stringify({ removed, rotated: rotated?.code, reconciled: reconciled?.code, overwritten: overwritten?.code }))

    expect(removed).toBeUndefined()
    expect(removedUnknown).toBeUndefined()
    expect(rotated?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(rotated?.reason.replace(a.id, 'ID')).toBe(rotatedUnknown?.reason.replace('00000000-0000-0000-0000-000000000000', 'ID'))
    expect(reconciled?.reason.replace(a.id, 'ID')).toBe(reconciledUnknown?.reason.replace('00000000-0000-0000-0000-000000000000', 'ID'))
    expect(overwritten?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(JSON.stringify(overwritten)).not.toContain(A)
    expect(await snapshot(a.id)).toBe(before)

    await app.budgets.removeBudget(a.id, A)
    expect(JSON.parse(await snapshot(a.id)).budget).toEqual([])
  }, 120_000)
})
