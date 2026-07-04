# AGENTS.md — @bymax-one/nest-ai-tokens Architecture

Deep-dive for AI agents and engineers working on this library. Read CLAUDE.md first for the critical rules; this file covers the architecture.

---

## Module wiring

`BymaxAiTokensModule.forRootAsync(options)` is a global dynamic module. On bootstrap it:

1. Validates `BymaxAiTokensModuleOptions` (throws `AI_TOKENS_INVALID_CONFIG` on bad options).
2. Applies defaults (`applyDefaults()` in `server/config/`).
3. Wires services: `PricingService` → `LedgerService` → `MarkupResolver` → `MeteringService` (+ `WalletService`, `BudgetService`, `UsageReportService`, `ContentCapture`, `TelemetryEmitter`).
4. Registers `EventDispatcher` and `HoldReaper` as lifecycle-aware providers.
5. Exports all public services + constants + DI tokens as module exports (so other modules can inject them without re-importing the root module).

`PricingService.onModuleInit()` seeds the price registry from `MODEL_PRICES_SEED` when `pricing.seedFromSnapshot: true`.

`EventDispatcher.onModuleInit()` lazily discovers the optional `@nestjs/event-emitter` instance via `ModuleRef` — the emitter is absent without error when the peer is not installed.

`HoldReaper` sweeps expired holds on the configurable interval (`holds.sweepIntervalSeconds`, default 60 s) starting from `onApplicationBootstrap()` and stopping at `onApplicationShutdown()`.

---

## Rating flow

### Rate-table mode (default)

```
raw response usage
       ↓
  normalizer  (provider-specific pure function → NormalizedUsage)
       ↓
  PricingService.resolveRate()  (§6.6 six-step chain: exact → tier-wildcard → canonical-alias → modelId-normalize → prefix-match → not-found)
       ↓
  computeCostNanoUsd(usage, rate)  (bigint nano-USD, token + surcharge breakdown)
       ↓
  MarkupResolver.resolve()  (fixed multiplier or IMarkupPolicy)
       ↓
  applyMarkup(rawCostNanoUsd, multiplier)  (→ billedCostNanoUsd, persisted as Decimal(20,0))
       ↓
  LedgerService.append()  (idempotency + hash-chain + DB write)
```

### Provider-reported mode

When `ratingMode: 'provider-reported'`, `NormalizedUsage.providerReportedCostNanoUsd` is used directly as `rawCostNanoUsd`. Markup still applies. The price registry is not consulted. This mode is primarily for OpenRouter where the upstream cost is available.

---

## Hold lifecycle (spend reservation)

```
hold(ctx, estimate)
  → PENDING record in ledger (excluded from hash chain and spend aggregates)
  → Optional wallet reserve (balance − estimate.amountNanoUsd)
  → Optional budget counter increment (Redis or DB)
  → Returns Hold { holdId, tenantId, ... }

capture(hold, usage | collector)
  → Resolve NormalizedUsage from the collector if needed
  → Rate the actual usage
  → Transition PENDING → POSTED with actual amounts
  → Wallet debit = actual billedCostNanoUsd (not the estimate)
  → Budget counter adjust (delta = actual − estimate)
  → IDEMPOTENT: a second capture returns the already-settled record

release(hold)
  → Transition PENDING → RELEASED
  → Restore wallet reserve
  → Release budget counter (decrement by estimate)
  → Emits ai_tokens.hold.released

HoldReaper (periodic sweep)
  → Queries PENDING records older than holds.ttlSeconds
  → Runs the same restoration path as release()
  → Emits ai_tokens.hold.released with { expired: true }
```

---

## Enforcement ports

### BudgetGuard (CanActivate)

Runs BEFORE the handler. Steps:
1. Read `@RequireBudget` / `@Meter` / `@AiFeature` metadata via `Reflector`.
2. Call `scopeResolver(ctx)` to get the `MeteringContext` (TRUSTED INPUT — from verified auth).
3. Call `BudgetService.getStatus()` to check all matching budgets.
4. If any HARD budget is `exhausted` → throw `AI_TOKENS_BUDGET_EXCEEDED` or `AI_TOKENS_QUOTA_EXCEEDED`.
5. Enrich `request.aiTokens = { status, context, hold? }`.
6. If `@RequireBudget.estimate` → call `metering.hold()` and attach the `Hold` to `request.aiTokens.hold`.

The guard is **check-only** (no consumption) unless `estimate` is present. The §10.8 atomic consume still protects the actual charge at record/capture time.

### MeteringInterceptor (NestInterceptor)

Runs AFTER the handler. Steps:
1. Read `@Meter` metadata.
2. Extract usage from the handler's return value (via `Meter.extract`, default `result.usage`).
3. If a hold is on `request.aiTokens.hold` → call `metering.capture(hold, usage)`.
4. Otherwise → call `metering.record({ usage, context, enforce: meter.enforcing })`.
5. Optionally set `X-AI-Tokens-*` response headers (`exposeHeaders: true`).

---

## Streaming capture (StreamUsageCollector)

