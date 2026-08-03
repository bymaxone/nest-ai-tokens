/**
 * @fileoverview Unit tests for the raw-SQL error classification.
 * @layer prisma
 *
 * The rest of this directory is exercised by the end-to-end suite against a real
 * PostgreSQL, which is why `src/prisma/**` is excluded from unit coverage: SQL
 * correctness is only meaningful against a database.
 *
 * `isUniqueViolation` is the exception. It is pure logic over an error object,
 * and it has to hold for *both* Prisma majors the peer range admits — while the
 * end-to-end suite can only ever exercise the one that happens to be installed.
 * A missed violation is silent: the exactly-once replay-or-conflict path (§15.2)
 * degrades a 409 conflict into a generic store error, which is precisely the
 * regression that appeared when the driver adapter moved the SQLSTATE.
 */

import { Prisma } from '@prisma/client'

import { PG_UNIQUE_VIOLATION, isUniqueViolation } from './adapter-sql'

/**
 * Build a known-request error with an arbitrary `meta`, as a driver would.
 *
 * `meta` is spread in rather than assigned, because `exactOptionalPropertyTypes`
 * distinguishes an absent property from one present and `undefined` — and an
 * absent `meta` is exactly the case a raw-query failure without details produces.
 */
function knownError(code: string, meta?: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('failed', {
    code,
    clientVersion: 'test',
    ...(meta === undefined ? {} : { meta: meta as Record<string, unknown> }),
  })
}

describe('isUniqueViolation', () => {
  it('recognises the model-call code', () => {
    expect(isUniqueViolation(knownError('P2002'))).toBe(true)
  })

  // Prisma 6 reaches the database through its own query engine, which reports the
  // native SQLSTATE flat on `meta`.
  it('recognises a raw-query violation reported flat on meta (query engine)', () => {
    expect(isUniqueViolation(knownError('P2010', { code: PG_UNIQUE_VIOLATION }))).toBe(true)
  })

  // Prisma 7 reaches it through a driver adapter, which nests the driver's own
  // error instead. Shape captured from @prisma/adapter-pg against PostgreSQL 16.
  it('recognises a raw-query violation nested under driverAdapterError (driver adapter)', () => {
    const meta = {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: PG_UNIQUE_VIOLATION,
          originalMessage: 'duplicate key value violates unique constraint "t_pkey"',
          kind: 'UniqueConstraintViolation',
        },
      },
    }
    expect(isUniqueViolation(knownError('P2010', meta))).toBe(true)
  })

  // The adapter names the violation even where a driver reports no SQLSTATE.
  it('recognises the driver adapter kind without an original code', () => {
    const meta = { driverAdapterError: { cause: { kind: 'UniqueConstraintViolation' } } }
    expect(isUniqueViolation(knownError('P2010', meta))).toBe(true)
  })

  it.each([
    ['a different SQLSTATE flat on meta', knownError('P2010', { code: '23503' })],
    [
      'a different driver adapter failure',
      knownError('P2010', {
        driverAdapterError: { cause: { originalCode: '23503', kind: 'ForeignKeyViolation' } },
      }),
    ],
    ['a raw-query failure carrying no meta', knownError('P2010')],
    ['an empty driverAdapterError', knownError('P2010', { driverAdapterError: {} })],
    ['an unrelated Prisma code', knownError('P1001')],
  ])('rejects %s', (_label, error) => {
    expect(isUniqueViolation(error)).toBe(false)
  })

  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s, which no driver produced', (_label, error) => {
    expect(isUniqueViolation(error)).toBe(false)
  })
})
