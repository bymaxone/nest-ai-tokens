# Design note: availability failures of the store answer 503, everything else 500

Status: implemented. Basis: the installed Prisma 7.10.1 runtime, and error shapes captured on PostgreSQL 16 with Prisma 7.10.1 (pg driver adapter) and Prisma 6.19.3 (engine); the captured shapes are the cases of `src/server/errors/store-availability.spec.ts` and the Testcontainers specs `store-unavailable` and `store-error`.

## The problem

`AI_TOKENS_STORE_ERROR` is one code for every driver failure and answers 502. A database that is down, a pool that is exhausted and a transaction that lost a serialization race are all "try again shortly" to a caller, while a malformed statement or a missing table is a defect that retrying never fixes. One status for both hides the difference from load balancers and clients, and 502 names a bad upstream gateway, which a store is not.

## The rule

- One classifier decides whether a driver failure is an availability failure. It lives in `src/server/errors/store-availability.ts` and is the only place that reads driver codes; `storeError` in `src/prisma/adapter-sql.ts` and the wallet and budget services call it, they never read a code themselves.
- An availability failure becomes the new code `AI_TOKENS_STORE_UNAVAILABLE`, status **503**. No `Retry-After` header: the library cannot know when the store returns.
- Every other driver failure stays `AI_TOKENS_STORE_ERROR` and moves from 502 to **500**.
- The idempotency-conflict path (`isUniqueViolation` and the ledger and wallet mappers) keeps 409 and is never re-wrapped: the classifier runs only on what those mappers did not already claim, and a test asserts it.
- `AI_TOKENS_STREAM_USAGE_MISSING` stays 422.

## What counts as unavailable

Source for the Prisma 7 column: the driver-adapter error mapping in the installed runtime (`@prisma/client@7.10.1`, `runtime/client.js`, the switch from adapter error kind to code). Source for Prisma 6 and for the codes the engine emits: Prisma's error reference for the installed major; the codes below that this runtime does not contain are marked.

| code | meaning | in the Prisma 7.10.1 runtime | class |
| --- | --- | --- | --- |
| P1001 | database server cannot be reached | `DatabaseNotReachable` | unavailable |
| P1002 | database server reached but timed out | not present | unavailable, not reproduced |
| P1008 | operation timed out | `SocketTimeout` | unavailable |
| P1017 | server closed the connection | `ConnectionClosed` | unavailable |
| P2024 | timed out fetching a connection from the pool | not present | unavailable |
| P2034 | write conflict or deadlock, transaction failed | `TransactionWriteConflict` | unavailable (retryable) |
| P2037 | too many database connections | `TooManyConnections` | unavailable |
| P2028 | transaction API error | class `TransactionAPIError` | decided by the red test: unavailable only when it is the transaction timeout or a closed transaction, otherwise error |
| P1018 | transaction already closed | `TransactionAlreadyClosed` | decided with P2028 |
| P1000, P1003, P1009, P1010, P1011 | authentication, missing database, access, TLS | present | error: configuration, retrying does not fix it |
| P2000-P2023 constraint and data codes | statement or data defects | present | error |

Raw queries surface `P2010` carrying the native SQLSTATE (flat on `meta.code` in Prisma 6, nested under `meta.driverAdapterError.cause` in Prisma 7), the same two places `isUniqueViolation` already reads. The classifier reads the SQLSTATE in both places.

Two shapes the current `isKnownRequestError` does not recognise and the classifier must: a `PrismaClientInitializationError` (connection refused on the first query, carrying `errorCode` rather than `code`) and a driver-level error with no Prisma wrapper (a closed pool). Whether each appears is measured per mode below, not assumed.

## Measured before the code

Red-first against real PostgreSQL 16 (Testcontainers) in QA's three modes, each recording the code and status the caller actually gets: the container paused, the container stopped, and a fresh client against a stopped container.

## Tests

- A table test pins the status value of every error code, including the new one and the 502 to 500 move.
- Unit tests of the classifier: each listed Prisma code, each SQLSTATE, both shapes of `P2010`, an initialization error, a non-Prisma error, and a unique violation that stays a conflict.
- The conflict path: a store whose unique violation also carries an availability-looking code still answers 409.
- Real PostgreSQL, the three modes above.

## What changes for users

- A new code in the shared error table and the README status map: `AI_TOKENS_STORE_UNAVAILABLE`, 503.
- `AI_TOKENS_STORE_ERROR` answers 500 instead of 502. A client or an alert that matches 502 for the store must change; this is stated in the Apply note.
- Patch release (DEC-063) with an Apply note covering both changes. No migration, no store port change.

## Measured

| mode | Prisma 7.10.1 (adapter-pg) | Prisma 6.19.3 (engine) | class |
| --- | --- | --- | --- |
| server stopped, warm client | known-request error, code `ECONNREFUSED` | P1017 "Server has closed the connection." | unavailable |
| client created after the server stopped | known-request error, code `ECONNREFUSED` | initialisation error, no code, "Can't reach database server at ..." | unavailable |
| server paused, plain query | plain `Error` "Connection terminated due to connection timeout", cause "Connection terminated unexpectedly" | hangs with no timeout (no error to classify) | unavailable (7); a host sets a timeout (6) |
| server paused, interactive transaction | P2028 "Unable to start a transaction in the given time.", empty meta | P2028, same message, `meta.error` the same text | unavailable |
| transaction past its timeout | P2028, `meta.timeout` set | P2028 | unavailable |
| pool exhausted | not reproduced | P2024 with `connection_limit` and `timeout` | unavailable |
| statement timeout, lock timeout, backend terminated, serialization failure, deadlock | P2010 with the SQLSTATE under `meta.driverAdapterError.cause` (`57014`, `55P03`, `57P01`, `40001` and `40P01`, the last two with kind `TransactionWriteConflict`) | SQLSTATE flat on `meta.code` (shape read from Prisma 6's documented raw-query error; not captured) | unavailable |
| use of a transaction after it ended | P2028 "Transaction already closed", empty meta | not captured | error |

P1002 is in the list from Prisma's error reference and was not reproduced on either major. P2028 and P1018 are decided as the note said: unavailable only when the transaction ran out of time or could not start, which the captured shapes tell apart by `meta.timeout` and by the message; a transaction used after it ended is a defect.

The Prisma store lets most driver errors reach the service raw; the services (`WalletService`, `BudgetService` fail-closed) and the store's own wrapped paths (`append`, `transition`, the reads that already used `rethrowAsStoreError`) classify them. A host that calls the store directly sees the raw driver error as before.
