#!/usr/bin/env node
// @ts-check
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'

/**
 * Brotli-compressed bundle budgets in bytes (never gzip). Every peer dependency
 * (NestJS, Prisma, ioredis, the event emitter, OpenTelemetry) stays external, so
 * each shipped bundle is library code only. The `shared` entry is pure types,
 * constants, normalizers, and cost math; the `prices` entry is a data-only price
 * snapshot and is EXEMPT from a budget (its size is reported for visibility).
 * Measured at maximum brotli quality.
 */
const BUDGETS = [
  // 43_740: the services, the idempotent replay path in `record()` (per-key serialization,
  // request-field matching, the shared field-role table), the instant that locates a budget window
  // on every charge, rollback and reversal, and the enforcement that runs before the record is written
  // (its charge, its rollback, the replay of its wallet debit and the test of whether a losing attempt shares it), and
  // the same settlement of a failed append for a hold, the tenant check of the budget admin paths, and the caller check of capture and
  // release. The budget keeps headroom so a correct fix is not squeezed to fit. A change that grows this bundle past the budget states why in its
  // commit and its CHANGELOG entry.
  // 49_790: the budget-reference sweeper, the verdict and lookup module that decides each reference, the settlement
  // retention option and its boot validation, the key helpers they share, and the read of the compensating row's marker
  // before a reversal's application is pruned, and the pause of the given-back pruning while an owed marker is older than the
  // retention.
  // 51_190 adds the give-back of orphan wallet debits: the sweeper that walks the debit listing and appends the claim row
  // (about 1.3 KB), the claim and rollback-key helpers (about 0.4 KB), and the refund branch, the refusal of a late append
  // and the reaper step that call them.
  // 51_582 adds the per-tenant guard of the given-back pruning: the read of the tenants that owe effects, the fallbacks to the
  // pause for every tenant, and the call of the store's pruning that spares them.
  // 51_653 holds the row's instant that the hold's reservation and its two rollbacks take, to locate the windows they charge
  // and give back.
  // 51_838 holds the guard that keeps the reaper's timer from starting a sweep while the previous one runs, and its skipped-tick line.
  // 52_383 holds the guards of the numbers the library takes at its boundaries: the options of the wallets, the budget limits and
  // thresholds, the wallet amounts and grant fields, the hold estimates and the token counts of a usage.
  // 52_442 holds the shared summary of a caught error that the reaper and the two sweepers log.
  // 53_046 holds the tests of the documented budget policies and rating modes, the policy a stored budget is evaluated with, the
  // lists of option keys that a group of options set to null is read through, and the refusal of a null integrity-chain flag.
  // 53_286 holds the tests of the dates a caller supplies: a budget's anchor and expiry, a rotation's and a reconciliation's window
  // start, a record's instant, an estimate's and a rate lookup's instant, a budget movement's instant, a price version's start and the
  // bounds of a ledger, report or wallet-entry filter.
  // 53_610 holds the watchdog that abandons a hold-reaper sweep that never settles, and its stalled-tick line.
  // 53_604 holds the bound on an identifier that an error's details carry.
  // 61_963 holds the argument guards of every public method (typed refusal of an argument of the wrong kind), the supported range and the cross-realm test of a date,
  // the shape checks of every option group and switch, the wallet reconcile mapping, the cap of two running reaper sweeps, the single read of every date a caller supplies, the NUL and range checks of text and amounts, the field reads that refuse a getter that throws, the copy of the lists and objects nested in an input with the plain-key label of a refusal, and the absorption of a failing sink or callback with the total description of an error.
  // It also holds the typed field list of every input of the metering calls, the wallet reference, the scopes and the rate lookup, read by name, the per-variant read of a hold estimate, the ancestor path and the depth of the usage read of a record and a capture, the budget of containers and values one read may visit, and the view that hands a raw provider response to its normalizer.
  // The prisma bundle's 16_042 holds the boundary that types every failure of the store, and the stale-reference, prune and given-back statements, the budget-row statement
  // builders, the cross-wallet debit listing, the given-back pruning that spares tenants and the shape test of the driver code
  // that a store error repeats. 16_786 adds the adapter kinds that mean the connection, not the call, failed, and the brand test that reads a date of another realm as a date.
  // 63_247 (server) and 17_710 (prisma) hold the check of every store, host and driver promise before and after its native await, the realm and
  // intrinsic checks, and the array helpers that read no live Array.prototype member; each budget is the measured size plus 30. The server's
  // 63_247 also holds the wait that marks the rejection of a host promise as handled when the realm check refuses it, a native await in a
  // try/catch that reads no `Promise[Symbol.species]`. 63_319 (server) also holds the thenable test of the guarded store (a plain object with a `then` of its own), the
  // choice of the Proxy test by the caller of `settled`, and the engine-prototype capture of the promise module; the server bundle measures 63_289.
  // 63_367 (server) also holds the handled rejection of a promise refused on a polluted realm and the Proxy-on-chain check kept when thenables are
  // allowed; the server bundle measures 63_337.
  // 64_201 (server) and 19_478 (prisma) also hold the refund to its source (the debit lookup, the cap, the split by largest remainder, the expiry of a part that lands
  // on an expired grant), the balance at an instant and its breakdown, the per-wallet entry sequence and the order and balance columns of every entry insert, and the
  // typed refusals and field lists of those inputs; they measure 64_171 and 19_448.
  { name: 'server (NestJS module + services)', path: 'dist/server/index.mjs', brotli: 64_201 },
  { name: 'shared (types + normalizers + cost math)', path: 'dist/shared/index.mjs', brotli: 10_000 },
  { name: 'prisma (store adapter)', path: 'dist/prisma/index.mjs', brotli: 19_478 },
  { name: 'redis (budget counter)', path: 'dist/redis/index.mjs', brotli: 5_000 },
]