Accumulates chunks by feeding each SSE chunk to `collector.push(chunk)`. At `collector.finalize()`:
- If a final usage chunk was seen → return the normalized provider usage.
- If no final chunk (aborted) → tokenize the accumulated output text and return estimated counts.
- If neither → throw `AI_TOKENS_STREAM_USAGE_MISSING`.

Pass a `StreamUsageCollector` instance directly to `capture()` instead of a resolved `NormalizedUsage` — the metering service calls `finalize()` internally.

---

## Event system

Two composable channels (spec §12.1):

1. **`@nestjs/event-emitter` bridge** — lazy: discovered at `onModuleInit`. Absent = silent no-op.
2. **`IEventSink` port** — injected via `events.sink` in module options. Failures are logged, never thrown.

`EventDispatcher` multiplexes all domain events to both channels. Domain hooks (`createMeteringEventHooks`, `createBudgetEventHooks`, `createWalletEventHooks`) are plain function objects injected into services — no direct EventEmitter dependency in service code.

---

## Telemetry

`ITelemetrySink` is injected via `telemetry.sink`. The library ships `OtelTelemetrySink` (wraps `@opentelemetry/api`) and `NoOpTelemetrySink`. Every `meter()` / `record()` / `hold()` / `capture()` / `release()` creates a span. Missing peer → automatic no-op.

---

## Testing strategy

- **Unit:** Jest, 100% line/branch per implemented file (655 tests). Pure functions tested with `fast-check` property tests (money math, markup composition, normalizer invariants). Services tested with in-memory fakes implementing the storage ports.
- **E2E:** Testcontainers (PostgreSQL 16 + Redis 7). 10 scenarios: record/hold/capture/release, streaming, wallets, budgets, reporting, multi-tenant isolation. One `GenericContainer` set at a time — never concurrent.
- **Mutation:** Stryker (break 95). Critical paths: cost engine, model resolution, ledger state machine, conditional debit/consume, window anchoring.

---

## File layout

```
src/
  prices/          MODEL_PRICES_SEED (data-only, ./prices subpath)
  prisma/          PrismaAiTokensStore + SQL helpers (./prisma subpath)
  redis/           RedisBudgetCounterStore (./redis subpath)
  server/          NestJS module + services + enforcement (. subpath)
    bymax-ai-tokens.module.ts    Root dynamic module
    bymax-ai-tokens.constants.ts DI token symbols
    config/          Option validation + defaults
    enforcement/     BudgetGuard, MeteringInterceptor, decorators, HoldReaper
    errors/          AiTokensException + error code/message/status maps
    events/          EventDispatcher + EventEmitter bridge
    interfaces/      Port interfaces (IAiTokensStore, ILedgerStore, ...)
    services/        PricingService, LedgerService, WalletService, BudgetService,
                     MeteringService, UsageReportService, MarkupResolver, ContentCapture
    streaming/       StreamUsageCollector
    telemetry/       OtelTelemetrySink, NoOpTelemetrySink
    utils/           hash-chain, model-id, payload-hash, scope-wallet, to-json-safe, window-anchor
  shared/          Zero-dep layer (./shared subpath)
    constants/       PROVIDER_IDS, AI_OPERATIONS, SERVICE_TIERS, ...
    normalizers/     9 provider normalizers (pure functions)
    pricing/         computeCostNanoUsd, applyMarkup, money utilities
    types/           Canonical TypeScript types (NormalizedUsage, UsageRecord, Budget, ...)
    utils/           deriveIdempotencyKey, sha256Hex
test/
  contracts/       Port contract tests (any adapter must pass)
  docs-fixtures/   Type-check-only fixtures for JSDoc @example blocks and README samples
  e2e/             Testcontainers end-to-end scenarios
  fakes/           In-memory store implementations for unit tests
```

---

## DI tokens

| Token | Resolves to |
|---|---|
| `BYMAX_AI_TOKENS_OPTIONS` | `ResolvedAiTokensOptions` |
| `BYMAX_AI_TOKENS_LEDGER_STORE` | `ILedgerStore` |
| `BYMAX_AI_TOKENS_PRICING_STORE` | `IPricingStore` |
| `BYMAX_AI_TOKENS_WALLET_STORE` | `IWalletStore` |
| `BYMAX_AI_TOKENS_BUDGET_STORE` | `IBudgetStore` |
| `BYMAX_AI_TOKENS_BUDGET_COUNTER` | `IBudgetCounterStore` |
| `BYMAX_AI_TOKENS_TOKENIZER` | `ITokenizer` |
| `BYMAX_AI_TOKENS_TELEMETRY` | `ITelemetrySink` |
| `BYMAX_AI_TOKENS_EVENT_SINK` | `IEventSink` |
| `BYMAX_AI_TOKENS_CONTENT_STORE` | `IContentStore` |
| `BYMAX_AI_TOKENS_LOGGER` | `LoggerService` |

---

## Reference

Full spec: `docs/technical_specification.md`  
Critical rules: `CLAUDE.md`  
Security threat model: `SECURITY.md`
