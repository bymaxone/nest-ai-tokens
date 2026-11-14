import { AiTokensException } from './ai-tokens-exception'
import { attachCause } from './attach-cause'
import { isStoreUnavailable, storeFailureCode } from './store-availability'

/** A Prisma known-request error as the installed client throws it: the name and string code, plus the optional fields a case sets. */
function prisma(code: string, extra: Record<string, unknown> = {}, message = 'x'): Error {
  return Object.assign(new Error(message), { name: 'PrismaClientKnownRequestError', code, clientVersion: '7.10.1', ...extra })
}

/** A `P2010` raw-query failure carrying the SQLSTATE where Prisma 7's driver adapter puts it. */
function rawAdapter(originalCode: string, kind = 'postgres'): Error {
  return prisma('P2010', { meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode, originalMessage: 'm', kind, code: originalCode } } } })
}

/** A `P2010` raw-query failure carrying the SQLSTATE flat on `meta.code`, as Prisma 6 does. */
function rawFlat(code: string): Error {
  return prisma('P2010', { meta: { code, message: 'm' } })
}

describe('isStoreUnavailable', () => {
  /** Each Prisma code the installed 7.10.1 runtime maps from a connection, timeout or conflict failure, and the two the Prisma 6 engine emits. */
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034', 'P2037'])('reads Prisma %s as unavailable', (code) => {
    expect(isStoreUnavailable(prisma(code))).toBe(true)
  })

  /** A configuration or statement defect is not retryable: credentials, missing database or table, constraint, data and unique violations. */
  it.each(['P1000', 'P1003', 'P1009', 'P1010', 'P1011', 'P2000', 'P2002', 'P2003', 'P2021', 'P2022', 'P1018'])('reads Prisma %s as an error', (code) => {
    expect(isStoreUnavailable(prisma(code))).toBe(false)
  })

  /** Captured on PostgreSQL 16 with Prisma 7.10.1 and the pg adapter: a stopped server and a fresh client against a stopped server both threw a known-request error whose code is the socket error. */
  it('reads the captured ECONNREFUSED of a stopped server as unavailable', () => {
    expect(isStoreUnavailable(prisma('ECONNREFUSED', {}, '\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\n'))).toBe(true)
  })

  /** The other socket codes a driver reports for a connection that cannot be made or kept. */
  it.each(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'])('reads %s as unavailable', (code) => {
    expect(isStoreUnavailable(prisma(code))).toBe(true)
  })

  /** Captured with a paused container: the driver adapter threw a plain Error, no Prisma name or code, with the pool's message and the socket's as its cause. */
  it('reads the captured pool timeout of a paused server as unavailable', () => {
    const paused = attachCause(Object.assign(new Error('Connection terminated due to connection timeout'), { clientVersion: '7.10.1' }), new Error('Connection terminated unexpectedly'))
    expect(isStoreUnavailable(paused)).toBe(true)
  })

  /** The other messages the PostgreSQL driver gives a connection that cannot be made, was closed or timed out. */
  it.each([
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
    'Connection closed',
    'Cannot use a pool after calling end on the pool',
  ])('reads the driver message %j as unavailable', (message) => {
    expect(isStoreUnavailable(new Error(message))).toBe(true)
  })

  /** A plain error that is not about the connection is a defect. */
  it('reads an unrelated plain error as an error', () => {
    expect(isStoreUnavailable(new Error('column "x" does not exist'))).toBe(false)
  })

  /** A message that names a connection is not enough when Prisma already classified the failure as something else. */
  it('does not read the message of a known-request error', () => {
    expect(isStoreUnavailable(prisma('P2021', {}, 'Connection terminated'))).toBe(false)
  })

  /** Captured on PostgreSQL 16 with Prisma 7.10.1: each SQLSTATE arrived as P2010 with the state under meta.driverAdapterError.cause. */
  it.each([
    ['57014', 'canceling statement due to statement timeout'],
    ['55P03', 'canceling statement due to lock timeout'],
    ['57P01', 'terminating connection due to administrator command'],
    ['40001', 'could not serialize access due to read/write dependencies among transactions'],
    ['40P01', 'deadlock detected'],
  ])('reads the captured SQLSTATE %s (%s) as unavailable under Prisma 7', (state) => {
    expect(isStoreUnavailable(rawAdapter(state, state.startsWith('40') ? 'TransactionWriteConflict' : 'postgres'))).toBe(true)
  })

  /** The same states under Prisma 6, where they are flat on meta.code, and the listed shutdown, refusal and resource classes. */
  it.each(['57014', '55P03', '57P01', '57P03', '40001', '40P01', '08000', '08006', '08001', '53100', '53200', '53300'])('reads SQLSTATE %s as unavailable on both shapes', (state) => {
    expect(isStoreUnavailable(rawFlat(state))).toBe(true)
    expect(isStoreUnavailable(rawAdapter(state))).toBe(true)
  })

  /** A raw statement that fails for a reason of its own is an error: unique violation, undefined table, syntax, invalid text. */
  it.each(['23505', '42P01', '42601', '22P02', '23503'])('reads SQLSTATE %s as an error', (state) => {
    expect(isStoreUnavailable(rawFlat(state))).toBe(false)
    expect(isStoreUnavailable(rawAdapter(state))).toBe(false)
  })

  /** A bare driver error carrying the SQLSTATE as its code, as the pg driver throws it before Prisma wraps it. */
  it('reads a bare driver error with an unavailable SQLSTATE as its code', () => {
    expect(isStoreUnavailable(Object.assign(new Error('terminating connection'), { code: '57P01' }))).toBe(true)
    expect(isStoreUnavailable(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(false)
  })

  /** Captured with a transaction that ran out of time: P2028 with meta.timeout. The same code after the transaction ended has an empty meta and is a defect. */
  it('reads the transaction deadline as unavailable and the use of a closed transaction as an error', () => {
    expect(isStoreUnavailable(prisma('P2028', { meta: { operation: 'query', timeout: 100, timeTaken: 1003 } }, 'Transaction API error: A query cannot be executed on an expired transaction.'))).toBe(true)
    expect(isStoreUnavailable(prisma('P2028', { meta: {} }, 'Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.'))).toBe(false)
  })

  /** Captured with the server paused, through an interactive transaction: P2028 with an empty meta whose message says the transaction could not start in time. */
  it('reads a transaction that could not start in time as unavailable', () => {
    expect(isStoreUnavailable(prisma('P2028', { meta: {} }, 'Transaction API error: Unable to start a transaction in the given time.'))).toBe(true)
  })

  /** A connection-initialisation failure carries its code as `errorCode`, not `code`. */
  it('reads the errorCode of an initialisation error', () => {
    expect(isStoreUnavailable(Object.assign(new Error("Can't reach database server"), { name: 'PrismaClientInitializationError', errorCode: 'P1001' }))).toBe(true)
    expect(isStoreUnavailable(Object.assign(new Error('Authentication failed'), { name: 'PrismaClientInitializationError', errorCode: 'P1000' }))).toBe(false)
  })

  /** A P2028 with neither a timeout in its meta nor a message is not a deadline. */
  it('reads a P2028 with no timeout and no message as an error', () => {
    expect(isStoreUnavailable({ code: 'P2028', message: 42 })).toBe(false)
  })

  /** Captured on Prisma 6.19.3's engine against a stopped server: an initialisation error with no code at all, only the message. */
  it('reads the captured initialisation error of Prisma 6 for an unreachable server', () => {
    const unreachable = Object.assign(new Error("\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nCan't reach database server at `localhost:55432`\n\nPlease make sure your database server is running at `localhost:55432`."), { name: 'PrismaClientInitializationError', clientVersion: '6.19.3' })
    expect(isStoreUnavailable(unreachable)).toBe(true)
    expect(isStoreUnavailable(Object.assign(new Error('Schema validation error'), { name: 'PrismaClientInitializationError' }))).toBe(false)
  })

  /** Captured on Prisma 6.19.3's engine: a pool timeout (P2024 with its connection limit), a closed connection of a stopped server (P1017), and a transaction that could not start (P2028 with the reason in meta.error). */
  it('reads the captured Prisma 6 engine shapes as unavailable', () => {
    expect(isStoreUnavailable(prisma('P2024', { meta: { connection_limit: 1, timeout: 3 } }, 'Timed out fetching a new connection from the connection pool.'))).toBe(true)
    expect(isStoreUnavailable(prisma('P1017', { meta: null }, 'Server has closed the connection.'))).toBe(true)
    expect(isStoreUnavailable(prisma('P2028', { meta: { error: 'Unable to start a transaction in the given time.' } }, 'Transaction API error: Unable to start a transaction in the given time.'))).toBe(true)
  })

  /** An error wrapped by the library keeps the driver error as its cause, and the classifier follows it, bounded. */
  it('follows the cause chain and stops at its bound', () => {
    const wrapped = attachCause(new AiTokensException('AI_TOKENS_STORE_ERROR'), prisma('P1001'))
    expect(isStoreUnavailable(wrapped)).toBe(true)
    let deep: unknown = prisma('P1001')
    for (let i = 0; i < 6; i += 1) deep = attachCause(new Error('wrap'), deep)
    expect(isStoreUnavailable(deep)).toBe(false)
  })

  /** Values that are not errors are never unavailable. */
  it.each([undefined, null, 'ECONNREFUSED', 42])('reads %p as an error', (value) => {
    expect(isStoreUnavailable(value)).toBe(false)
  })
})

describe('storeFailureCode', () => {
  /** The code follows the classifier. */
  it('names the code the classifier chose', () => {
    expect(storeFailureCode(prisma('P1001'))).toBe('AI_TOKENS_STORE_UNAVAILABLE')
    expect(storeFailureCode(prisma('P2021'))).toBe('AI_TOKENS_STORE_ERROR')
  })
})
