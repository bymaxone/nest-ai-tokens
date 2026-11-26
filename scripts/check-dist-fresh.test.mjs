/**
 * @fileoverview Tests of the stale-build guard: which files count as a source, how the oldest output is
 * compared with the newest source, and the command's exit status on a real directory, so the guard is held
 * by a test and not by a habit.
 * @layer scripts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { judge, parseOptions, run } from './check-dist-fresh.mjs'

const SCRIPT = fileURLToPath(new URL('./check-dist-fresh.mjs', import.meta.url))
const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A throwaway package whose files carry the given mtimes, in seconds (path to seconds). */
function pkg(files) {
  const root = mkdtempSync(join(tmpdir(), 'dist-fresh-'))
  roots.push(root)
  for (const [path, seconds] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), 'x')
    utimesSync(join(root, path), seconds, seconds)
  }
  return root
}

const cli = (root, args = [], env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })

describe('judge', () => {
  const at = (path, mtimeMs) => ({ path, mtimeMs })

  it('passes when every output is newer than every source', () => {
    assert.equal(judge([at('src/a.ts', 1)], [at('dist/a.mjs', 2), at('dist/b.mjs', 3)]).ok, true)
  })

  it('fails on the OLDEST output, not the newest, and names both files', () => {
    const verdict = judge([at('src/a.ts', 5)], [at('dist/old.mjs', 2), at('dist/new.mjs', 9)])
    assert.equal(verdict.ok, false)
    assert.match(verdict.message, /dist\/old\.mjs is older than src\/a\.ts/)
  })

  it('treats an output with the same time as a source as fresh, and no output as a missing build', () => {
    assert.equal(judge([at('src/a.ts', 4)], [at('dist/a.mjs', 4)]).ok, true)
    assert.match(judge([at('src/a.ts', 1)], []).message, /no build output/)
  })

  it('passes a package with no source at all', () => {
    assert.equal(judge([], [at('dist/a.mjs', 1)]).ok, true)
  })
})

describe('parseOptions', () => {
  it('defaults to src, dist, tsup.config.ts and package.json, and repeats --src and --also', () => {
    assert.deepEqual(parseOptions([]), { src: ['src'], dist: 'dist', also: ['tsup.config.ts', 'package.json'], tarballOk: false })
    assert.deepEqual(parseOptions(['--src', 'a', '--src', 'b', '--also', 'x', '--dist', 'out']), {
      src: ['a', 'b'],
      dist: 'out',
      also: ['x'],
      tarballOk: false,
    })
  })

  it('reads --tarball-ok as a flag that takes no value, in any position', () => {
    assert.equal(parseOptions(['--tarball-ok']).tarballOk, true)
    const options = parseOptions(['--src', 'a', '--tarball-ok', '--dist', 'out'])
    assert.deepEqual([options.src, options.dist, options.tarballOk], [['a'], 'out', true])
  })

  it('refuses an unknown option and an option without a value', () => {
    assert.throws(() => parseOptions(['--nope', 'x']), /Unknown option/)
    assert.throws(() => parseOptions(['--src']), /--src needs a value/)
    assert.throws(() => parseOptions(['--dist', '--src']), /--dist needs a value/)
    assert.throws(() => parseOptions(['--src', undefined]), /--src needs a value/)
  })
})

describe('the command', () => {
  it('passes a build newer than its sources', () => {
    const root = pkg({ 'src/a.ts': 100, 'tsup.config.ts': 100, 'dist/a.mjs': 200 })
    assert.equal(cli(root).status, 0)
  })

  it('fails a build older than a source, and names the files', () => {
    const root = pkg({ 'src/deep/a.ts': 300, 'dist/a.mjs': 200 })
    const result = cli(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /dist\/a\.mjs is older than src\/deep\/a\.ts/)
  })

  it('fails a build older than tsup.config.ts, which shapes what is built', () => {
    const root = pkg({ 'src/a.ts': 100, 'tsup.config.ts': 300, 'dist/a.mjs': 200 })
    assert.equal(cli(root).status, 1)
  })

  it('fails a build older than package.json, since a dependency bump changes the bundle', () => {
    const root = pkg({ 'src/a.ts': 100, 'package.json': 300, 'dist/a.mjs': 200 })
    const result = cli(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /dist\/a\.mjs is older than package\.json/)
  })

  it('does not count a spec or a test file as a source', () => {
    const root = pkg({ 'src/a.ts': 100, 'src/a.spec.ts': 900, 'src/b.test.mjs': 900, 'dist/a.mjs': 200 })
    assert.equal(cli(root).status, 0)
  })

  it('fails a missing dist with the way to fix it', () => {
    const root = pkg({ 'src/a.ts': 100 })
    const result = cli(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /pnpm build/)
  })

  it('ignores PACKAGE_TARBALL without --tarball-ok, so a script that measures dist/ is still guarded', () => {
    const root = pkg({ 'src/a.ts': 300, 'dist/a.mjs': 200, 'x.tgz': 100 })
    assert.equal(cli(root, [], { PACKAGE_TARBALL: join(root, 'x.tgz') }).status, 1)
    assert.equal(cli(root, [], { PACKAGE_TARBALL: '/missing.tgz' }).status, 1)
  })

  it('passes without comparing when --tarball-ok is given and PACKAGE_TARBALL names a file', () => {
    const root = pkg({ 'src/a.ts': 300, 'dist/a.mjs': 200, 'x.tgz': 100 })
    assert.equal(cli(root, ['--tarball-ok'], { PACKAGE_TARBALL: join(root, 'x.tgz') }).status, 0)
    assert.equal(cli(root, ['--tarball-ok'], { PACKAGE_TARBALL: 'x.tgz' }).status, 0)
  })

  it('fails with --tarball-ok when PACKAGE_TARBALL names a file that is not there, or a directory', () => {
    const root = pkg({ 'src/a.ts': 100, 'dist/a.mjs': 200 })
    const missing = cli(root, ['--tarball-ok'], { PACKAGE_TARBALL: '/missing.tgz' })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /not a file/)
    assert.equal(cli(root, ['--tarball-ok'], { PACKAGE_TARBALL: join(root, 'dist') }).status, 1)
  })

  it('compares dist/ with --tarball-ok when PACKAGE_TARBALL is unset or empty', () => {
    const root = pkg({ 'src/a.ts': 300, 'dist/a.mjs': 200 })
    assert.equal(cli(root, ['--tarball-ok']).status, 1)
    assert.equal(cli(root, ['--tarball-ok'], { PACKAGE_TARBALL: '' }).status, 1)
  })

  it('exits 2 on a bad command line', () => {
    const root = pkg({ 'src/a.ts': 100, 'dist/a.mjs': 200 })
    assert.equal(cli(root, ['--src']).status, 2)
  })

  it('reads the directories it is given', () => {
    const root = pkg({ 'lib/a.ts': 300, 'out/a.js': 200, 'src/a.ts': 100 })
    assert.equal(cli(root, ['--src', 'lib', '--dist', 'out']).status, 1)
    assert.equal(cli(root, ['--src', 'src', '--dist', 'out']).status, 0)
  })

  it('is callable as a function with the same verdict', () => {
    const root = pkg({ 'src/a.ts': 300, 'dist/a.mjs': 200 })
    assert.equal(run([], root, {}).status, 1)
  })
})
