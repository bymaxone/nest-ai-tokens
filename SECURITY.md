# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅ Active |

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

`capture()` and `release()` revalidate the hold against the persistence store and reject any hold whose `tenantId` or `scope` does not match the caller's context. The error code is `AI_TOKENS_HOLD_NOT_FOUND` (deliberately indistinguishable from a nonexistent hold — no information leakage).

### Idempotency-key scope

Idempotency keys are scoped per tenant. A replay attempt within a different tenant produces a new record (not a conflict). A same-tenant key with a different payload hash raises `AI_TOKENS_IDEMPOTENCY_CONFLICT`.

### Hash-chain integrity

When `pricing.hashChain` is enabled, every posted record carries a SHA-256 chain over previous records in the same tenant. `LedgerService.verifyChain()` detects post-hoc modification or deletion. This is the SOC 2 audit trail mechanism (spec §14.5).

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
