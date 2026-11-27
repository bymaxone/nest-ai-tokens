/**
 * @fileoverview Self-test for the verdicts of `mutate-const-tables.mjs`: each fixture command ends
 * the way a test runner does, and the test pins the verdict the script gives it.
 * @layer scripts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

// Long enough for a slow runner to start a fixture; only the rows that hang wait for it.
const LIMIT_MS = 5000
process.env.CONST_TABLES_TIMEOUT_MS = String(LIMIT_MS)

const target = process.env.CONST_TABLES_SCRIPT
  ? pathToFileURL(resolve(process.env.CONST_TABLES_SCRIPT)).href
  : new URL('./mutate-const-tables.mjs', import.meta.url).href
const { judge } = await import(target)

/** A command that prints `text` to stderr, then exits with `code` or dies from `signal`. */
const fixture = (text, { code = 0, signal = null } = {}) => [
  process.execPath,
  '-e',
  `process.stderr.write(${JSON.stringify(text)}); ${signal ? `process.kill(process.pid, '${signal}')` : `process.exit(${code})`}`,
  '--'
]

const verdict = (command) => judge(process.cwd(), command, 'src/x.ts')

test('a failed assertion is killed', async () => {
  const out =
    '● table › pins it\n  expect(received).toStrictEqual(expected)\nTests:       1 failed, 3 passed, 4 total\n'
  assert.equal(await verdict(fixture(out, { code: 1 })), 'killed')
})

test('a green run survived', async () => {
  assert.equal(await verdict(fixture('Tests:       4 passed, 4 total\n')), 'survived')
})

test('a suite that failed to run is a load failure, not a kill', async () => {
  const out = '● Test suite failed to run\n  TypeError: x is undefined\nTests:       0 total\n'
  assert.equal(await verdict(fixture(out, { code: 1 })), 'load-failure')
})

test('a crash line whose first character arrives in two chunks is still read', async () => {
  // The pause lets the first byte of the three-byte marker arrive on its own.
  const text = '● Test suite failed to run\n\nTests:       1 failed, 1 total\n'
  const script = `
    const bytes = Buffer.from(${JSON.stringify(text)})
    process.stderr.write(bytes.subarray(0, 1))
    setTimeout(() => { process.stderr.write(bytes.subarray(1)); process.exitCode = 1 }, 300)
  `
  assert.equal(await verdict([process.execPath, '-e', script, '--']), 'crash')
})

test('a run killed by a signal is crash-only', async () => {
  assert.equal(await verdict(fixture('', { signal: 'SIGKILL' })), 'crash')
})

test('a failure with no test summary is crash-only', async () => {
  assert.equal(
    await verdict(fixture('Jest worker encountered 4 child process exceptions\n', { code: 1 })),
    'crash'
  )
  assert.equal(await verdict(fixture('', { code: 1 })), 'crash')
})

test('a command that hangs, with a child that holds the output open, is stopped and is a timeout', async () => {
  const hang = ['sh', '-c', 'sleep 600 & wait', '--']
  const started = Date.now()
  assert.equal(await verdict(hang), 'timeout')
  assert.ok(Date.now() - started < 3 * LIMIT_MS)
})

test('every run gets --forceExit, and the in-band rerun drops the worker count', async () => {
  // A run without --forceExit passes, so either run missing it ends as 'survived'. With it, the
  // first run crashes and the rerun fails an assertion only when the worker count is gone.
  const script = `
    const args = process.argv.slice(1)
    if (!args.includes('--forceExit')) process.exit(0)
    if (!args.includes('--runInBand')) process.exit(1)
    const ok = !args.some((a) => a.startsWith('--maxWorkers') || a === '1')
    process.stderr.write(ok ? 'Tests:       1 failed, 1 total\\n' : '')
    process.exit(1)
  `
  const command = [process.execPath, '-e', script, '--', 'jest', '--maxWorkers', '1']
  assert.equal(await verdict(command), 'killed-after-rerun')
})

test('a failed assertion that only mentions a crash word is still a kill', async () => {
  const output = [
    '  ● spawner › reports a SIGSEGV of the child process',
    '    Expected: "Jest worker encountered out of memory"',
    'Tests:       1 failed, 3 passed, 4 total',
    ''
  ].join('\n')
  assert.equal(await verdict(fixture(output, { code: 1 })), 'killed')
})

test('a runner death beside a failed test is crash-only', async () => {
  for (const death of [
    '    Jest worker encountered 4 child process exceptions, exceeding retry limit',
    '    A jest worker process (pid=7) was terminated by another process: signal=SIGSEGV',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'
  ]) {
    const output = `${death}\nTests:       1 failed, 1 total\n`
    assert.equal(await verdict(fixture(output, { code: 1 })), 'crash', death)
  }
})

test('the report of a failed test is not searched for crash markers', async () => {
  const output = [
    '  ● spawner › names the child process',
    '',
    '    Jest worker encountered 4 child process exceptions, exceeding retry limit',
    '',
    '      > 3 |   throw new Error("Test suite failed to run")',
    '',
    'Tests:       1 failed, 3 passed, 4 total',
    ''
  ].join('\n')
  assert.equal(await verdict(fixture(output, { code: 1 })), 'killed')
})

test('a coloured summary is read like a plain one', async () => {
  const out = 'Tests:       \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m, 1 total\n'
  assert.equal(await verdict(fixture(out, { code: 1 })), 'killed')
})

