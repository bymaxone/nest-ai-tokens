# Mutation Testing Results — @bymax-one/nest-ai-tokens

> **Gate**: break 95 · **Result**: ✅ PASS · **Score**: `100.00`% · **Run**: full suite, `concurrency: 1`, Stryker 9.6.1 + Jest runner + TypeScript checker.

This document records the release mutation-testing run for `v0.1.0` and justifies every surviving (intentionally-ignored) mutant. See [`mutation_testing_plan.md`](./mutation_testing_plan.md) for configuration, critical targets, and exclusions.

## Summary

| Metric | Count |
|---|---|
| Mutants generated | 3,447 |
| Killed | 1,425 |
| Timeout (killed) | 2 |
| **Survived** | **0** |
| No coverage | 0 |
| Ignored (compile error) | 1,547 |
| Ignored (justified equivalents) | 473 |
| **Mutation score** | **100.00%** (break 95) |

Every mutant is accounted for: it is either **killed** by a test that asserts the mutated behavior would be wrong, or **ignored** via an inline `// Stryker disable next-line` directive carrying a justification. No mutant survives undocumented, and the break threshold was never lowered.

The `Ignored (compile error)` mutants are discarded by Stryker's TypeScript checker before execution: under the project's strict compiler settings (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) many mutations produce uncompilable code and cannot represent a real defect.

## Provably-equivalent survivors (justified `// Stryker disable`)

The following mutants cannot be killed by any unit test because the mutation is behavior-preserving. Each carries an inline directive in the source with the same justification.

### Redundant defensive guards — the invalid input throws downstream anyway

| Location | Mutator(s) | Why it is equivalent |
|---|---|---|
| `shared/pricing/money.ts` `floatUsdToNanoUsd` guard | ConditionalExpression, BlockStatement | A non-finite `usd` still throws `RangeError` downstream via `BigInt(NaN)` / `BigInt(Infinity)`. Bypassing or emptying the `Number.isFinite` guard is behavior-preserving (same error type); the message is not part of the contract. |
| `shared/pricing/money.ts` `formatNanoUsd` decimals guard | 4× ConditionalExpression, 2× LogicalOperator, BlockStatement | Any invalid `decimals` independently throws `RangeError` downstream via `10n ** BigInt(9 - decimals)` (negative exponent) or `BigInt(9 - decimals)` (non-integer). The bounds guard is a redundant fast-path; removing it preserves the observable `RangeError`. |
| `server/services/hold-support.ts` `isNormalizedUsage` object guard | ConditionalExpression (`typeof usage !== 'object' → false`) | A non-object / non-null value is still rejected by the downstream `typeof candidate.provider !== 'string'` check, so `isNormalizedUsage` still returns `false`. The non-equivalent variants of this guard are killed by the direct spec. |
| `server/services/hold-support.ts` `isNormalizedUsage` field guard | ConditionalExpression (`typeof candidate[field] === 'number' → true`) | A non-number field still fails the `Number.isFinite(candidate[field])` operand, so `.every(...)` returns `false`. Equivalent. |

### Boundary-at-zero and null-cast no-ops

| Location | Mutator | Why it is equivalent |
|---|---|---|
| `server/streaming/stream-usage-collector.ts` `asRecord` | ConditionalExpression (`value !== null → true`) | For a `null` value, `typeof value === 'object'` is true but the cast still yields `null`, so `asRecord(null)` returns `null` regardless. |
| `server/services/metering.service.ts` `finalizeCaptureUsage` fallback override | ConditionalExpression (`hold.estimatedTokens > 0 → true`) | The override runs only when `finalized.inputTokens === 0`; at `estimatedTokens === 0` it sets `inputTokens` back to `0`, unchanged. (The `> 0` vs `>= 0` `EqualityOperator` variant on the same line is equivalent for the same reason; both share one directive.) The real override path is covered by the aborted-stream / hold-estimate specs. |
| `shared/utils/idempotency.ts` `canonicalize` null/undefined shortcut | ConditionalExpression (`value === undefined → false`) | Dropping the `undefined` operand still routes `undefined` through every subsequent type check to the final `return 'null'`, producing the identical canonical form. |

## Coverage gaps closed — mutants killed by strengthened tests

The following mutants originally survived because a test *exercised* the code but did not *assert* the mutated behavior would be wrong. Each is now killed by a targeted assertion.

| Location | Mutator | Killing test |
|---|---|---|
| `server/enforcement/metering.interceptor.ts` `extractUsage` | ConditionalExpression (`usage === null → false`) | *rejects an explicitly null extracted usage with USAGE_MALFORMED* — a `{ usage: null }` result slips past the mutated guard into `record()`, which throws a different code. |
| `server/services/pricing.service.ts` longest-prefix resolution | ConditionalExpression (`candidate.length > bestLength`) | *keeps the longest prefix when a shorter candidate is iterated last* — seeds the longer prefix first so `→ true` wrongly picks the shorter last candidate and `→ false` returns null. |
| `server/services/usage-report.service.ts` `serialize` conversion flag | ConditionalExpression (`fx !== undefined → true`) | *omits converted columns for a non-USD currency when no fx function is provided* — BRL + undefined `fx` must emit no conversion columns. |
| `shared/utils/idempotency.ts` `canonicalize` boolean branch | ConditionalExpression (`typeof value === 'boolean' → false`) | *distinguishes boolean values from null and from each other* — a boolean must not collapse to the `'null'` sentinel. |

### Best-effort `catch` bodies — killed with logger-spy tests

Stryker 9.6.1 does not honor `// Stryker disable next-line` on a **catch-clause body** `BlockStatement`. Rather than rely on a non-functional directive, these swallow-and-warn catch blocks are killed by forcing the inner awaited operation to reject and asserting `Logger.prototype.warn` fired (emptying the catch skips the warn). The inner `StringLiteral` message-line directives are retained (those *do* work).

| Location | Killing test |
|---|---|
| `server/services/metering-effects.ts` `compensateHold` wallet-refund catch | *does not throw when the rollback wallet refund fails* |
| `server/services/metering-effects.ts` `compensateHold` budget-release catch | *does not throw when the rollback budget release fails* |
| `server/services/metering-effects.ts` `reverseEffects` wallet-refund catch | *does not throw when the wallet refund fails during reversal* |
| `server/services/metering-effects.ts` `reverseEffects` budget-release catch | *does not throw when the budget release fails during reversal* |
| `server/services/budget.service.ts` `rotateWindow` counter-reset catch | *resets counter keys on rotation* |
| `server/services/budget.service.ts` `adjustCounter` catch | *logs a counter failure without throwing* |
| `server/services/budget.service.ts` `decrCounters` rollback catch | *rolls back a sibling counter on a partial multi-budget failure* |

## Notes

- **Deterministic clock in wallet tests.** Two hold-lifecycle tests originally froze the injected clock at real `new Date()` *before* seeding a wallet grant, whose `effectiveAt` is stamped from the real clock. Under load the grant could read as not-yet-effective and the hold's `conditionalDebit` flaked. Both now freeze the clock one hour ahead (matching the sibling expiry test), so the grant is always effective — the mutant-killing intent (pinning `ttlSeconds × 1000` vs `÷ 1000`) is preserved because each test reassigns the clock to a `record.createdAt`-relative instant afterward.
- **Production code is comment-only.** Reaching the gate never changed production logic or values — only inline `// Stryker disable next-line` directives were added (and seven non-functional catch-body directives removed in favor of tests). No money path acquired `parseFloat`/`toFixed`/float arithmetic.

_Run reproduced with `pnpm mutation` (single suite, `concurrency: 1`)._
