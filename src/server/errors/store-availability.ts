/**
 * @fileoverview The one classifier that decides whether a persistence failure means "the store cannot serve this call
 * now, try again" (`AI_TOKENS_STORE_UNAVAILABLE`, 503) or "the call or the store is defective" (`AI_TOKENS_STORE_ERROR`,
 * 500). It reads error shapes only, never a class: the PostgreSQL entry point is bundled on its own and copies whatever
 * it imports by a relative path, and a host may carry two copies of Prisma.
 * @layer server
 */

/** Prisma codes for a server that cannot be reached, closed the connection or timed out, a pool or a server out of connections, and a write conflict. */
const UNAVAILABLE_PRISMA_CODES: ReadonlySet<string> = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034', 'P2037'])

/** Node socket error codes a driver reports when it cannot reach or keep a connection. */
const UNAVAILABLE_SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
])

/** SQLSTATEs of a deadline the database enforced (57014 statement timeout, 55P03 lock timeout), a shutdown or a refusal to connect (57P01, 57P03), and a retryable conflict (40001 serialization failure, 40P01 deadlock). */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set(['57014', '55P03', '57P01', '57P03', '40001', '40P01'])

/** Messages of the PostgreSQL driver's own errors for a connection that could not be made, was closed or timed out. */
const DRIVER_CONNECTION_MESSAGE =
  /connection terminated|timeout exceeded when trying to connect|connection error and is not queryable|connection (?:is )?closed|cannot use a pool after calling end/i

/** The message Prisma 6's engine gives an initialisation error for a server it cannot reach; that error carries no code. */
const UNREACHABLE_MESSAGE = /can't reach database server/i

/** How deep the `cause` chain is followed. */
const MAX_CAUSE_DEPTH = 3

/** A thrown value read as a bag of optional fields. */
interface ErrorFields {
  name?: unknown
  code?: unknown
  errorCode?: unknown
  message?: unknown
  meta?: { code?: unknown; timeout?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } }
  cause?: unknown
}

/** A string field, or `undefined` for anything else. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Whether a SQLSTATE says the store cannot serve the call now: class 08 (connection exception), class 53 (insufficient resources) or a listed deadline, shutdown or conflict. */
function isUnavailableSqlState(state: string | undefined): boolean {
  if (state === undefined) return false
  return state.startsWith('08') || state.startsWith('53') || UNAVAILABLE_SQLSTATES.has(state)
}

/**
 * Whether a Prisma `P2028` is a transaction deadline: a transaction that ran out of time carries `meta.timeout`, and one that
 * could not start in time (no connection to run on, as against a paused server) says so in its message. A transaction used
 * after it ended, a defect of the caller, is neither.
 */
function isTransactionDeadline(fields: ErrorFields): boolean {
  if (fields.code !== 'P2028') return false
  return typeof fields.meta?.timeout === 'number' || /unable to start a transaction in the given time/i.test(text(fields.message) ?? '')
}

/** Whether one error, ignoring its `cause`, says the store is unavailable. */
function isUnavailableItself(fields: ErrorFields): boolean {
  const code = text(fields.code) ?? text(fields.errorCode)
  if (code !== undefined && (UNAVAILABLE_PRISMA_CODES.has(code) || UNAVAILABLE_SOCKET_CODES.has(code))) return true
  if (isTransactionDeadline(fields)) return true
  const cause = fields.meta?.driverAdapterError?.cause
  if (isUnavailableSqlState(text(fields.meta?.code) ?? text(cause?.originalCode) ?? text(cause?.code))) return true
  const raw = text(fields.code)
  if (raw !== undefined && !/^P\d{4}$/.test(raw) && isUnavailableSqlState(raw)) return true
  const message = text(fields.message) ?? ''
  if (fields.name === 'PrismaClientInitializationError') return UNREACHABLE_MESSAGE.test(message)
  return fields.name !== 'PrismaClientKnownRequestError' && DRIVER_CONNECTION_MESSAGE.test(message)
}

/**
 * Whether a persistence failure means the store cannot serve the call now.
 *
 * Unavailable: a server that cannot be reached or closed the connection, a pool or a server out of connections, a
 * statement, lock or transaction deadline the database or Prisma enforced, a shutdown, a serialization failure or deadlock
 * (retryable by design), and the driver's own connection errors. Everything else, including a unique violation, a missing
 * table, bad credentials and a bad statement, is a defect that retrying does not fix.
 *
 * @param error The value a store call threw.
 */
export function isStoreUnavailable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    const fields = current as ErrorFields
    if (isUnavailableItself(fields)) return true
    current = fields.cause
  }
  return false
}

/**
 * The error code a persistence failure is reported under: {@link isStoreUnavailable} decides.
 *
 * @param error The value a store call threw.
 */
export function storeFailureCode(error: unknown): 'AI_TOKENS_STORE_UNAVAILABLE' | 'AI_TOKENS_STORE_ERROR' {
  return isStoreUnavailable(error) ? 'AI_TOKENS_STORE_UNAVAILABLE' : 'AI_TOKENS_STORE_ERROR'
}
