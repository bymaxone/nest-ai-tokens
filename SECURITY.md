# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.1.x   | ✅ Active |
| 1.0.x   | ❌ No support — upgrade to 1.1.x |

Only the latest minor line receives security fixes.

## Reporting a vulnerability

Email **support@bymax.one** with a description of the vulnerability, reproduction steps, and your assessment of impact. Do not open a public GitHub issue for security vulnerabilities.

We aim to acknowledge receipt within 2 business days and provide a resolution timeline within 7 business days.

---

## Threat model

### Authorization boundary

**The library performs no authentication or authorization.** It trusts the host's dependency-injection container. Any code path that can inject `WalletService`, `PricingService`, or `BudgetService` has full admin-plane access. Hosts MUST enforce role-based access control at the controller/guard layer.

### Admin plane (privileged — restrict to admin roles)

The following operations mutate billing state and MUST be guarded by a host-side admin check:

| Method                         | Risk                              |
| ------------------------------ | --------------------------------- |
| `WalletService.grant()`        | Creates credits from nothing      |
| `WalletService.adjust()`       | Corrects a wallet balance         |
| `PricingService.upsertPrice()` | Changes what future calls cost    |
| `BudgetService.upsertBudget()` | Creates or raises spending limits |
| `BudgetService.removeBudget()` | Removes enforcement               |
| `BudgetService.rotateWindow()` | Resets usage counters             |
| `MeteringService.reverse()`    | Compensation + credit refund      |
| `UsageReportService.export()`  | Bulk read of billing data         |

Every admin-plane mutation emits an `ai_tokens.audit` event with actor propagation via `requestedBy`.

### Data plane (safe for request-scoped use)

`MeteringService.record()`, `meter()`, `hold()`, `capture()`, `release()`, `getStatus()`, `estimateCost()`, `WalletService.getOrCreate()`, `getBalance()`, `getEntries()`, and `BudgetService.getStatus()` are safe for use in ordinary request handlers — provided the `scopeResolver` is correctly wired (see below).

### Scope resolution (trusted input)

`scopeResolver` runs on every guarded request. It MUST read from the host's verified auth context (JWT claims, validated session) — NEVER from client-supplied body/query parameters. A misconfigured resolver can allow cross-tenant data access.

### Cross-tenant hold validation

`capture(hold, caller, usage)` and `release(hold, caller, reason)` load the hold by `hold.id` from the persistence store and require the stored record's `tenantId` and `scope` to equal the `caller` the host passes, which must come from its verified auth context. The `tenantId` and `scope` carried on the `Hold` object are not read, so a forged or round-tripped `Hold` gains nothing beyond knowing the record id. A hold of another caller answers `AI_TOKENS_HOLD_NOT_FOUND`, the same answer as a nonexistent hold (no existence oracle). A `caller` that is not a non-empty tenant string and a scope is refused with `AI_TOKENS_INVALID_CONFIG` before the store is read. The input tokens of an aborted stream come from the stored hold, never from `hold.estimatedTokens`.

### Idempotency-key scope

Idempotency keys are scoped per tenant. A replay attempt within a different tenant produces a new record (not a conflict). A same-tenant key with a different payload hash raises `AI_TOKENS_IDEMPOTENCY_CONFLICT`.

### Hash-chain integrity

When `pricing.hashChain` is enabled, every posted record carries a SHA-256 chain over previous records in the same tenant. `LedgerService.verifyChain()` detects post-hoc modification or deletion. This is the SOC 2 audit trail mechanism (spec §14.5). On Prisma 6 under a non-UTC session zone, records written by 1.1.11 or earlier hold a shifted `occurredAt` and make `verifyChain` report `valid: false` from the earliest such record; this is not tampering, and the README explains how to tell the two apart.

### PII discipline

The ledger stores token counts, model identifiers, cost, and scope IDs. It **never** stores prompt or completion text. The optional `content` sidecar (`IContentStore`) is the only sanctioned path for text, and it is off by default. All code paths that touch text are isolated in `ContentCapture` — an internal class that is not exposed via the public barrel.

### Sensitive code paths

| Path                        | Sensitivity                                               |
| --------------------------- | --------------------------------------------------------- |
| `WalletService.debit()`     | Race-safe balance check — conditional update fails loudly |
| `BudgetService.consume()`   | Atomic counter — Redis Lua or DB conditional write        |
| `MeteringService.capture()` | Idempotent hold settlement — duplicate capture is safe    |
| `MarkupResolver.resolve()`  | Host policy is trusted; a throwing policy fails the call  |
| `ContentCapture.capture()`  | Failures are logged, never thrown, and never include text |

### Connection strings

`RedisBudgetCounterStore` accepts a connection URL as an alternative to a live `Redis` instance. The URL is dynamically imported and NEVER logged, placed on an exception, or included in audit events.

### Threat model: same-process code

Code that runs in the host process is trusted, as in Node's own threat model. A module that swaps a builtin or a prototype (`Promise.prototype`, `Array.prototype`, `Object.prototype`) or a property of the host's own objects while a call is in progress can change what any library in that process does, and nothing in this library can stop it. The promise and intrinsics guards are best-effort hardening against accidents and against a hostile store or callback that answers once; they are not a security boundary against code that already runs in the process.

Known limits:

- A Prisma query is a lazy thenable whose own `then` sends the query. The library lets it through on a driver call of the Prisma adapter and on the metered function of `meter()`, since that `then` is the driver's or the provider's code and cannot be told from a planted one.
- A rejected native promise that a store gives both a `constructor` and a `then` of its own is refused, but its rejection can stay unhandled, since the wait that handles it reads that `constructor` and calls that `then`.
- A one-shot `Promise[Symbol.species]` getter that hands back a genuine, already resolved native promise cannot be told from the engine's answer.
- An accessor `then` on a row is read by code of the host, and what a read does is not controlled. Measured on the Prisma store guard: a row that an asynchronous method resolves with has its accessor `then` read twice, the first time when the method resolves (the engine looks for a `then` on what a promise resolves with, so the first read is there and not at an `await` of the host) and the second when the guard copies the row; the row is answered as a copy. A row a synchronous method returns has it read once, by the guard's check for a thenable, and a plain row whose `then` is a function is refused there.
- In a polluted realm (`Promise.prototype.then` or `constructor` replaced by an accessor), a `Promise` subclass or a promise of another realm that a store returns is refused, and its own `then` runs once, because the wait that handles its rejection must call it; its rejection is handled. A native promise with a `then` of its own is refused and waited for natively, and that `then` runs zero times. In a clean realm a subclass is awaited when the call allows thenables, and its `then` runs once.
- The `getPrototypeOf` trap of a Proxy row runs when the store guard decides whether the row is a plain object. A Proxy row returned synchronously is refused afterwards; one an asynchronous method resolves with is copied and answered.

### Supply chain

- All GitHub Actions are pinned by commit SHA.
- Workflows use least-privilege `permissions:`.
- `npm publish` uses OIDC provenance (no long-lived npm token stored in secrets).
- The `pnpm-lock.yaml` lockfile is committed and `--frozen-lockfile` is enforced in CI.
- Secret scanning (TruffleHog) runs in CI on every push.
- Dependency review runs on every pull request against public repositories.

---

## Disclosure contact

**support@bymax.one**
