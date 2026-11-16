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
  // The prisma bundle's 15_624 holds the stale-reference, prune and given-back statements, the budget-row statement
  // builders and the cross-wallet debit listing.
  { name: 'server (NestJS module + services)', path: 'dist/server/index.mjs', brotli: 51_190 },
  { name: 'shared (types + normalizers + cost math)', path: 'dist/shared/index.mjs', brotli: 10_000 },
  { name: 'prisma (store adapter)', path: 'dist/prisma/index.mjs', brotli: 15_624 },
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
