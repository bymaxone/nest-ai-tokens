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
 * - for each mutant it runs the given test command and judges it from the command's output, not
 *   only its exit status: killed when the command fails with a test summary that counts a failed
 *   test, survived when it passes. A run that crashes, is ended by a signal, has no test summary is
 *   run once more with `--runInBand` and then listed apart as CRASH-ONLY, and a suite that
 *   "failed to run" with no failed test as LOAD-FAILURE. A run that outlives
 *   CONST_TABLES_TIMEOUT_MS (default 300000) has its process group killed and is listed as
 *   TIMEOUT: run again only when the command did not already run in band. The limit is per run,
 *   and a mutant runs at most twice. A failed test beside a suite that failed to run, or beside
 *   a dead runner process, is CRASH-ONLY too. Every run gets `--forceExit`, so an open handle
 *   does not leave jest idle. None of the three is a kill, and a load failure the mutant causes
 *   is proven by hand;
 * - it prints the survivors, the crash-only, load-failure and timeout mutants and exits 1 when
 *   there are any.
 *
 * Before any file is mutated, the command must pass on every file that holds a table, unmutated,
 * with `{file}` and MUTATED_FILE set to it, both as given and as the in-band rerun spells it, or
 * the run stops with exit 2 and names the file: a failing command
 * would "kill" every mutant, and the judgement of each file's mutants is the command's verdict
 * on that file. A file with no table is not run. The source file is restored after every mutant,
 * and on SIGINT or SIGTERM. Run it on a clean working tree. A file edited before its turn stops
 * the run with exit 2 and keeps the edit; an edit to the file being mutated is overwritten.
 *
 * An interrupt kills the command's process group, so a runner's workers stop with it.
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
 * Exit codes: 0 every mutant was killed (or there is no table), 1 at least one survived, crashed,
 * timed out or failed to load, 2 usage error, a command that fails on an unmutated file, a file
 * edited before its turn, or a run stopped by SIGINT or SIGTERM.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util'

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

/** A run that outlives this is killed and judged a timeout: a mutant can make a test wait forever. */
const RUN_TIMEOUT_MS = Number(process.env.CONST_TABLES_TIMEOUT_MS) || 300_000

/** How long the output of a command that exited may stay open before it is closed. */
const DRAIN_MS = 1000

/** The test command's child process while one runs, so an interrupt can stop it. */
let running

/**
 * Kills the running command with every process it started. The command leads its own process
 * group, so killing the command alone would leave its workers running and its output open.
 */
function stopRunning() {
  if (running === undefined) return
  try {
    process.kill(-running.pid, 'SIGKILL')
  } catch {
    running.kill('SIGKILL')
  }
}

