# nest-ai-tokens-example

Reference implementation for [`@bymax-one/nest-ai-tokens`](https://github.com/bymaxone/nest-ai-tokens).

Demonstrates every pattern from the library's [§21 Example Integration](../../docs/technical_specification.md) section in a runnable NestJS 11 application:

- **§21.1** — Post-hoc metering via `MeteringService.record()`
- **§21.2** — Enforced metering via `MeteringService.meter()` (hold → capture)
- **§21.3** — Declarative controller-level metering with `BudgetGuard` + `@Meter` + `MeteringInterceptor`
- **§21.5** — Reselling with markup (4×), prepaid credits ($5/credit), count quotas
- **§21.7** — Trainer-pays-for-client (payer ≠ beneficiary)

No real API keys are needed — a `FakeLlmService` returns deterministic responses.

---

## What it demonstrates

| Pattern | Route | Spec ref |
|---|---|---|
| Post-hoc record | `POST /ai/chat` | §21.1 |
| hold → capture | `POST /ai/summarize` (via `meter()`) | §21.2 |
| Declarative guard + interceptor | `POST /ai/summarize` | §21.3 |
| Budget status | `GET /ai/me/usage` | §21.3 |
| Usage report | `GET /ai/me/summary` | §3.5 |
| Trainer-pays-for-client | `POST /ai/trainer/generate` | §21.7 |
| Grant credits (admin) | `POST /admin/grant` | §21.5 |
| Upsert plan budget (admin) | `POST /admin/budget` | §21.5 |
| Reverse record (admin) | `POST /admin/reverse` | §8.5 |
| Export CSV (admin) | `GET /admin/export` | §3.5 |

---

## How to run

### Prerequisites

- Node.js >= 24
- pnpm >= 10
- Docker (for postgres + redis)

### Steps

```bash
# 1. Start database and Redis
docker compose up -d

# 2. Install dependencies
pnpm install

# 3. Copy environment
cp .env.example .env

# 4. Run migrations and seed
pnpm prisma:migrate
pnpm prisma:seed

# 5. Start the dev server
pnpm start:dev
```

The app runs at `http://localhost:3000`.

---

## curl walkthrough

A complete walkthrough script is at `scripts/curl-walkthrough.sh`:

```bash
bash scripts/curl-walkthrough.sh
```

Or individual requests:

### Post-hoc metering

```bash
curl -X POST http://localhost:3000/ai/chat \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-demo" \
  -H "x-user-id: user-demo" \
  -d '{"prompt":"What is TypeScript?","requestId":"req-1"}'
# → {"reply":"Echo: What is TypeScript?...","billedCostNanoUsd":"123456789"}
```

### Declarative guard + interceptor (check response headers)

```bash
curl -sv -X POST http://localhost:3000/ai/summarize \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-demo" \
  -H "x-user-id: user-demo" \
  -d '{"text":"Long document...","requestId":"req-2"}'
# Response headers include X-AI-Tokens-Cost and X-AI-Tokens-Remaining
```

### Budget status

```bash
curl http://localhost:3000/ai/me/usage \
  -H "x-tenant-id: tenant-demo" \
  -H "x-user-id: user-demo"
# → {"budgets":[{"spentTokens":"...","limitTokens":"500000",...}],...}
```

### Budget exhaustion

After the monthly token limit is reached, `/ai/summarize` returns `HTTP 429` because
`BudgetGuard` blocks the request at the enforcement layer (spec §10.5):

```bash
# The guard blocks with AI_TOKENS_BUDGET_EXCEEDED once tokens are exhausted
# Status: 429 Too Many Requests
```

### Admin: grant credits

```bash
curl -X POST http://localhost:3000/admin/grant \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-demo" \
  -H "x-user-id: user-demo" \
  -H "x-role: admin" \
  -d '{"userId":"user-demo","tenantId":"tenant-demo","amountNanoUsd":"25000000000","reason":"monthly allowance","idempotencyKey":"grant:user-demo:2026-07"}'
```

### Export CSV

```bash
curl "http://localhost:3000/admin/export?tenantId=tenant-demo&from=2026-07-01&to=2026-07-31" \
  -H "x-tenant-id: tenant-demo" \
  -H "x-user-id: user-demo" \
  -H "x-role: admin" \
  -o usage.csv
```

---

## Schema merge workflow (spec §15.3)

The Prisma schema at `prisma/schema.prisma` merges the library's seven-table fragment
with the application's own `User` model.

To add the library's tables to an existing Prisma app:

1. Copy the `# @bymax-one/nest-ai-tokens seven-table fragment` block from `prisma/schema.prisma`
   into your application's schema.
2. Run `prisma migrate dev --name add-ai-tokens`.
3. Pass `new PrismaAiTokensStore(prisma)` as the `store` option in `forRootAsync()`.

Column names in the fragment must not be renamed — `PrismaAiTokensStore` uses raw SQL
parameterized queries that reference them by name.

---

## Authentication note

This example uses `x-tenant-id`, `x-user-id`, and `x-role` headers as a minimal identity
stub. In production, use a JWT guard or session middleware to populate `request.user` with
verified claims. The `scopeResolver` in `AppModule` is the point where the library reads
the metering context — trust only what your auth layer has verified.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_URL` | — | Redis URL (optional; omit to use DB-based budget counters) |
| `PORT` | `3000` | HTTP listen port |
| `AI_MARKUP` | `4.0` | Resale multiplier applied to provider cost |
| `AI_CREDIT_RATE_NANO_USD` | `5000000000` | Nano-USD value of 1 credit ($5) |

---

## License

MIT — see [../../LICENSE](../../LICENSE)
