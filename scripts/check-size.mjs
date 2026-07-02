#!/usr/bin/env node
// @ts-check
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
  { name: 'server (NestJS module + services)', path: 'dist/server/index.mjs', brotli: 40_000 },
  { name: 'shared (types + normalizers + cost math)', path: 'dist/shared/index.mjs', brotli: 10_000 },
  { name: 'prisma (store adapter)', path: 'dist/prisma/index.mjs', brotli: 15_000 },
  { name: 'redis (budget counter)', path: 'dist/redis/index.mjs', brotli: 5_000 },
]

// Reported for visibility only — the price snapshot is data and grows with model coverage.
const EXEMPT = [{ name: 'prices (data-only snapshot)', path: 'dist/prices/index.mjs' }]

let failed = false

/**
 * Compute the brotli-compressed byte length of a built bundle.
 * @param {string} path Path to the bundle file.
 * @returns {number | null} Compressed size in bytes, or null when the file is missing.
 */
function brotliSize(path) {
  let raw
  try {
    raw = readFileSync(path)
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