// Reported for visibility only — the price snapshot is data and grows with model coverage.
const EXEMPT = [{ name: 'prices (data-only snapshot)', path: 'dist/prices/index.mjs' }]

let failed = false

// `PACKAGE_TARBALL` names the tarball a release gate has already packed: the bundles are read from the
// file that is published, not from `dist/`.
const TARBALL = process.env['PACKAGE_TARBALL']

/**
 * Reads one built artifact, from the tarball when there is one, else from the working tree.
 * @param {string} path Path of the artifact relative to the package root.
 * @returns {Buffer} The file content. Throws when the artifact is missing.
 */
function readArtifact(path) {
  if (TARBALL === undefined || TARBALL === '') return readFileSync(path)
  return execFileSync('tar', ['-xzOf', TARBALL, `package/${path}`], { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * Compute the brotli-compressed byte length of a built bundle.
 * @param {string} path Path to the bundle file.
 * @returns {number | null} Compressed size in bytes, or null when the file is missing.
 */
function brotliSize(path) {
  let raw
  try {
    raw = readArtifact(path)
  } catch {
    return null
  }
  return brotliCompressSync(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY },
  }).length
}

for (const { name, path, brotli: budget } of BUDGETS) {
  const size = brotliSize(path)
  if (size === null) {
    console.error(`✖ ${name} — ${path} missing (run "pnpm build" first)`)
    failed = true
    continue
  }
  const ok = size <= budget
  console.log(
    `${ok ? '✔' : '✖'} ${name} — ${size} B brotli / ${budget} B budget (${ok ? 'within budget' : 'OVER BUDGET'})`,
  )
  if (!ok) failed = true
}

for (const { name, path } of EXEMPT) {
  const size = brotliSize(path)
  if (size === null) {
    console.error(`✖ ${name} — ${path} missing (run "pnpm build" first)`)
    failed = true
    continue
  }
  console.log(`• ${name} — ${size} B brotli (exempt: reported only)`)
}

if (failed) {
  console.error('Bundle size budget exceeded.')
  process.exit(1)
}

console.log('All bundles within budget.')
