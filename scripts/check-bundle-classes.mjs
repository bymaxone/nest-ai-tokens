#!/usr/bin/env node
/**
 * @fileoverview Bundle class gate.
 * @layer scripts
 *
 * The entry points are separate, self-contained bundles. A module that one of them imports by a relative
 * path is copied into it, and so is every class that module reaches: a copy of a class the package root
 * exports is a different `instanceof` target, and the server's guards then stop recognising what the
 * entry point throws, without any error. Source-based gates cannot see it, because the unit suite maps
 * the specifiers to `src` and sees one copy.
 *
 * This gate lists the classes each bundle defines and compares the list with the classes that bundle is
 * meant to own, in ESM and CommonJS. A class that is not on the list is a copy that arrived by an
 * import, so it fails here. A class that is added on purpose is added to the list in the same change.
 *
 * Usage: `node scripts/check-bundle-classes.mjs [distDir]` (run after `pnpm build`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = process.argv[2] ?? join(rootDir, 'dist')

/**
 * The classes each secondary bundle owns. `LedgerIdempotencyConflict` and `WalletMissingError` are signals
 * the server recognises by a brand property, not by `instanceof`, so each bundle carries its own on purpose.
 * The root bundle is not listed: it defines the classes the others must not copy.
 */
const OWNED = {
  prisma: ['LedgerIdempotencyConflict', 'PrismaAiTokensStore', 'WalletMissingError'],
  redis: ['CounterValueOutOfRangeError', 'RedisBudgetCounterStore'],
  shared: [],
  prices: [],
}

/** The names of the classes a bundle defines, from `class X`, `var X = class` and `X = class` forms. */
export function classesDefined(source) {
  const names = new Set()
  for (const match of source.matchAll(/(?:^|[\s;{}(,=])class\s+(?!extends\b)([A-Za-z_$][\w$]*)/gm))
    names.add(match[1])
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*class\b/g)) names.add(match[1])
  return [...names].sort()
}

let failed = false
console.log('Bundle class gate')
for (const [entry, owned] of Object.entries(OWNED)) {
  for (const extension of ['mjs', 'cjs']) {
    const file = join(distDir, entry, `index.${extension}`)
    if (!existsSync(file)) {
      console.error(`  ✗ ${entry}/index.${extension} is missing — run \`pnpm build\` first`)
      failed = true
      continue
    }
    const defined = classesDefined(readFileSync(file, 'utf8'))
    const copies = defined.filter((name) => !owned.includes(name))
    const missing = owned.filter((name) => !defined.includes(name))
    if (copies.length > 0) {
      console.error(
        `  ✗ ${entry}/index.${extension} defines ${copies.join(', ')}, which it does not own: a relative import copied it into the bundle`,
      )
      failed = true
    }
    if (missing.length > 0) {
      console.error(
        `  ✗ ${entry}/index.${extension} no longer defines ${missing.join(', ')}: update the list in this script if that is intended`,
      )
      failed = true
    }
    if (copies.length === 0 && missing.length === 0)
      console.log(
        `  ✓ ${entry}/index.${extension}: ${defined.length === 0 ? 'no classes' : defined.join(', ')}`,
      )
  }
}
if (failed) process.exit(1)
console.log('✓ Every bundle defines only the classes it owns.')