/** Runs the test command once and resolves with how it ended: an exit status or a signal. */
function runCommand(root, command, file) {
  const [program, ...args] = command.map((part) => part.replaceAll('{file}', file))
  // A test that leaves a server or a timer open would otherwise keep the runner idle forever.
  if (!args.includes('--forceExit')) args.push('--forceExit')
  return new Promise((done) => {
    running = spawn(program, args, {
      cwd: root,
      env: { ...process.env, MUTATED_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stopRunning()
    }, RUN_TIMEOUT_MS)
    let drain
    // A descendant that left the process group keeps the output open after the command is gone.
    // What the command itself wrote is already in the pipe, so the wait for the rest is bounded.
    running.once('exit', () => {
      clearTimeout(timer)
      const { stdout, stderr } = running
      drain = setTimeout(() => {
        stopRunning()
        stdout.destroy()
        stderr.destroy()
      }, DRAIN_MS)
    })
    // A character split between two chunks would otherwise decode as broken ones, and a crash
    // line that starts with one would not be recognized.
    running.stdout.setEncoding('utf8')
    running.stderr.setEncoding('utf8')
    running.stdout.on('data', (chunk) => (output += chunk))
    running.stderr.on('data', (chunk) => (output += chunk))
    running.once('error', () => {
      clearTimeout(timer)
      done({ status: null, signal: null, output })
    })
    running.once('close', (status, signal) => {
      clearTimeout(timer)
      clearTimeout(drain)
      running = undefined
      done({ status, signal, output, timedOut })
    })
  })
}

/** Whether a finished command passed: it exited with status 0. */
const passed = (outcome) => outcome.status === 0

/**
 * Lines the runner prints when a suite could not run: it failed to load, or a process died. Each
 * is matched only where a line starts with it, so a test name or an assertion message that
 * mentions a crash does not turn a failed test into one.
 */
const CRASH_MARKER =
  /^\s*(?:● )?(?:Test suite failed to run|Jest worker (?:encountered|ran out of memory)|A jest worker process .* was terminated|Call retries were exceeded|FATAL ERROR: .*out of memory)/m

/**
 * The output without the report of each failed test: its `●` title and the indented lines under
 * it, which hold the test's own message and code frame. The runner's report of a suite that
 * could not run is kept.
 */
function outsideFailedTests(output) {
  let inTest = false
  return output
    .split('\n')
    .filter((line) => {
      const title = /^\s*● (.*)/.exec(line)
      if (title) inTest = !title[1].startsWith('Test suite failed to run')
      else if (/^\S/.test(line)) inTest = false
      return !inTest
    })
    .join('\n')
}

/** The test summary counts at least one failed test: an assertion failed, nothing crashed. */
const failedTests = (output) => /^Tests:.*\b[1-9]\d* failed/m.test(output)

/**
 * How one run of the command ended, as a verdict on the mutant:
 * - `survived`: exit status 0;
 * - `killed`: a non-zero exit whose summary counts a failed test and that shows no crash marker;
 * - `load-failure`: a suite "failed to run" and no test failed, which the mutant itself can cause
 *   (a removed entry that is read at import); it is not a kill and is proven by hand;
 * - `timeout`: the run outlived the time limit and was stopped;
 * - `crash`: a signal, or no test summary at all.
 */
export function verdictOf(outcome) {
  // A runner told to colour its output would otherwise hide the summary behind escape codes.
  const output = stripVTControlCharacters(outcome.output ?? '')
  if (outcome.timedOut) return 'timeout'
  if (outcome.status === 0 && outcome.signal === null) return 'survived'
  if (outcome.signal !== null) return 'crash'
  if (CRASH_MARKER.test(outsideFailedTests(output))) {
    return failedTests(output)
      ? 'crash'
      : /Test suite failed to run/.test(outsideFailedTests(output)) && /^Tests:/m.test(output)
        ? 'load-failure'
        : 'crash'
  }
  return failedTests(output) ? 'killed' : 'crash'
}

/** Jest's worker options that take their value from the next argument. */
const WORKER_OPTIONS = new Set(['-w', '--maxWorkers', '--max-workers'])

/**
 * The command with `--runInBand`, without the worker count jest refuses to combine with it. Only
 * the arguments after the jest binary are filtered: before it, `-w` belongs to a package manager.
 */
function inBand(command) {
  const runner = command.findIndex((part) => /(^|\/)jest(\.js)?$/.test(part))
  const jestArgument = (index) => runner !== -1 && index > runner
  const kept = command.filter(
    (part, index) =>
      !jestArgument(index) ||
      !(
        WORKER_OPTIONS.has(part) ||
        WORKER_OPTIONS.has(command[index - 1]) ||
        /^(--maxWorkers|--max-workers)=|^-w=?\d/.test(part)
      )
  )
  return kept.includes('--runInBand') ? kept : [...kept, '--runInBand']
}

/**
 * Runs the command for one mutant. A crash or a load failure is run once more in band, so a worker
 * crash is not taken for the mutant's doing. So is a timeout, unless the command already ran in
 * band, where a second wait would only repeat the first. The rerun's command has passed on the
 * unmutated file before any mutant is written, so a failed test there is the mutant's doing.
 */
export async function judge(root, command, file) {
  const first = verdictOf(await runCommand(root, command, file))
  const retry =
    first === 'crash' ||
    first === 'load-failure' ||
    (first === 'timeout' && !command.includes('--runInBand'))
  if (!retry) return first
  const again = verdictOf(await runCommand(root, inBand(command), file))
  return again === 'killed' ? 'killed-after-rerun' : again
}

/**
 * Stops the run unless the command passes on the unmutated file, both as given and as the in-band
 * rerun spells it: a command that fails on its own would "kill" every mutant it judges.
 */
async function requirePassing(root, command, file) {
  const rerun = inBand(command)
  const same = isDeepStrictEqual(rerun, command)
  for (const [run, name] of same
    ? [[command, 'The test command']]
    : [
        [command, 'The test command'],
        [rerun, 'The test command with --runInBand']
      ]) {
    const outcome = await runCommand(root, run, file)
    if (outcome.signal !== null) throw new Error(`${name} was stopped by ${outcome.signal}.`)
    if (!passed(outcome)) {
      throw new Error(`${name} fails on the unmutated file ${file}; fix it first.`)
    }
  }
}

/**
 * Mutates the files one entry at a time and returns the mutants the command did not kill. SIGINT
 * or SIGTERM to this script stops the command, restores the file and ends the run.
 */
async function survivorsOf(ts, root, files, command) {
  const survivors = []
  const crashOnly = []
  const loadFailures = []
  const timeouts = []
  survivors.crashOnly = crashOnly
  survivors.loadFailures = loadFailures
  survivors.timeouts = timeouts
  let restore = () => undefined
  const onSignal = () => {
    stopRunning()
    restore()
    process.exit(EXIT_USAGE)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const targets = files
    .map((file) => {
      const checked = readFileSync(join(root, file), 'utf8')
      return { file, checked, mutants: mutantsOf(ts, file, checked) }
    })
    .filter(({ mutants }) => mutants.length > 0)
  // Every file is checked before any is mutated: a run that cannot judge one does not start.
  for (const { file } of targets) await requirePassing(root, command, file)
  for (const { file, checked, mutants } of targets) {
    const absolute = join(root, file)
    // The mutants and the restore come from the text the command passed on. Writing either over
    // an edit saved since then would lose it, and the edited text has not been checked.
    if (readFileSync(absolute, 'utf8') !== checked) {
      throw new Error(`${file} changed during the run; it is left as it is. Run again.`)
    }
    restore = () => writeFileSync(absolute, checked)
    try {
      for (const mutant of mutants) {
        writeFileSync(absolute, mutant.text)
        const verdict = await judge(root, command, file)
        process.stderr.write(`${verdict.toUpperCase().padEnd(8)} ${mutant.kind} ${mutant.label}\n`)
        if (verdict === 'survived') survivors.push(mutant)
        if (verdict === 'crash') crashOnly.push(mutant)
        if (verdict === 'load-failure') loadFailures.push(mutant)
        if (verdict === 'timeout') timeouts.push(mutant)
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
  for (const m of survivors.crashOnly) console.log(`CRASH-ONLY (not a kill)  ${m.kind}  ${m.label}`)
  for (const m of survivors.loadFailures)
    console.log(`LOAD-FAILURE (not a kill, prove by hand)  ${m.kind}  ${m.label}`)
  for (const m of survivors.timeouts) console.log(`TIMEOUT (not a kill)  ${m.kind}  ${m.label}`)
  const unjudged =
    survivors.crashOnly.length + survivors.loadFailures.length + survivors.timeouts.length
  if (survivors.length === 0 && unjudged === 0) {
    console.log('Every mutant of every `as const` table was killed.')
    return
  }
  if (survivors.length > 0) {
    console.log(`${survivors.length} mutant(s) survived; no test pins these entries:`)
    for (const survivor of survivors) console.log(`  ${survivor.kind}  ${survivor.label}`)
  }
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(EXIT_USAGE)
  })
