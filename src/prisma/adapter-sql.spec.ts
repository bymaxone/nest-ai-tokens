/**
 * @fileoverview Unit tests for the raw-SQL error classification.
 * @layer prisma
 *
 * `adapter-sql.ts` is pure: it is in the unit coverage gate, and `adapter-sql-builders.spec.ts`
 * covers its mappers and builders. The store in `index.ts` runs the statements against a real
 * PostgreSQL and is owned by the end-to-end suite, since SQL correctness is only meaningful
 * against a database.
 *
 * `isUniqueViolation` is pure logic over an error object, and it has to hold for *both* Prisma
 * majors the peer range admits — while the end-to-end suite can only ever exercise the one that
 * happens to be installed.
 * A missed violation is silent: the exactly-once replay-or-conflict path (§15.2)
 * degrades a 409 conflict into a generic store error, which is precisely the
 * regression that appeared when the driver adapter moved the SQLSTATE.
 */

import { Prisma } from '@prisma/client'

import { PG_UNIQUE_VIOLATION, isUniqueViolation, priceLockKey, storeError } from './adapter-sql'

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

  // The SQLSTATE is a fixed code, not whatever the constant happens to hold.
  it('names the unique-violation SQLSTATE', () => {
    expect(PG_UNIQUE_VIOLATION).toBe('23505')
  })

  // A driver adapter that reports only the native code, with no kind, is a violation too.
  it('recognises the driver adapter original code without a kind', () => {
    const meta = { driverAdapterError: { cause: { originalCode: '23505' } } }
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

describe('error recognition without Prisma\'s classes', () => {
  /** An error object from another copy of Prisma, or built by hand, is recognised by its name and code, not by its class. */
  it('recognises a known-request error that is not an instance of the class', () => {
    expect(isUniqueViolation({ name: 'PrismaClientKnownRequestError', code: 'P2002' })).toBe(true)
    expect(isUniqueViolation({ name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: PG_UNIQUE_VIOLATION } })).toBe(true)
    expect(isUniqueViolation({ name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'UniqueConstraintViolation' } } } })).toBe(true)
  })

  /** A different name, or a code that is not a string, is not Prisma's error, whatever else it carries. */
  it.each([
    ['another name with the same code', { name: 'DriverError', code: 'P2002' }],
    ['no name', { code: 'P2002' }],
    ['a numeric code', { name: 'PrismaClientKnownRequestError', code: 2002 }],
    ['a numeric code with a unique-violation meta', { name: 'PrismaClientKnownRequestError', code: 2010, meta: { code: PG_UNIQUE_VIOLATION } }],
    ['no code', { name: 'PrismaClientKnownRequestError' }],
    ['a native driver error', Object.assign(new Error('duplicate'), { code: PG_UNIQUE_VIOLATION })],
  ])('does not recognise %s', (_label, error) => {
    expect(isUniqueViolation(error)).toBe(false)
  })

  /** The store error carries the code of an object recognised that way, and none for another. */
  it('puts the code of a recognised error in the body and leaves out any other', () => {
    const body = (error: unknown): { error: { details: Record<string, unknown> } } => storeError(error).getResponse() as { error: { details: Record<string, unknown> } }
    expect(body({ name: 'PrismaClientKnownRequestError', code: 'P2010' }).error.details).toEqual({ code: 'P2010' })
    expect(body({ name: 'Other', code: 'P2010' }).error.details).toEqual({})
    expect(body({ name: 'PrismaClientKnownRequestError', code: 2010 }).error.details).toEqual({})
  })
})

describe('priceLockKey', () => {
  /** Two tuples whose joined text is equal must still lock separately. */
  it('keeps provider and model apart when one contains the delimiter', () => {
    expect(priceLockKey('a|b', 'c', 'chat', 'standard')).not.toBe(priceLockKey('a', 'b|c', 'chat', 'standard'))
  })

  /** The key is a function of the whole tuple, so any differing field changes it. */
  it('differs when any field differs and repeats for equal tuples', () => {
    const base = priceLockKey('openai', 'gpt-5', 'chat', 'standard')
    expect(priceLockKey('openai', 'gpt-5', 'chat', 'standard')).toBe(base)
    expect(priceLockKey('openai', 'gpt-5', 'chat', 'batch')).not.toBe(base)
    expect(priceLockKey('openai', 'gpt-5', 'embeddings', 'standard')).not.toBe(base)
  })
})

describe('storeError', () => {
  /** The driver error that failed rides on the typed error as its cause, and the body keeps only the code. */
  it('keeps the driver error as the cause and the Prisma code in the body', () => {
    const driver = knownError('P2010')
    const error = storeError(driver)
    expect(error.cause).toBe(driver)
    expect(error.getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR', details: { code: 'P2010' } } })
  })

  /** An error that carries no Prisma code leaves the code out of the body, rather than setting it to undefined. */
  it('leaves the code out of the body when the error has none', () => {
    const body = storeError(new Error('boom')).getResponse() as { error: { details: Record<string, unknown> } }
    expect('code' in body.error.details).toBe(false)
  })

  /** An error that is already typed passes through, so a specific refusal is not flattened into a store error. */
  it('returns a typed error as it is', () => {
    const typed = storeError(new Error('x'))
    expect(storeError(typed)).toBe(typed)
  })
})
