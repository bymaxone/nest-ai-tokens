/**
 * @fileoverview Function-length gate: fails when a function or a test body in a tracked source or
 * test file spans more than 50 lines and is not on a frozen baseline that can only shrink.
 * @layer scripts
 *
 * `AGENTS.md` caps a function or a test body at 50 lines, and the pull-request review reports a
 * newly introduced one as a blocking finding. The gate is red for what a change introduces; a
 * function over the limit is allowed only while it is on a baseline whose entries can only shrink.
 *
 * The unit is a function-like node (a declaration, a method, a constructor, an accessor, a function
 * or an arrow expression) measured from its first line to its last, signature and braces included.
 * That is how the review reports it, so the gate and the reviewer never argue about the measure. A
 * test body is the callback of `it` or `test`, `.each` forms included. A setup or teardown hook
 * (`beforeEach`, `afterEach`, `beforeAll`, `afterAll`) is a function like any other and is measured
 * like a test body, with the same limit and the same baseline. The callback of `describe`, `context`
 * and `suite` is a container, not a unit: a spec file's `describe` holds all its tests and would
 * otherwise fail every spec.
 *
 * A function nested in another is measured on its own and inside the span of the one that
 * contains it. Growing it therefore moves two baseline entries, and the failure says so, so the
 * two are not read as two offenders.
 *
 * The baseline maps a function's key to a line count, and is kept honest from both sides. A key is
 * a structured value serialized as JSON (see `function-length-key.mjs`), so no title or path can
 * make two functions share one; messages show it as `file::outer > inner #2`:
 *
 * - a function over the limit that is not on the baseline fails (a new offender);
 * - a baselined function that grew fails (the baseline cannot widen);
 * - a baselined function that shrank fails until its entry is lowered, or removed once it is
 *   within the limit, so a fixed function cannot quietly regress later.
 *
 * A function renamed within its file reads as a stale entry and a new offender, and each failure names the
 * other. One moved to another file reads as the same two failures with no hint, since the hint matches by file.
 * With `--base <ref>` the baseline is also compared with the one at that revision, because the
 * baseline in a change is the change's own file and could otherwise admit the function it adds.
 *
 * The baseline is written by `--write-baseline` and never by hand.
 *
 * Usage: node scripts/check-function-length.mjs [--root <dir>] [--baseline <file>] [--base <ref>]
 *                                               [--write-baseline]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'

import { decodeKey, displayKey, encodeKey } from './function-length-key.mjs'

/** The longest a function or a test body may be, in lines. */
const MAX_LINES = 50

/** Directories whose TypeScript is checked: the library and its tests. */
const SCOPE = /^(?:src|test)\//

/** Generated files are not written by hand and are not held to the rule. */
const GENERATED = /\/generated\//

/** Tracked files with these extensions are parsed. */
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/

/** Callbacks that group tests: containers, never units. */
const CONTAINERS = new Set(['describe', 'xdescribe', 'fdescribe', 'context', 'suite'])

/** Setup and teardown callbacks: units, measured like a test body. */
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach'])

/** Callbacks that are a test body. */
const TESTS = new Set(['it', 'xit', 'fit', 'test', 'xtest'])

/** Reads `--name value` from the arguments, or returns the fallback. */
function option(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value.`)
    process.exit(2)
  }
  return value
}

/**
 * The identifier at the root of a call's callee: `it` for `it.each(table)(name, fn)`, for
 * `it.each\`table\`(name, fn)` and for `it.only(name, fn)`.
 */
function calleeRoot(call) {
  let callee = call.expression
  for (;;) {
    if (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
      callee = callee.expression
    } else if (ts.isTaggedTemplateExpression(callee)) {
      callee = callee.tag
    } else {
      break
    }
  }
  return ts.isIdentifier(callee) ? callee.text : null
}

/** The first argument of a call as text when it is a plain string, else `null`. */
function titleOf(call) {
  const first = call.arguments[0]
  const plain =
    first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
  return plain ? first.text : null
}

/** The name a property or variable declaration gives its value. */
function nameOf(node) {
  return node.name === undefined ? '<anonymous>' : node.name.getText()
}

/** Whether a node is a function-like unit this gate looks at. */
function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  )
}

/** The class a member belongs to, as a name. */
function classNameOf(member) {
  const owner = member.parent
  return owner.name === undefined ? '<class>' : owner.name.text
}

/**
 * What a function-like node is called in a key, and whether it is a measured unit.
 * A container callback is named so that tests under it get distinct keys, but is not measured; a hook has no
 * title and is measured.
 */
