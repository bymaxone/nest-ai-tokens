# Mutation Testing Plan — @bymax-one/nest-ai-tokens

## Overview

Mutation testing uses [Stryker Mutator](https://stryker-mutator.io/) to validate that the test suite has sufficient sensitivity to detect realistic source-code defects.  A mutant that survives (is not killed by any test) exposes either a gap in the test suite or a provably equivalent variant that must be justified.

The threshold is **break 95** — a mutation score below 95% fails the build.

## Why mutation testing at release

100% line/branch coverage (the per-file gate) proves every statement and branch was _exercised_, but not that the tests would fail on a wrong value.  Mutation testing discovers holes: a test might hit `billedCostNanoUsd = rawCostNanoUsd * markupRounded` but not assert the sign, the order, or the correct divisor.  The gate runs once at release (not on every push) because a full run takes 10–20 minutes.

## Configuration

`stryker.config.json` in the repo root:

```json
{
  "testRunner": "jest",
  "plugins": ["@stryker-mutator/jest-runner", "@stryker-mutator/typescript-checker"],
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "jest": { "projectType": "custom", "configFile": "jest.stryker.config.ts" },
  "reporters": ["clear-text", "progress", "json"],
  "coverageAnalysis": "perTest",
  "timeoutMS": 15000,
  "mutate": [
    "src/server/**/*.ts",
    "src/shared/**/*.ts",
    "!src/**/*.spec.ts",
    "!src/**/index.ts",
    "!src/server/interfaces/**",
    "!src/server/config/resolved-options.ts",
    "!src/server/bymax-ai-tokens.constants.ts",
    "!src/server/errors/ai-tokens-error-messages.ts",
    "!src/server/errors/ai-tokens-error-status.ts",
    "!src/shared/constants/**"
  ],
  "thresholds": { "high": 100, "low": 95, "break": 95 },
  "concurrency": 1
}
```

`jest.stryker.config.ts` extends the unit-test Jest config with `maxWorkers: '50%'` to bound memory (Stryker adds a full Jest process per worker).

## How to run

```bash
# Full run (single suite, one concurrency — never fan out):
NODE_OPTIONS=--max-old-space-size=4096 pnpm mutation

# Incremental (only mutate changed files — faster in dev):
pnpm mutation:incremental

# Dry run (list mutants, do not execute tests):
pnpm mutation:dry-run
```

Run alone — do not combine with `pnpm test:e2e` or other long-running tasks in the same shell session.

## Critical mutation targets

These are the paths where a surviving mutant would represent a genuine billing defect:

| Target | Key mutation risk | Protecting test(s) |
|---|---|---|
| `shared/pricing/compute-cost.ts` | Wrong divisor in `perMillion`, dropped surcharge accumulation, wrong tier-threshold condition | `compute-cost.spec.ts` property tests + fixture suites |
| `shared/pricing/apply-markup.ts` | Wrong scale factor (10_000n), wrong operator in division, multiplier bypass | `apply-markup.spec.ts` property tests |
| `shared/pricing/money.ts` | `floatUsdToNanoUsd` rounding, `perMillion` divisor | `money.spec.ts` property tests |
| `server/services/ledger.service.ts` | State-machine transitions (PENDING/POSTED/REVERSED/RELEASED), idempotency-conflict logic, hash-chain write condition | `ledger.service.spec.ts` state machine suite |
| `server/services/metering.service.ts` | `capture()` idempotency guard, `enforce` flag gating wallet/budget, `isSystemCost` gating debit/consume | `metering.service.spec.ts` enforcement matrix suite |
| `server/services/budget.service.ts` | Window-anchor calculation, consume/release symmetry, unlimited-semantics condition (`limit === undefined`), 0-block condition | `budget.service.spec.ts` window + unlimited suite |
| `server/services/wallet.service.ts` | Conditional debit (balance + overdraft check), burn-order selection, entry type guards | `wallet.service.spec.ts` debit suite |
| `server/services/pricing.service.ts` | Resolution-chain step order, cache expiry condition, tier-wildcard fallback | `pricing.service.spec.ts` resolution chain suite |
| `shared/normalizers/*.normalizer.ts` | Reconciliation invariants (input + cacheRead + cacheWrite = providerTotal; output − reasoning = outputTokens) | `*.normalizer.spec.ts` fast-check property suites |
| `server/utils/window-anchor.ts` | Month-end clamping, UTC anchor arithmetic | `window-anchor.spec.ts` |
| `server/utils/hash-chain.ts` | Hash-chain link construction | `hash-chain.spec.ts` |

## Exclusions (justified)

| Excluded path | Reason |
|---|---|
| `src/**/index.ts` | Barrel re-exports only — mutations produce import errors, not logic defects |
| `src/server/interfaces/**` | Interface declarations — no executable code to mutate |
| `src/server/config/resolved-options.ts` | Plain type alias — no executable code |
| `src/server/bymax-ai-tokens.constants.ts` | Symbol literals — mutations produce type errors, not logic defects |
| `src/server/errors/ai-tokens-error-messages.ts` | String constants — mutations produce cosmetic message changes, not billing defects |
| `src/server/errors/ai-tokens-error-status.ts` | HTTP status map — mutations change HTTP status codes, detectable by contract tests but not the per-path unit tests |
| `src/shared/constants/**` | Catalog constants — mutations produce import errors |

## Results

See `docs/mutation_testing_results.md`.
