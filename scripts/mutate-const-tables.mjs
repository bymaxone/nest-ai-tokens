/**
 * @fileoverview Mutates `as const` value tables one entry at a time and reports the mutants a test
 * command does not kill.
 * @layer scripts
 *
 * Mutation testing tools such as Stryker change operators and literals, but they neither remove a
 * property or an element from a constant table nor change a number in it. An entry can therefore
 * disappear, or a number drift, with every test green. This script fills that gap for a
 * development check:
 *
 * - it finds every object or array literal marked `as const` (alone or followed by `satisfies`)
 *   in the tracked source files under the source directory, ignoring specs, tests, declaration
 *   files and `index.ts`;
 * - it also visits every object or array literal nested inside such a table, since an inner
 *   object is part of the table it sits in;
 * - for each entry it makes one mutant that removes the entry, and, when the entry is a plain
 *   decimal integer, one that adds one to it (other forms of number are only removed);
 * - for each mutant it runs the given test command and counts the mutant as killed when the
 *   command fails, or as a survivor when it passes;
 * - it prints the survivors and exits 1 when there are any.
 *
 * Before a file is mutated, the command must pass on that file unmutated, with `{file}` and
 * MUTATED_FILE set to it, or the run stops with exit 2 and names the file: a failing command
 * would "kill" every mutant, and the judgement of each file's mutants is the command's verdict
 * on that file. A file with no table is not run. The source file is restored after every mutant,
 * and on SIGINT or SIGTERM. Run it on a clean working tree.
 *
 * An interrupt stops the command's own process only. A runner that starts workers of its own,
 * such as `pnpm exec jest`, can leave them finishing after the file is restored; their verdict is
 * discarded.
 *
 * Make the command fail on a failed assertion only. A test runner that also type-checks counts a
 * removed property that other code reads as killed, which Stryker would not; turn the type check
 * off for this run (for ts-jest, `diagnostics: false`).
 *
 * Plain Node with no dependencies of its own: it loads `typescript` from the repository it runs
 * in, which any TypeScript project already has. Copy this file as it is.
 *
 * Usage: node scripts/mutate-const-tables.mjs [--root <dir>] [--src <dir>] [--only <text>] -- <command> [args...]
 *   --root  repository root (default: the current directory)
 *   --src   directory, relative to the root, whose files are mutated (default: src)
 *   --only  mutate only the files whose path contains this text (default: all)
 *   command the test command, run without a shell from the root. The text `{file}` in an
 *           argument is replaced by the mutated file's path relative to the root, and the
 *           environment variable MUTATED_FILE holds the same path.
 *
 * Example: node scripts/mutate-const-tables.mjs --only default-ttls -- pnpm exec jest \
 *   --config jest.mutants.config.ts --findRelatedTests {file} --coverage=false --silent
 *
 * Exit codes: 0 every mutant was killed (or there is no table), 1 at least one survived, 2 usage
 * error, a command that fails on an unmutated file, or a run stopped by SIGINT, SIGTERM or a
 * command ended by a signal.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

/** Files that are never mutated: specs, tests, declaration files and barrels. */
const SKIPPED_FILE = /(?:\.(?:spec|test)\.[cm]?[jt]sx?|\.d\.[cm]?ts|(?:^|\/)index\.[cm]?[jt]sx?)$/

/** Source files that can hold a table. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/

/** Exit code for a usage error, a failing baseline or a stopped run. */
const EXIT_USAGE = 2

/** Reads `--name value` from the options, or returns the fallback. */
function option(options, name, fallback) {
  const index = options.indexOf(name)
  return index === -1 ? fallback : (options[index + 1] ?? fallback)
}

/** Splits the arguments at the first `--` into the options and the test command. */
function parseArguments(argv) {
  const split = argv.indexOf('--')
  const options = split === -1 ? argv : argv.slice(0, split)
  const command = split === -1 ? [] : argv.slice(split + 1)
  return {
    root: resolve(option(options, '--root', process.cwd())),
    src: option(options, '--src', 'src'),
    only: option(options, '--only', ''),
    command
  }
}

/** Loads the `typescript` package of the repository at the root. */
function loadTypeScript(root) {
  return createRequire(join(root, 'package.json'))('typescript')
}

/** Paths, relative to the root, of the tracked files that may hold a table. */
function candidateFiles(root, src, only) {
  const listing = execFileSync('git', ['ls-files', '-z', '--', src], {
    cwd: root,
    encoding: 'utf8'
  })
  return listing
    .split('\0')
    .filter((path) => SOURCE_FILE.test(path) && !SKIPPED_FILE.test(path) && path.includes(only))
    .filter((path) => existsSync(join(root, path)))
}

