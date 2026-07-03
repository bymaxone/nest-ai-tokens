#!/usr/bin/env node
// @ts-check
/**
 * Lightweight JSDoc coverage sweep.
 *
 * Scans every non-spec TypeScript source file and reports exported CLASS,
 * FUNCTION, CONST, INTERFACE, TYPE alias (not re-export), and ENUM
 * *declarations* that lack a preceding JSDoc block comment (`/** ... *\/`).
 *
 * Re-export lines (`export { ... } from`, `export * from`, `export type { ... } from`)
 * are intentionally excluded — JSDoc must live on the definition, not the re-export.
 *
 * Exit 0 when all covered; exit 1 when any violation is found.
 */

import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')

/** Walk a directory recursively, yielding .ts files (no .spec.ts). */
function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      yield* walkTs(full)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.spec-d.ts')) {
      yield full
    }
  }
}

/**
 * An export DECLARATION introduces a new symbol in this file.
 * It must be followed by an identifier character (letter, `_`, or `$`) — this
 * excludes `export type { ... } from` and `export { ... } from` re-exports.
 *
 * Matched forms:
 *   export class Foo
 *   export abstract class Foo
 *   export function foo
 *   export const FOO
 *   export interface IFoo
 *   export type Foo = ...   (type alias declaration, not re-export)
 *   export enum Foo
 *   export default class / export default function
 */
const EXPORT_DECL = /^export\s+(abstract\s+)?(default\s+)?(class|function|const|interface|type|enum)\s+[\w$]/

/** Determine whether the line at `idx` (0-based) is preceded by a JSDoc block. */
function hasPrecedingJsdoc(lines, idx) {
  // Walk backwards skipping blank lines and decorator lines (@Injectable, @Injectable(), etc.)
  let i = idx - 1
  while (i >= 0 && (lines[i].trim() === '' || /^\s*@[\w(]/.test(lines[i]))) {
    i--
  }
  if (i < 0) return false
  const prev = lines[i].trim()
  return prev.endsWith('*/')
}

const issues = []

for (const file of walkTs(SRC)) {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!EXPORT_DECL.test(trimmed)) continue
    if (!hasPrecedingJsdoc(lines, i)) {
      issues.push(`${relative(ROOT, file)}:${i + 1}  ${trimmed.slice(0, 80)}`)
    }
  }
}

if (issues.length === 0) {
  console.log('✔ JSDoc coverage: all exported declarations documented.')
  process.exit(0)
} else {
  console.error('✖ Missing JSDoc on exported declaration(s):')
  for (const issue of issues) console.error(`  ${issue}`)
  console.error(`\n${issues.length} violation(s). Add a /** ... */ block before each.`)
  process.exit(1)
}
