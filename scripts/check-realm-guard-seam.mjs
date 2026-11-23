/**
 * @fileoverview Proves that the test seam of the realm guard is not part of the published package. The seam (`setRealmGuard`,
 * `withoutRealmGuard`) turns the guard off for the specs that plant keys on `Object.prototype` on purpose; a consumer that could reach it
 * could switch the guard off. No built file, bundle or declaration may name it, and the `exports` map may open no path by pattern that could
 * reach a source file. Run after `pnpm build`, as part of `check:published`.
 * @layer scripts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The names of the seam. */
const SEAM = ['setRealmGuard', 'withoutRealmGuard']

/** Every file under `dir` whose name ends with one of `suffixes`. */
function filesUnder(dir, suffixes) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path, suffixes)
    return suffixes.some((suffix) => entry.name.endsWith(suffix)) ? [path] : []
  })
}

const files = filesUnder(join(ROOT, 'dist'), ['.mjs', '.cjs', '.d.ts', '.d.cts'])
const leaks = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const name of SEAM) if (new RegExp(`\\b${name}\\b`).test(text)) leaks.push(`${name} in ${relative(ROOT, file)}`)
}
const patterns = Object.keys(PKG.exports ?? {}).filter((key) => key.includes('*'))
if (patterns.length > 0) leaks.push(`the exports map opens a pattern: ${patterns.join(', ')}`)
if (files.length === 0) leaks.push('no built file to check: run `pnpm build` first')

if (leaks.length > 0) {
  console.error(`✖ The realm guard seam is reachable from the package:\n${leaks.map((leak) => `  - ${leak}`).join('\n')}`)
  process.exit(1)
}
console.log(`✔ The realm guard seam (${SEAM.length} names) is absent from ${files.length} built files, and the exports map opens no pattern.`)
