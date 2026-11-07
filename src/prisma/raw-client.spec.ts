/**
 * @fileoverview Unit tests for the executors that run a statement through the host's Prisma client.
 * @layer prisma
 */

import { SqlClient, SqlExecutor, type PrismaRawClient, type RawExecutor } from './raw-client'
import { sql } from './sql'

/** A client that records what it was asked to run. */
function fakeClient(rows: unknown = [{ id: 'a' }], affected = 3): { client: PrismaRawClient; calls: { kind: string; text: string; values: unknown[]; inTransaction: boolean }[] } {
  const calls: { kind: string; text: string; values: unknown[]; inTransaction: boolean }[] = []
  const executor = (inTransaction: boolean): RawExecutor => ({
    $queryRawUnsafe: <T>(text: string, ...values: unknown[]) => {
      calls.push({ kind: 'query', text, values, inTransaction })
      return Promise.resolve(rows as T)
    },
    $executeRawUnsafe: (text: string, ...values: unknown[]) => {
      calls.push({ kind: 'execute', text, values, inTransaction })
      return Promise.resolve(affected)
    },
  })
  const client: PrismaRawClient = { ...executor(false), $transaction: (fn) => fn(executor(true)) }
  return { client, calls }
}

describe('SqlExecutor', () => {
  /** The text and the values go to the client apart, the values spread as arguments. */
  it('runs a query with its text and values as separate arguments', async () => {
    const { client, calls } = fakeClient()
    const rows = await new SqlExecutor(client).query<{ id: string }[]>(sql`SELECT id FROM t WHERE a = ${'x'} AND b = ${2n}`)
    expect(rows).toEqual([{ id: 'a' }])
    expect(calls).toEqual([{ kind: 'query', text: 'SELECT id FROM t WHERE a = $1 AND b = $2', values: ['x', 2n], inTransaction: false }])
  })

  /** A statement resolves to the number of rows it affected. */
  it('runs a statement and resolves to the affected count', async () => {
    const { client, calls } = fakeClient()
    const affected = await new SqlExecutor(client).execute(sql`DELETE FROM t WHERE a = ${'x'}`)
    expect(affected).toBe(3)
    expect(calls).toEqual([{ kind: 'execute', text: 'DELETE FROM t WHERE a = $1', values: ['x'], inTransaction: false }])
  })

  /** A failure of the client reaches the caller unchanged. */
  it('lets the error of the client through', async () => {
    const failure = new Error('connection lost')
    const executor = new SqlExecutor({ $queryRawUnsafe: () => Promise.reject(failure), $executeRawUnsafe: () => Promise.reject(failure) })
    await expect(executor.query(sql`SELECT 1`)).rejects.toBe(failure)
    await expect(executor.execute(sql`SELECT 1`)).rejects.toBe(failure)
  })
})

describe('SqlClient', () => {
  /** Inside a transaction the callback gets an executor on the transaction's client, not the outer one. */
  it('runs the callback on the transaction client', async () => {
    const { client, calls } = fakeClient()
    const sqlClient = new SqlClient(client)
    await sqlClient.query(sql`SELECT 1`)
    const result = await sqlClient.transaction(async (tx) => {
      await tx.execute(sql`UPDATE t SET a = ${1}`)
      return await tx.query<{ id: string }[]>(sql`SELECT id FROM t`)
    })
    expect(result).toEqual([{ id: 'a' }])
    expect(calls.map((c) => [c.kind, c.inTransaction])).toEqual([['query', false], ['execute', true], ['query', true]])
  })

  /** What the callback throws rolls the transaction back and reaches the caller. */
  it('lets the error of the callback through', async () => {
    const { client } = fakeClient()
    const failure = new Error('boom')
    await expect(new SqlClient(client).transaction(() => Promise.reject(failure))).rejects.toBe(failure)
  })
})
