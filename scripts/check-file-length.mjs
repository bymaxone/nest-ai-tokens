/**
 * @fileoverview File-length gate — fails when a tracked source file is longer than the limit,
 * unless the file is on a frozen baseline that can only shrink.
 * @layer scripts
 *
 * A file that already exceeds the limit is listed in the baseline with its length, so the check
 * can be red for what a change introduces without failing on what the repository inherits. The
 * list is kept honest from both sides:
 *
 * - a file over the limit that is not on the baseline fails (a new or grown offender);
 * - a baselined file that grew past its recorded length fails (the baseline cannot widen);
 * - a baselined file that shrank but is still over the limit fails until its entry is lowered
 *   to the new length, so the recorded number always matches the file;
 * - a baselined file that is now at or under the limit, or no longer tracked, fails until its
 *   entry is removed, so a fixed file cannot quietly regress later.
 *
 * With `--base <ref>` the baseline is also compared with the one at that revision, because the
 * baseline in a change is the change's own file and could otherwise admit the offender it adds: an
 * entry the base did not have, or one above the base's length, fails. A base revision without a
 * baseline file imposes nothing, which is the change that introduces it.
 *
 * Plain Node with no dependencies: copy this file and `file-length-baseline.json` as they are.
 *
 * Usage: node scripts/check-file-length.mjs [--root <dir>] [--baseline <file>] [--base <ref>]
 *   --root      repository root (default: the current directory)
 *   --baseline  JSON `{ "files": { "<path>": <length>, ... } }` (default: scripts/file-length-baseline.json)
 *   --base      a git revision whose baseline the current one may not widen (default: none)
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** The most lines a source file may have. */
const LIMIT = 800

/** Tracked files with these extensions are source. Markdown, JSON and lockfiles are out of scope. */
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/

/** Reads `--name value` from the arguments, or returns the fallback. */
function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

/** Number of lines in a text: the count of line feeds, plus a final line without one. */
function lineCount(text) {
  if (text.length === 0) return 0
  const feeds = text.split('\n').length - 1
  return text.endsWith('\n') ? feeds : feeds + 1
}

/** Paths of the tracked source files, relative to the root. */
function trackedSources(root) {
  const listing = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return listing.split('\0').filter((path) => path !== '' && SOURCE_EXTENSION.test(path))
}

/** Lengths of the tracked source files over the limit, keyed by path. */
function oversize(root) {
  const lengths = new Map()
  for (const path of trackedSources(root)) {
    const length = lineCount(readFileSync(join(root, path), 'utf8'))
    if (length > LIMIT) lengths.set(path, length)
  }
  return lengths
}

/** Reads the baseline's `files` table from JSON text as a map, failing loudly on a file that is not one. */
function parseBaseline(text, path) {
  const parsed = JSON.parse(text)
  const files = parsed?.files
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(`${path}: expected { "files": { "<path>": <length> } }`)
  }
  const table = new Map(Object.entries(files))
  for (const [file, length] of table) {
    if (!Number.isInteger(length) || length <= LIMIT) {
      throw new Error(`${path}: ${file} must record an integer length above ${LIMIT}, got ${String(length)}`)
    }
  }
  return table
}

/** The baseline table at a git revision, or `null` when that revision has no baseline file. */
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

/** Problems with how the baseline differs from the base revision's: it may only lose or lower entries. */
function widening(baseline, base) {
  const problems = []
  for (const [file, length] of baseline) {
    const inBase = base.get(file)
    if (inBase === undefined) {
      problems.push(`${file} is on the baseline but the base revision does not have it. A new offender is split, not listed.`)
    } else if (length > inBase) {
      problems.push(`${file} is recorded at ${length} lines, above ${inBase} on the base revision.`)
    }
  }
  return problems
}

/** Compares the files over the limit with the baseline and returns one message per problem. */
function problemsOf(over, baseline) {
  const problems = []
  for (const [file, length] of over) {
    const recorded = baseline.get(file)
    if (recorded === undefined) {
      problems.push(`${file} has ${length} lines, over the limit of ${LIMIT}. Split it by responsibility.`)
    } else if (length > recorded) {
      problems.push(`${file} grew from ${recorded} to ${length} lines. A baselined file may only shrink.`)
    } else if (length < recorded) {
      problems.push(`${file} shrank to ${length} lines. Lower its baseline entry from ${recorded} to ${length}.`)
    }
  }
  for (const file of baseline.keys()) {
    if (!over.has(file)) {
      problems.push(`${file} is on the baseline but is no longer over ${LIMIT} lines or tracked. Remove its entry.`)
    }
  }
  return problems
}

const root = resolve(option('--root', process.cwd()))
const baselinePath = resolve(option('--baseline', join(root, 'scripts', 'file-length-baseline.json')))

const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'), baselinePath)
const baseRef = option('--base', undefined)
const base = baseRef === undefined ? null : baselineAt(root, baseRef, baselinePath)

const problems = [...problemsOf(oversize(root), baseline), ...(base === null ? [] : widening(baseline, base))]

if (problems.length > 0) {
  for (const problem of problems) console.error(`✖ ${problem}`)
  console.error(`\n${problems.length} file-length problem(s). The limit is ${LIMIT} lines.`)
  process.exit(1)
}

console.log(`Every tracked source file is within ${LIMIT} lines, or frozen on the baseline.`)
