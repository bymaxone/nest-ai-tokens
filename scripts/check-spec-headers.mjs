#!/usr/bin/env node
/**
 * @fileoverview Spec-header gate — every tracked spec file opens with a block comment that states what it
 * tests and which layer it belongs to, unless the file is on a frozen baseline that can only shrink.
 * @layer scripts
 *
 * A reader opens a spec without the source beside it, and the header is the one place that says what the file covers
 * and where it sits. The comment comes before the first statement, carries a layer marker (`@layer server` or
 * `Layer: server.`), and says something besides the marker. The JSDoc gate skips spec files, so nothing else
 * enforces it.
 *
 * A spec that already lacks a header is listed in the baseline, so the check can be red for what a change
 * introduces without failing on what the repository inherits. The list is kept honest from both sides:
 *
 * - a spec without a valid header that is not on the baseline fails (a new offender);
 * - a baselined spec that now has a valid header, or is no longer tracked, fails until its entry is removed,
 *   so a fixed file cannot quietly regress later.
 *
 * With `--base <ref>` the baseline is also compared with the one at that revision, because the baseline in a
 * change is the change's own file and could otherwise admit the offender it adds: an entry the base did not
 * have fails. A base revision without a baseline file imposes nothing, which is the change that introduces it.
 *
 * Plain Node with no dependencies.
 *
 * Usage: node scripts/check-spec-headers.mjs [--root <dir>] [--baseline <file>] [--base <ref>]
 *   --root      repository root (default: the current directory)
 *   --baseline  JSON `{ "files": [ "<path>", ... ] }` (default: scripts/spec-header-baseline.json)
 *   --base      a git revision whose baseline the current one may not widen (default: none)
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Shortest text, outside the layer marker, that can still state a purpose. */
const MIN_PURPOSE_LENGTH = 20

/** A `Layer: x` sentence or an `@layer x` tag; the first word after it names the layer. */
const LAYER_MARKER = /(?:\bLayer:|@layer)\s+([A-Za-z-]+)/i

/** The layers a spec may declare: the package's subpaths, its tests, the docs fixtures and the repository checks. */
export const LAYERS = ['server', 'shared', 'prices', 'prisma', 'redis', 'test', 'tests', 'docs', 'repository', 'scripts']

/** Tracked files named like a spec: `*.spec.ts` and the end-to-end `*-spec.ts`. */
const SPEC_FILE = /(?:\.spec\.ts|-spec\.ts)$/

/**
 * Why `source` has no valid header, or `null` when it has one.
 *
 * @param {string} source The spec file's text.
 * @returns {string | null} The problem in one sentence, or `null`.
 */
export function headerProblem(source) {
  const text = source.trimStart() // trimStart also drops a byte-order mark
  const end = text.startsWith('/**') ? text.indexOf('*/') : -1
  if (end === -1) return 'does not open with a /** */ block comment'
  const body = text
    .slice(3, end)
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
  const marker = LAYER_MARKER.exec(body)
  if (marker === null) return 'header has no layer marker (`@layer <layer>` or `Layer: <layer>.`)'
  const layer = (marker[1] ?? '').toLowerCase()
  if (!LAYERS.includes(layer)) return `header names the layer "${layer}", which is not one of ${LAYERS.join(', ')}`
  const purpose = body.replace(LAYER_MARKER, '').replace(/@fileoverview/gi, '').trim()
  if (purpose.length < MIN_PURPOSE_LENGTH) return 'header states a layer but not what the file tests'
  return null
}

/**
 * Problems with a baseline: it may only list files the given set of offenders still contains, and nothing the
 * base revision did not already list.
 *
 * @param {Map<string, string>} offenders Tracked specs without a valid header, with the reason.
 * @param {Set<string>} baseline Files the baseline lists.
 * @param {Set<string> | null} base Files the base revision's baseline lists, or `null` when it has none.
 * @returns {string[]} One message per problem.
 */
export function problemsOf(offenders, baseline, base) {
  const problems = []
  for (const [file, reason] of offenders) {
    if (!baseline.has(file)) problems.push(`${file}: ${reason}.`)
  }
  for (const file of baseline) {
    if (!offenders.has(file)) problems.push(`${file} is on the baseline but now has a valid header or is no longer tracked. Remove its entry.`)
  }
  if (base !== null) {
    for (const file of baseline) {
      if (!base.has(file)) problems.push(`${file} is on the baseline but the base revision does not have it. A new spec gets a header, it is not listed.`)
    }
  }
  return problems
}

/**
 * Reads `--name value` from the arguments, or returns the fallback.
 *
 * @param {string} name The option name.
 * @param {string | undefined} fallback Used when the option is absent.
 * @returns {string | undefined} The option's value or the fallback.
 */
function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

/**
 * Reads the baseline's `files` list from JSON text, failing loudly on a file that is not one.
 *
 * @param {string} text The baseline file's text.
 * @param {string} path Where it came from, for the message.
 * @returns {Set<string>} The listed files.
 */
export function parseBaseline(text, path) {
  const files = JSON.parse(text)?.files
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
    throw new Error(`${path}: expected { "files": [ "<path>", ... ] }`)
  }
  return new Set(files)
}

/**
 * The baseline at a git revision, or `null` when that revision has no baseline file.
 *
 * @param {string} root The repository root.
 * @param {string} ref The git revision.
 * @param {string} path The baseline file's path.
 * @returns {Set<string> | null} The listed files, or `null`.
 */
function baselineAt(root, ref, path) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' })
  } catch {
    throw new Error(`${ref}: not a revision in this repository`)
  }
  const spec = `${ref}:${relative(root, path).split('\\').join('/')}`
  try {
    execFileSync('git', ['cat-file', '-e', spec], { cwd: root, stdio: 'ignore' })
  } catch {
    return null
  }
  return parseBaseline(execFileSync('git', ['show', spec], { cwd: root, encoding: 'utf8' }), spec)
}

/**
 * The tracked specs whose header is not valid, with the reason, keyed by path relative to the root.
 *
 * @param {string} root The repository root.
 * @returns {Map<string, string>} The offenders.
 */
export function offendersOf(root) {
  const listing = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  const offenders = new Map()
  for (const path of listing.split('\0').filter((file) => SPEC_FILE.test(file))) {
    const problem = headerProblem(readFileSync(join(root, path), 'utf8'))
    if (problem !== null) offenders.set(path, problem)
  }
  return offenders
}

/** Runs the gate and exits non-zero when any spec is a new offender or the baseline is stale or widened. */
function main() {
  const root = resolve(option('--root', process.cwd()))
  const baselinePath = resolve(option('--baseline', join(root, 'scripts', 'spec-header-baseline.json')))
  const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'), baselinePath)
  const baseRef = option('--base', undefined)
  const base = baseRef === undefined ? null : baselineAt(root, baseRef, baselinePath)
  const problems = problemsOf(offendersOf(root), baseline, base)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error(`\n${problems.length} spec header problem(s).`)
    process.exit(1)
  }
  console.log('Every spec file opens with a purpose and layer header, or is on the frozen baseline.')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
