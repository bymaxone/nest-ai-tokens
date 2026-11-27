/**
 * @fileoverview Tests of the spec-header gate: what a valid header is, how the baseline can only shrink, and the
 * command's exit status on a real repository, so the gate itself is held by a test and not by a habit.
 * @layer scripts
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { headerProblem, parseBaseline, problemsOf } from './check-spec-headers.mjs'

const SCRIPT = fileURLToPath(new URL('./check-spec-headers.mjs', import.meta.url))
const GOOD = '/**\n * @fileoverview Specs of the widget: what it accepts and what it refuses.\n * @layer server\n */\n\nimport x from "x"\n'

describe('headerProblem', () => {
  it('accepts a header with a purpose and a layer', () => {
    assert.equal(headerProblem(GOOD), null)
  })

  it('accepts the Layer: sentence form and a byte-order mark', () => {
    assert.equal(headerProblem('﻿/**\n * What the widget spec covers in detail. Layer: shared.\n */\n'), null)
  })

  it('refuses a file that opens with code', () => {
    assert.match(headerProblem('import x from "x"\n') ?? '', /does not open with/)
  })

  it('refuses a line comment and a header that is not a block comment', () => {
    assert.match(headerProblem('// Specs of the widget\nimport x from "x"\n') ?? '', /does not open with/)
    assert.match(headerProblem('/* Specs of the widget @layer server */\n') ?? '', /does not open with/)
  })

  it('refuses a header without a layer marker', () => {
    assert.match(headerProblem('/**\n * Specs of the widget and what it accepts.\n */\n') ?? '', /no layer marker/)
  })

  it('refuses a layer outside the list', () => {
    assert.match(headerProblem('/**\n * Specs of the widget and what it accepts.\n * @layer frontend\n */\n') ?? '', /"frontend"/)
  })

  it('refuses a header that states a layer but not what the file tests', () => {
    assert.match(headerProblem('/**\n * @fileoverview Widget.\n * @layer server\n */\n') ?? '', /not what the file tests/)
  })

  it('reads every layer the repository uses', () => {
    for (const layer of ['server', 'shared', 'prices', 'prisma', 'redis', 'test', 'tests', 'docs', 'repository', 'scripts']) {
      assert.equal(headerProblem(`/**\n * Specs of the widget and what it accepts.\n * @layer ${layer}\n */\n`), null)
    }
  })
})

describe('problemsOf', () => {
  const offenders = new Map([['a.spec.ts', 'does not open with a /** */ block comment']])

  it('passes when every offender is on the baseline and the baseline lists only offenders', () => {
    assert.deepEqual(problemsOf(offenders, new Set(['a.spec.ts']), null), [])
  })

  it('fails a new offender that is not on the baseline', () => {
    assert.deepEqual(problemsOf(offenders, new Set(), null), ['a.spec.ts: does not open with a /** */ block comment.'])
  })

  it('fails a baselined file that was fixed or is gone, until its entry is removed', () => {
    const [problem] = problemsOf(new Map(), new Set(['b.spec.ts']), null)
    assert.match(problem ?? '', /b\.spec\.ts is on the baseline but now has a valid header/)
  })

  it('fails an entry the base revision did not have, and passes one it had', () => {
    const widened = problemsOf(offenders, new Set(['a.spec.ts']), new Set())
    assert.match(widened[0] ?? '', /base revision does not have it/)
    assert.deepEqual(problemsOf(offenders, new Set(['a.spec.ts']), new Set(['a.spec.ts'])), [])
  })
})

describe('parseBaseline', () => {
  it('reads the list of files', () => {
    assert.deepEqual([...parseBaseline('{"files":["a.spec.ts"]}', 'x')], ['a.spec.ts'])
  })

  it('refuses a baseline that is not a list of strings', () => {
    assert.throws(() => parseBaseline('{"files":{"a":1}}', 'x'), /expected/)
    assert.throws(() => parseBaseline('{"files":[1]}', 'x'), /expected/)
    assert.throws(() => parseBaseline('{}', 'x'), /expected/)
  })
})

/** A scratch git repository with the given files tracked. */
function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), 'spec-headers-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

/** Run the command over a scratch repository with the given baseline text. */
function run(root, baselineText) {
  writeFileSync(join(root, 'baseline.json'), baselineText)
  return spawnSync(process.execPath, [SCRIPT, '--root', root, '--baseline', join(root, 'baseline.json')], { encoding: 'utf8' })
}

describe('the command', () => {
  // A skipped run exits 0, so a spelling that does not run the script passes the gate.
  it('runs when its path goes through a symlink', () => {
    const root = scratch({ 'src/bad.spec.ts': 'import x from "x"\n' })
    try {
      writeFileSync(join(root, 'baseline.json'), '{"files":[]}')
      symlinkSync(dirname(SCRIPT), join(root, 'linked'), 'dir')
      const script = join(root, 'linked', 'check-spec-headers.mjs')
      const result = spawnSync(process.execPath, [script, '--root', root, '--baseline', join(root, 'baseline.json')], { encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /src\/bad\.spec\.ts/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not run when it is only imported', () => {
    const importer = `await import(${JSON.stringify(new URL('./check-spec-headers.mjs', import.meta.url).href)})`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', importer, 'no-such-file'], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stdout + result.stderr, '')
  })

  it('exits 0 for a spec with a header and one on the baseline, in the unit and end-to-end names', () => {
    const root = scratch({ 'src/ok.spec.ts': GOOD, 'src/old.spec.ts': 'import x from "x"\n', 'test/e2e/new-spec.ts': GOOD })
    try {
      const result = run(root, '{"files":["src/old.spec.ts"]}')
      assert.equal(result.status, 0, result.stderr)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exits 1 and names a new spec without a header, in either name form', () => {
    const root = scratch({ 'src/ok.spec.ts': GOOD, 'src/bad.spec.ts': 'import x from "x"\n', 'test/e2e/bad-spec.ts': 'import y from "y"\n' })
    try {
      const result = run(root, '{"files":[]}')
      assert.equal(result.status, 1)
      assert.match(result.stderr, /src\/bad\.spec\.ts/)
      assert.match(result.stderr, /test\/e2e\/bad-spec\.ts/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not check files that are not specs', () => {
    const root = scratch({ 'src/helper.ts': 'import x from "x"\n' })
    try {
      assert.equal(run(root, '{"files":[]}').status, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exits 1 for a baselined spec that now has a header', () => {
    const root = scratch({ 'src/fixed.spec.ts': GOOD })
    try {
      const result = run(root, '{"files":["src/fixed.spec.ts"]}')
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Remove its entry/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('compares with the base revision: an entry the base lacks fails', () => {
    const root = scratch({ 'src/old.spec.ts': 'import x from "x"\n' })
    try {
      writeFileSync(join(root, 'baseline.json'), '{"files":[]}')
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: root })
      const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--baseline', join(root, 'baseline.json'), '--base', 'HEAD'], { encoding: 'utf8' })
      assert.equal(result.status, 1)
      writeFileSync(join(root, 'baseline.json'), '{"files":["src/old.spec.ts"]}')
      const widened = spawnSync(process.execPath, [SCRIPT, '--root', root, '--baseline', join(root, 'baseline.json'), '--base', 'HEAD'], { encoding: 'utf8' })
      assert.equal(widened.status, 1)
      assert.match(widened.stderr, /base revision does not have it/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