/** The expression inside any `as`, `satisfies` and parentheses wrapping. */
function unwrap(ts, node) {
  let current = node
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** Whether the node is `<expression> as const`. */
function isConstAssertion(ts, node) {
  return ts.isAsExpression(node) && node.type.getText() === 'const'
}

/** Whether the node is an object or array literal. */
function isLiteral(ts, node) {
  return ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
}

/** The literal and every object or array literal nested inside it. */
function withNested(ts, literal) {
  const found = []
  const visit = (node) => {
    if (isLiteral(ts, node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(literal)
  return found
}

/**
 * Every object or array literal asserted `as const`, with or without a `satisfies` after it,
 * and every literal nested inside one: an inner object is part of the table it sits in.
 */
function constTables(ts, sourceFile) {
  const tables = []
  const visit = (node) => {
    const asserted = ts.isSatisfiesExpression(node) ? node.expression : node
    if (isConstAssertion(ts, asserted)) {
      const literal = unwrap(ts, asserted)
      if (isLiteral(ts, literal)) tables.push(...withNested(ts, literal))
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return tables
}

/**
 * The text with one entry cut out of its list. An entry that has a successor goes with everything
 * up to the successor, comma and comments included; the last entry goes with the comma that
 * separates it from its predecessor and with its own trailing comma.
 */
function withoutEntry(text, entries, index) {
  const entry = entries.at(index)
  const next = entries.at(index + 1)
  if (next !== undefined) {
    return text.slice(0, entry.getFullStart()) + text.slice(next.getFullStart())
  }
  const previous = index === 0 ? undefined : entries.at(index - 1)
  const start = previous === undefined ? entry.getFullStart() : previous.getEnd()
  return text.slice(0, start) + text.slice(entries.end)
}

/** The numeric literal an entry holds as its value, or `undefined`. */
function numberOf(ts, entry) {
  const value = ts.isPropertyAssignment(entry) ? entry.initializer : entry
  return ts.isNumericLiteral(value) ? value : undefined
}

/**
 * The text with the entry's number raised by one, or `undefined` when the entry holds no plain
 * decimal integer small enough to add one to exactly. Other forms of number are only removed.
 */
function withNumberBumped(ts, text, entry) {
  const literal = numberOf(ts, entry)
  if (literal === undefined || !/^\d[\d_]*$/.test(literal.getText())) return undefined
  const value = Number(literal.text)
  if (!Number.isSafeInteger(value + 1)) return undefined
  return text.slice(0, literal.getStart()) + String(value + 1) + text.slice(literal.getEnd())
}

/** The mutants of one file: for each entry of each table, a removal and possibly a bump. */
function mutantsOf(ts, path, text) {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const mutants = []
  for (const table of constTables(ts, sourceFile)) {
    const entries = ts.isObjectLiteralExpression(table) ? table.properties : table.elements
    entries.forEach((entry, index) => {
      const line = sourceFile.getLineAndCharacterOfPosition(entry.getStart()).line + 1
      const label = `${path}:${line} ${entry.getText().slice(0, 50).replace(/\s+/g, ' ')}`
      mutants.push({ kind: 'remove', label, text: withoutEntry(text, entries, index) })
      const bumped = withNumberBumped(ts, text, entry)
      if (bumped !== undefined) mutants.push({ kind: 'bump', label, text: bumped })
    })
  }
  return mutants
}

/** The test command's child process while one runs, so an interrupt can stop it. */
let running

/** Runs the test command once and resolves with how it ended: an exit status or a signal. */
function runCommand(root, command, file) {
  const [program, ...args] = command.map((part) => part.replaceAll('{file}', file))
  return new Promise((done) => {
    running = spawn(program, args, {
      cwd: root,
      env: { ...process.env, MUTATED_FILE: file },
      stdio: 'ignore'
    })
    running.once('error', () => done({ status: null, signal: null }))
    running.once('close', (status, signal) => {
      running = undefined
      done({ status, signal })
    })
  })
}

/** Whether a finished command passed: it exited with status 0. */
const passed = (outcome) => outcome.status === 0

/**
 * Stops the run unless the command passes on the unmutated file, so that a failing command does
 * not "kill" every mutant of it. A file with no mutant is not run.
 */
async function requirePassing(root, command, file, mutantCount) {
  if (mutantCount === 0) return
  const outcome = await runCommand(root, command, file)
  if (outcome.signal !== null) throw new Error(`The test command was stopped by ${outcome.signal}.`)
  if (!passed(outcome)) {
    throw new Error(`The test command fails on the unmutated file ${file}; fix it first.`)
  }
}

/**
 * Mutates the files one entry at a time and returns the mutants the command did not kill. A
 * command stopped by a signal is not a verdict on the mutant, so the run stops instead.
 */
async function survivorsOf(ts, root, files, command) {
  const survivors = []
  let restore = () => {}
  const onSignal = () => {
    running?.kill('SIGKILL')
    restore()
    process.exit(EXIT_USAGE)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  for (const file of files) {
    const absolute = join(root, file)
    const original = readFileSync(absolute, 'utf8')
    restore = () => writeFileSync(absolute, original)
    const mutants = mutantsOf(ts, file, original)
    try {
      await requirePassing(root, command, file, mutants.length)
      for (const mutant of mutants) {
        writeFileSync(absolute, mutant.text)
        const outcome = await runCommand(root, command, file)
        if (outcome.signal !== null)
          throw new Error(`The test command was stopped by ${outcome.signal}.`)
        process.stderr.write(
          `${passed(outcome) ? 'SURVIVED' : 'killed  '} ${mutant.kind} ${mutant.label}\n`
        )
        if (passed(outcome)) survivors.push(mutant)
      }
    } finally {
      restore()
    }
  }
  return survivors
}

/** Parses the arguments, runs the mutants file by file and prints the survivors. */
async function main() {
  const { root, src, only, command } = parseArguments(process.argv.slice(2))
  if (command.length === 0) {
    process.stderr.write(
      'Usage: node scripts/mutate-const-tables.mjs [options] -- <command> [args...]\n'
    )
    process.exit(EXIT_USAGE)
  }
  const files = candidateFiles(root, src, only)
  const survivors = await survivorsOf(loadTypeScript(root), root, files, command)
  if (survivors.length === 0) {
    console.log('Every mutant of every `as const` table was killed.')
    return
  }
  console.log(`${survivors.length} mutant(s) survived; no test pins these entries:`)
  for (const survivor of survivors) console.log(`  ${survivor.kind}  ${survivor.label}`)
  process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(EXIT_USAGE)
})