function describeNode(node) {
  const call = ts.isCallExpression(node.parent) ? node.parent : null
  const root = call === null ? null : calleeRoot(call)
  if (call !== null && root !== null && HOOKS.has(root)) return { segment: ['hook', root], measured: true }
  if (call !== null && root !== null && (CONTAINERS.has(root) || TESTS.has(root))) {
    const title = titleOf(call)
    const kind = CONTAINERS.has(root) ? 'container' : 'test'
    const segment = title === null ? [`dynamic-${kind}`, root] : [kind, root, title]
    return { segment, measured: kind === 'test' }
  }
  if (ts.isFunctionDeclaration(node)) return { segment: ['fn', nameOf(node)], measured: true }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return { segment: ['member', classNameOf(node), nameOf(node)], measured: true }
  }
  if (ts.isConstructorDeclaration(node)) {
    return { segment: ['ctor', classNameOf(node)], measured: true }
  }
  const holder = node.parent
  if (ts.isPropertyDeclaration(holder)) {
    return { segment: ['member', classNameOf(holder), nameOf(holder)], measured: true }
  }
  const named = ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)
  return { segment: named ? ['fn', nameOf(holder)] : ['anon'], measured: true }
}

/**
 * Every measured function in a source text, in document order: its path and segments, its length,
 * and the position of the measured function that contains it, or -1.
 */
function collect(path, text) {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const found = []
  const visit = (node, names, container) => {
    let nextNames = names
    let nextContainer = container
    if (isFunctionLike(node)) {
      const { segment, measured } = describeNode(node)
      nextNames = [...names, segment]
      if (measured) {
        const start = file.getLineAndCharacterOfPosition(node.getStart()).line
        const end = file.getLineAndCharacterOfPosition(node.getEnd()).line
        found.push({ path, segments: nextNames, lines: end - start + 1, container })
        nextContainer = found.length - 1
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextNames, nextContainer))
  }
  visit(file, [], -1)
  return found
}

/**
 * The offenders of a source text, keyed, and the longest span of every qualified name.
 *
 * Only offenders are numbered when they share a name, in document order, so a small function added
 * or removed beside them never renames one: a key changes only when another function over the limit
 * with the same name appears or goes before it.
 */
function measure(path, text) {
  const found = collect(path, text).map((entry) => ({
    ...entry,
    base: encodeKey(entry.path, entry.segments)
  }))
  const seen = new Map()
  const keys = found.map((entry) => {
    if (entry.lines <= MAX_LINES) return null
    const count = (seen.get(entry.base) ?? 0) + 1
    seen.set(entry.base, count)
    return encodeKey(entry.path, entry.segments, count)
  })
  const offenders = []
  for (const [index, entry] of found.entries()) {
    const key = keys.at(index)
    if (key === null) continue
    const owners = []
    for (let up = entry.container; up !== -1; up = found.at(up).container) owners.push(keys.at(up))
    offenders.push({ key, lines: entry.lines, owners })
  }
  return { offenders, longest: found }
}

/**
 * The tracked files in scope with their text: the working tree, or the tree of a revision.
 *
 * @param {string} root - The repository root.
 * @param {string | undefined} ref - A revision to read instead of the working tree.
 */
function sourcesOf(root, ref) {
  const listing =
    ref === undefined
      ? execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      : execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', ref], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 1 << 28
        })
  return listing
    .split('\0')
    .filter((p) => SCOPE.test(p) && SOURCE_EXTENSION.test(p) && !GENERATED.test(p))
    .map((path) => ({
      path,
      text:
        ref === undefined
          ? readFileSync(join(root, path), 'utf8')
          : execFileSync('git', ['show', `${ref}:${path}`], {
              cwd: root,
              encoding: 'utf8',
              maxBuffer: 1 << 28
            })
    }))
}

/** The qualified name of a key: the key without the number that tells same-named offenders apart. */
function baseOf(key) {
  const { path, segments } = decodeKey(key)
  return encodeKey(path, segments)
}

/**
 * Every offender in the tracked sources by key, and the longest span of each qualified name.
 *
 * @param {string} root - The repository root.
 * @param {string | undefined} ref - A revision to read instead of the working tree.
 */
function functionsIn(root, ref) {
  const offenders = new Map()
  const longest = new Map()
  for (const { path, text } of sourcesOf(root, ref)) {
    const result = measure(path, text)
    for (const entry of result.offenders) offenders.set(entry.key, entry)
    for (const { base, lines } of result.longest) {
      longest.set(base, Math.max(lines, longest.get(base) ?? 0))
    }
  }
  return { offenders, longest }
}

/**
 * Reads the baseline's `functions` table from JSON text as a map, failing loudly on one that is not.
 *
 * @param {string} text - The file's text.
 * @param {string} path - Where it came from, for the message.
 */
function parseBaseline(text, path) {
  const functions = JSON.parse(text)?.functions
  if (functions === null || typeof functions !== 'object' || Array.isArray(functions)) {
    throw new Error(`${path}: expected { "functions": { "<function key>": <lines> } }`)
  }
  const table = new Map(Object.entries(functions))
  for (const [key, lines] of table) {
    if (!Number.isInteger(lines) || lines <= MAX_LINES) {
      throw new Error(
        `${path}: ${key} must record an integer above ${MAX_LINES} lines, got ${String(lines)}`
      )
    }
  }
  return table
}