test('a detached descendant that keeps the output open does not extend the limit', async () => {
  const script = `
    const { spawn } = require('node:child_process')
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit']
    }).unref()
    setTimeout(() => {}, 600000)
  `
  const started = Date.now()
  const command = [process.execPath, '-e', script, '--', '--runInBand']
  assert.equal(await verdict(command), 'timeout')
  assert.ok(Date.now() - started < 2 * LIMIT_MS)
})

test('a command that exits while a descendant holds the output is judged by what it said', async () => {
  const script = `
    const { spawn } = require('node:child_process')
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 7000)'], {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit']
    }).unref()
    process.stderr.write('Tests:       1 failed, 1 total\\n')
    process.exitCode = 1
  `
  const started = Date.now()
  assert.equal(await verdict([process.execPath, '-e', script, '--']), 'killed')
  assert.ok(Date.now() - started < LIMIT_MS)
})

test('the in-band rerun drops every spelling of the worker count after the runner', async () => {
  for (const workers of [
    ['-w', '2'],
    ['-w=2'],
    ['-w2'],
    ['--maxWorkers=2'],
    ['--max-workers=2'],
    ['--max-workers', '2']
  ]) {
    const script = `
      const args = process.argv.slice(1)
      if (!args.includes('--runInBand')) process.exit(1)
      const left = args.filter((a) => /^(-w|--max)/.test(a) || a === '2')
      process.stderr.write(left.length === 0 ? 'Tests:       1 failed, 1 total\\n' : '')
      process.exit(1)
    `
    const command = [process.execPath, '-e', script, '--', 'node_modules/.bin/jest', ...workers]
    assert.equal(await verdict(command), 'killed-after-rerun', workers.join(' '))
  }
})

test("the in-band rerun keeps the package manager's own -w", async () => {
  const script = `
    const args = process.argv.slice(1)
    if (!args.includes('--runInBand')) process.exit(1)
    const kept = args[0] === '-w' && args[1] === 'pkg'
    process.stderr.write(kept ? 'Tests:       1 failed, 1 total\\n' : '')
    process.exit(1)
  `
  for (const rest of [
    ['-w', 'pkg', 'jest'],
    ['-w', 'pkg']
  ]) {
    const command = [process.execPath, '-e', script, '--', ...rest]
    assert.equal(await verdict(command), 'killed-after-rerun', rest.join(' '))
  }
})

/** A repository with one table, whose `typescript` is the one this test file resolves. */
function repositoryWithTable() {
  const root = mkdtempSync(join(tmpdir(), 'const-tables-'))
  const typescript = createRequire(import.meta.url).resolve('typescript')
  mkdirSync(join(root, 'node_modules', 'typescript'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', 'typescript', 'index.js'),
    `module.exports = require(${JSON.stringify(typescript)})\n`
  )
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 't.ts'), "export const T = ['a'] as const\n")
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', 'src'], { cwd: root })
  return root
}

test('the run is refused when the command fails in band on the unmutated file', () => {
  // Passes as given on the unmutated file and crashes on a mutant; in band it always fails.
  const script = `
    if (process.argv.includes('--runInBand')) {
      process.stderr.write('Tests:       1 failed, 1 total\\n')
      process.exit(1)
    }
    const text = require('node:fs').readFileSync(process.env.MUTATED_FILE, 'utf8')
    process.exit(text.includes("'a'") ? 0 : 1)
  `
  const root = repositoryWithTable()
  try {
    const path = process.env.CONST_TABLES_SCRIPT
      ? resolve(process.env.CONST_TABLES_SCRIPT)
      : fileURLToPath(new URL('./mutate-const-tables.mjs', import.meta.url))
    const run = spawnSync(
      process.execPath,
      [path, '--root', root, '--', process.execPath, '-e', script, '--'],
      { encoding: 'utf8' }
    )
    assert.equal(run.status, 2, run.stdout + run.stderr)
    assert.match(run.stderr, /--runInBand.*unmutated file src\/t\.ts/)
    assert.doesNotMatch(run.stderr, /KILLED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file edited before its turn is left as edited, and the run is refused', () => {
  // While src/t.ts is mutated, the command appends to src/u.ts, whose turn comes later.
  const script = `
    const fs = require('node:fs')
    const text = fs.readFileSync(process.env.MUTATED_FILE, 'utf8')
    if (text.includes("'a'") || text.includes("'b'")) process.exit(0)
    if (process.env.MUTATED_FILE === 'src/t.ts') fs.appendFileSync('src/u.ts', '// edit')
    process.stderr.write('Tests:       1 failed, 1 total\\n')
    process.exit(1)
  `
  const root = repositoryWithTable()
  try {
    writeFileSync(join(root, 'src', 'u.ts'), "export const U = ['b'] as const\n")
    execFileSync('git', ['add', 'src'], { cwd: root })
    const path = process.env.CONST_TABLES_SCRIPT
      ? resolve(process.env.CONST_TABLES_SCRIPT)
      : fileURLToPath(new URL('./mutate-const-tables.mjs', import.meta.url))
    const run = spawnSync(
      process.execPath,
      [path, '--root', root, '--', process.execPath, '-e', script, '--'],
      { encoding: 'utf8' }
    )
    assert.equal(
      readFileSync(join(root, 'src', 'u.ts'), 'utf8'),
      "export const U = ['b'] as const\n// edit"
    )
    assert.equal(
      readFileSync(join(root, 'src', 't.ts'), 'utf8'),
      "export const T = ['a'] as const\n"
    )
    assert.equal(run.status, 2, run.stdout + run.stderr)
    assert.match(run.stderr, /src\/u\.ts changed during the run/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
