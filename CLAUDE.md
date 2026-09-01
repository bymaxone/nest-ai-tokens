# CLAUDE.md — @bymax-one/nest-ai-tokens

Quick reference for AI assistants and engineers working on this codebase.

---

## What this library does

AI token metering & usage-based billing for NestJS 11. Provider-agnostic normalizers (×9), versioned effective-dated pricing, immutable append-only ledger, prepaid wallets, multi-dimension budgets, and markup/margin for reselling AI. Zero runtime dependencies.

---

## CRITICAL RULES (never violate these)

### 1. Money is always bigint nano-USD

Every persisted monetary value is `bigint` nano-USD. No `number`, no `parseFloat`, no `toFixed`, no floating-point arithmetic on money paths. The only valid conversions are:

- **Input:** `floatUsdToNanoUsd(n)` for provider-reported float costs (OpenRouter)
- **Output:** `formatNanoUsd(n)` for display, `toJsonSafe(obj)` at JSON boundaries

### 2. Ledger is append-only — no UPDATE/DELETE of posted amounts

Corrections are compensating records (`reverse()`). The only permitted post-posting mutation is the `reversedByRecordId` annotation. Hash-chain integrity means altering a row breaks the chain.

### 3. Annotation-only reversal

`reverse()` annotates the original record (`reversedByRecordId`) and creates a new compensating record. It does NOT update the original record's amounts. A record can only be reversed once (idempotency-conflict on a second attempt).

### 4. Capture is idempotent

`capture(hold, usage)` called twice on the same hold settles with the first actuals and silently returns the already-settled record on the second call. Never guard against double-capture at the call site.

### 5. Unlimited = no row; 0 = hard block

Budget enforcement semantics (spec §10.2):
- **No budget row** = unlimited. `getStatus()` returns no entry for the feature.
- **`limit = 0`** = hard block (blocks all calls immediately).
- `null`/`undefined` limits and `0` must NEVER be conflated. When migrating from a system that uses them, translate `0`/`null` limits to **no budget row**.

### 6. isSystemCost never consumes

Records with `isSystemCost: true` are observed and reported but do NOT consume wallet balance or budget headroom. They appear in cost aggregates (`isSystemCost` filter) and carry `systemCostCategory` for attribution.

### 7. No prompt/completion text in the ledger

The ledger stores token counts, model identifiers, cost, and IDs. Prompt and completion text MUST NOT enter any ledger field, event payload, or telemetry span. The only sanctioned path is `ContentCapture` → `IContentStore` (opt-in, off by default, short TTL).

### 8. scopeResolver is trusted input

`scopeResolver` in `BudgetGuard` and `MeteringInterceptor` MUST read from the host's verified auth context (JWT claims, validated session). It MUST NEVER read from client-supplied body or query parameters.

---

## Side-effect matrix (spec §11.2)

| Operation | Ledger write | Wallet debit | Budget consume | Events | Telemetry |
|---|---|---|---|---|---|
| `record({ enforce: false })` | ✅ | ❌ | ❌ | ✅ | ✅ |
| `record({ enforce: true })` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `hold()` | pending record | budget reserve | budget reserve | ✅ | ✅ |
| `capture()` | pending → posted | ✅ | finalises | ✅ | ✅ |
| `release()` | pending → released | ❌ | releases | ✅ | ✅ |
| `reverse()` | annotation + compensating | optional refund | releases | ✅ | ✅ |
| `record({ isSystemCost: true })` | ✅ | ❌ | ❌ | ✅ | ✅ |

---

## Architecture layers (barrel structure)

```
@bymax-one/nest-ai-tokens          server layer — NestJS module, services, guard, interceptor
@bymax-one/nest-ai-tokens/shared   zero-dep — normalizers, cost math, types, error codes
@bymax-one/nest-ai-tokens/prices   data-only — pinned price snapshot (imported lazily)
@bymax-one/nest-ai-tokens/prisma   PostgreSQL adapter — PrismaAiTokensStore
@bymax-one/nest-ai-tokens/redis    budget counter — RedisBudgetCounterStore
```

`./shared` MUST NOT import NestJS, Prisma, ioredis, or any Node built-in beyond crypto.
`./prices` MUST NOT import `./shared` at runtime (types only, erased at build).

---

## Key commands

```bash
pnpm test              # unit tests (824 tests, 100% coverage)
pnpm test:e2e          # Testcontainers e2e (requires Docker)
pnpm test:cov          # coverage report
pnpm typecheck         # tsc --noEmit on all configs
pnpm lint              # eslint src/
pnpm docs:check        # JSDoc coverage sweep + docs fixture type-check
pnpm build             # tsup → dist/ (5 subpaths)
pnpm size              # brotli size budgets (server < 40 KB, shared < 10 KB, prisma < 15 KB, redis < 5 KB)
pnpm mutation          # Stryker mutation gate (break 100, ~10-20 min)
pnpm prepublishOnly    # full gate chain (typecheck + lint + test:cov:all + build)
```

---

## Commit convention

`<type>(ai-tokens): <subject>` — Conventional Commits, scope always `(ai-tokens)`.  
No `Co-Authored-By` trailers.

---

## What NOT to add

- No provider SDK imports in `src/` (normalizer-first — plain object inputs only)
- No `dependencies` in `package.json` (zero runtime deps — peers only)
- No `parseFloat`/`toFixed` on money paths in `src/shared/pricing` or `src/server/services`
- No prompt/completion text in the ledger, events, telemetry, or logs
- No `UPDATE`/`DELETE` of posted ledger records

---

## Reference

Full spec: `docs/technical_specification.md`  
Architecture and ports: `AGENTS.md`  
Security threat model: `SECURITY.md`  
