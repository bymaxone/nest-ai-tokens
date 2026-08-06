/**
 * @fileoverview Mutation-directive gate — proves every `// Stryker` comment in the
 * production source is one Stryker actually parses, and that it carries the reason
 * that makes the mutation score an accounting rather than a number.
 * @layer scripts
 *
 * Stryker reads its directives with a single regular expression:
 *
 *     /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/
 *
 * Two properties of it are easy to violate and impossible to notice:
 *
 * - The mutator list accepts letters, commas and spaces only, and the reason is
 *   captured **only** after a colon. Written `Mutator -- reason`, the directive still
 *   silences the mutant, but the reason is dropped and the report shows Stryker's
 *   fallback text, `Ignored using a comment`. The justification stays in the source
 *   and never reaches the reader of the report.
 * - The reason ends at the end of the comment line. Wrapped onto a second `//` line,
 *   the report keeps a truncated half-sentence. Detecting that wrap is a judgement about
 *   prose, so it is deliberately narrow: it fires only on a following comment that resumes
 *   mid-sentence and belongs to no other tool. A comment that opens a sentence of its own,
 *   and an `eslint-disable`/`@ts-expect-error` under the directive, are left alone — a gate
 *   that fails the build on a legitimate adjacent comment would be worse than the miss.
 *
 * An unknown mutator name is worse than either: the rule matches nothing, so the
 * mutant is never ignored at all. Stryker only warns about that while a mutation run
 * is happening, which on this repo is post-merge — too late to block the change.
 *
 * The mutator list is read from the installed Stryker. It lives behind an internal
 * path, so a failure to load it downgrades that single check to a notice rather than
 * failing the build on a Stryker upgrade.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The directive grammar, copied from Stryker's own `DirectiveBookkeeper`. */
const DIRECTIVE_RE = /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/

/** Matches every `// Stryker …` line, including the malformed ones the regex above rejects. */
const COMMENT_RE = /^\s*\/\/\s*Stryker\b/

/** Wildcard accepted by Stryker in place of a mutator name. */
const WILDCARD = 'all'

/**
 * A reason wrapped onto a second line resumes mid-sentence, so it starts lowercase.
 * A comment that opens a new sentence is a comment of its own, not a lost fragment.
 */
const CONTINUATION_RE = /^\/\/\s*[a-z]/

/**
 * Another tool's directive on the following line is that tool's business, not a wrapped
 * reason — several of them start lowercase and would otherwise read as one.
 */
const TOOL_DIRECTIVE_RE =
  /^\/\/\s*(?:@?(?:ts|eslint|prettier|biome|dprint|deno|c8|v8|istanbul|stryker|webpack|vite)\b|#(?:region|endregion)\b)/i

/**
 * Resolves the mutator names the installed Stryker knows about.
 *
 * @returns {Promise<readonly string[] | null>} The names, or `null` when the internal
 *   module cannot be loaded — the caller then skips the name check.
 */
async function loadMutatorNames() {
  try {
    const require = createRequire(import.meta.url)
    // The instrumenter is a transitive dependency, so under pnpm's strict layout it is
    // reachable from `core`'s own directory rather than from this package's root. `paths`
    // entries are directories to start the `node_modules` walk from, hence the `dirname`.
    const core = dirname(require.resolve('@stryker-mutator/core'))
    const entry = require.resolve('@stryker-mutator/instrumenter', { paths: [core] })
    const module = await import(pathToFileURL(join(entry, '..', 'mutators', 'index.js')).href)
    const names = module.allMutators?.map((/** @type {{ name: string }} */ m) => m.name)
    return Array.isArray(names) && names.length > 0 ? names : null
  } catch {
    return null
  }
}

/**
 * Lists every TypeScript source file under a directory.
 *
 * @param {string} dir Directory to walk.
 * @returns {string[]} Absolute-from-cwd paths, sorted for stable output.
 */
function sourceFiles(dir) {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry) && !/\.(spec|test|d)\.tsx?$/.test(entry)) found.push(path)
  }
  return found.sort()
}

/**
 * Collects every grammar violation in one file.
 *
 * @param {string} file Path to inspect.
 * @param {readonly string[] | null} mutatorNames Known mutator names, or `null` to skip that check.
 * @returns {Array<{ file: string, line: number, problem: string, hint: string }>} Violations found.
 */
function inspect(file, mutatorNames) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const problems = []

  lines.forEach((line, index) => {
    if (!COMMENT_RE.test(line)) return

    const at = { file, line: index + 1 }
    const match = DIRECTIVE_RE.exec(line.trim().slice(2))

    if (!match) {
      problems.push({
        ...at,
        problem: 'not a directive Stryker can parse — it is an ordinary comment',
        hint: 'use "// Stryker disable next-line <Mutator>: <reason>"'
      })
      return
    }

    const [, kind, , mutators, reason] = match

    for (const mutator of mutators.split(',').map((name) => name.trim())) {
      if (mutator === WILDCARD || !mutatorNames) continue
      if (!mutatorNames.some((known) => known.toLowerCase() === mutator.toLowerCase())) {
        problems.push({
          ...at,
          problem: `unknown mutator "${mutator}" — this directive silences nothing`,
          hint: `known mutators: ${mutatorNames.join(', ')}`
        })
      }
    }

    // A `restore` carries no reason by design: it lifts a rule rather than justifying one.
    if (kind === 'restore') return

    if (!reason?.trim()) {
      problems.push({
        ...at,
        problem: line.includes(' -- ')
          ? 'reason written after "--", which Stryker does not read — the report will say "Ignored using a comment"'
          : 'no reason — the report will say "Ignored using a comment"',
        hint: 'put the reason after a colon: "<Mutator>: <why the mutant is equivalent>"'
      })
      return
    }

    const next = lines[index + 1]?.trim() ?? ''
    if (CONTINUATION_RE.test(next) && !TOOL_DIRECTIVE_RE.test(next)) {
      problems.push({
        ...at,
        problem: 'reason continues on the next line, so the report keeps only this fragment',
        hint: 'keep the whole reason on the directive line'
      })
    }
  })

  return problems
}

const mutatorNames = await loadMutatorNames()
if (!mutatorNames) {
  console.log('• mutator names unavailable from the installed Stryker — skipping that check')
}

const problems = sourceFiles('src').flatMap((file) => inspect(file, mutatorNames))

if (problems.length > 0) {
  for (const { file, line, problem, hint } of problems) {
    console.error(`✖ ${file}:${line} — ${problem}`)
    console.error(`  ${hint}`)
  }
  console.error(`\n${problems.length} malformed Stryker directive(s).`)
  process.exit(1)
}

console.log('All Stryker directives parse and carry their reason.')