/** The baseline table at a git revision, or `null` when that revision has no baseline file. */
function baselineAt(root, ref, path) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: root,
      stdio: 'ignore'
    })
  } catch {
    throw new Error(`${ref}: not a revision in this repository`)
  }
  const spec = `${ref}:${relative(root, path).split('\\').join('/')}`
  try {
    execFileSync('git', ['cat-file', '-e', spec], { cwd: root, stdio: 'ignore' })
  } catch {
    return null
  }
  const table = parseBaseline(
    execFileSync('git', ['show', spec], { cwd: root, encoding: 'utf8' }),
    spec
  )
  if ([...table.keys()].every(isKey)) return table
  // A baseline in an earlier key format cannot be compared by key. A gate that passed on that
  // revision held every offender on it, so its offenders, measured the way this script measures
  // them, are the table it would have written.
  return new Map([...functionsIn(root, ref).offenders].map(([key, entry]) => [key, entry.lines]))
}

/** Whether a string is a structured key. */
function isKey(key) {
  try {
    decodeKey(key)
    return true
  } catch {
    return false
  }
}

/** Problems with how the baseline differs from the base revision's: it may only lose or lower entries. */
function widening(baseline, base) {
  const problems = []
  for (const [key, lines] of baseline) {
    const inBase = base.get(key)
    if (inBase === undefined) {
      problems.push(
        `${displayKey(key)} is on the baseline but the base revision does not have it. A new offender is split, not listed.`
      )
    } else if (lines > inBase) {
      problems.push(
        `${displayKey(key)} is recorded at ${lines} lines, above ${inBase} on the base revision.`
      )
    }
  }
  return problems
}

/** The file part of a key. */
function fileOf(key) {
  return decodeKey(key).path
}

/** Keys as a person reads them, for a list in a message. */
function shown(keys) {
  return keys.map((key) => `\`${displayKey(key)}\``)
}

/** A note naming the containing functions that are offenders too, whose entries move with this one. */
function containerNote(owners, offenders) {
  const containing = owners.filter((owner) => offenders.has(owner))
  if (containing.length === 0) return ''
  return ` It is also counted inside ${shown(containing).join(' and ')}, so that entry moves with it: this is one change, not two offenders.`
}

/** Compares the functions found with the baseline and returns one message per problem. */
function problemsOf({ offenders, longest }, baseline) {
  const stale = [...baseline.keys()].filter((key) => !offenders.has(key))
  const fresh = [...offenders.keys()].filter((key) => !baseline.has(key))
  const problems = []
  for (const [key, entry] of offenders) {
    const recorded = baseline.get(key)
    const note = containerNote(entry.owners, offenders)
    const name = displayKey(key)
    if (recorded === undefined) {
      const renamed = stale.filter((old) => fileOf(old) === fileOf(key))
      const hint =
        renamed.length === 0
          ? ''
          : ` If it was renamed, its old entry ${shown(renamed).join(', ')} is the stale one below.`
      problems.push(
        `${name} spans ${entry.lines} lines, over the ${MAX_LINES}-line limit. Split it.${hint}${note}`
      )
    } else if (entry.lines > recorded) {
      problems.push(
        `${name} grew from ${recorded} to ${entry.lines} lines. A baselined function may only shrink.${note}`
      )
    } else if (entry.lines < recorded) {
      problems.push(
        `${name} now spans ${entry.lines} lines. Lower its baseline entry from ${recorded} to ${entry.lines}.${note}`
      )
    }
  }
  for (const key of stale) {
    const now = longest.get(baseOf(key))
    const renamedTo = fresh.filter((name) => fileOf(name) === fileOf(key))
    const hint =
      renamedTo.length === 0
        ? ''
        : ` If it was renamed, the new offender is ${shown(renamedTo).join(', ')}.`
    problems.push(
      now === undefined || now > MAX_LINES
        ? `${displayKey(key)} is on the baseline but no longer exists. Remove its entry.${hint}`
        : `${displayKey(key)} now spans ${now} lines, within the limit. Remove its entry.`
    )
  }
  return problems
}

const root = resolve(option('--root', process.cwd()))
const baselinePath = resolve(
  option('--baseline', join(root, 'scripts', 'function-length-baseline.json'))
)

if (process.argv.includes('--write-baseline')) {
  const entries = [...functionsIn(root).offenders]
    .map(([key, entry]) => [key, entry.lines])
    .sort(([a], [b]) => displayKey(a).localeCompare(displayKey(b)) || a.localeCompare(b))
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ functions: Object.fromEntries(entries) }, null, 2)}\n`
  )
  console.log(`Wrote ${entries.length} baseline entries to ${baselinePath}.`)
  process.exit(0)
}

const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'), baselinePath)
const baseRef = option('--base', undefined)
const base = baseRef === undefined ? null : baselineAt(root, baseRef, baselinePath)

const problems = [
  ...problemsOf(functionsIn(root), baseline),
  ...(base === null ? [] : widening(baseline, base))
]

if (problems.length > 0) {
  for (const problem of problems) console.error(`✖ ${problem}`)
  console.error(`\n${problems.length} function-length problem(s).`)
  process.exit(1)
}

console.log(
  `No tracked function or test body exceeds ${MAX_LINES} lines unless it is on the baseline.`
)
