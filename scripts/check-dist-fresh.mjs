#!/usr/bin/env node
/**
 * @fileoverview Fails when `dist/` is older than the sources it was built from, so a script that measures
 * the build (a size budget, an export check) does not report on a stale one. Plain Node, no dependencies.
 *
 *   node scripts/check-dist-fresh.mjs [--src <dir>]... [--dist <dir>] [--also <file>]... [--tarball-ok]
 *
 * The newest source is the newest file under each `--src` directory (default `src`) that is not a test, and
 * each `--also` file (default `tsup.config.ts` and `package.json`, when they exist). The oldest build output is the oldest file
 * under `--dist` (default `dist`). The build is stale when a source is newer than that output. Exit status:
 * 0 fresh, 1 stale or missing, 2 a bad command line.
 *
 * `--tarball-ok` is for a library whose measuring script reads the tarball named by `PACKAGE_TARBALL` and not
 * `dist/`. With it, and with `PACKAGE_TARBALL` set, there is nothing to compare: the check passes when that file
 * exists and fails when it does not. Without the flag the variable is ignored, because a script that measures
 * `dist/` never reads it and would report on a stale build.
 * @layer scripts
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A spec or a test changes without changing what the build emits, so it is not a source. */
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/

/** Every file under `dir`, as `{ path, mtimeMs }`; a directory that does not exist yields none. */
export function filesUnder(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return found
    throw error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path))
    else if (entry.isFile()) found.push({ path, mtimeMs: statSync(path).mtimeMs })
  }
  return found
}

/**
 * The verdict for one tree: `{ ok, message }`. `sources` and `outputs` are `{ path, mtimeMs }` lists.
 * A tree with no output is a missing build; a tree with no source has nothing to be older than.
 */
export function judge(sources, outputs, root = '.') {
  if (outputs.length === 0) return { ok: false, message: 'There is no build output: run `pnpm build` first.' }
  const oldest = outputs.reduce((a, b) => (b.mtimeMs < a.mtimeMs ? b : a))
  const newest = sources.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a), { path: '', mtimeMs: -Infinity })
  if (newest.mtimeMs > oldest.mtimeMs) {
    return {
      ok: false,
      message: `${relative(root, oldest.path)} is older than ${relative(root, newest.path)}: the build is stale, run \`pnpm build\` first.`,
    }
  }
  return { ok: true, message: 'The build is newer than its sources.' }
}

/** Reads the options; throws on one it does not know or one given without a value. */
export function parseOptions(argv) {
  const options = { src: [], dist: 'dist', also: [], tarballOk: false }
  const args = argv.values()
  for (let next = args.next(); !next.done; next = args.next()) {
    const name = next.value
    if (name === '--tarball-ok') {
      options.tarballOk = true
      continue
    }
    if (!['--src', '--dist', '--also'].includes(name)) throw new Error(`Unknown option ${name}.`)
    const given = args.next()
    if (given.done || typeof given.value !== 'string' || given.value.startsWith('--')) throw new Error(`${name} needs a value.`)
    if (name === '--dist') options.dist = given.value
    else if (name === '--src') options.src.push(given.value)
    else options.also.push(given.value)
  }
  if (options.src.length === 0) options.src.push('src')
  if (options.also.length === 0) options.also.push('tsup.config.ts', 'package.json')
  return options
}

/** Runs the check in `root`; returns `{ status, message }`. */
export function run(argv, root, env) {
  let options
  try {
    options = parseOptions(argv)
  } catch (error) {
    return { status: 2, message: error.message }
  }
  const tarball = env.PACKAGE_TARBALL
  if (options.tarballOk && tarball !== undefined && tarball !== '') {
    let found = false
    try {
      found = statSync(resolve(root, tarball)).isFile()
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    if (!found) return { status: 1, message: `PACKAGE_TARBALL names ${tarball}, which is not a file: pack the package first.` }
    return { status: 0, message: 'PACKAGE_TARBALL is set: the tarball is measured, not dist/, so there is nothing to compare.' }
  }
  const sources = options.src
    .flatMap((dir) => filesUnder(join(root, dir)))
    .filter((file) => !TEST_FILE.test(file.path))
  for (const extra of options.also) {
    try {
      sources.push({ path: join(root, extra), mtimeMs: statSync(join(root, extra)).mtimeMs })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const verdict = judge(sources, filesUnder(join(root, options.dist)), root)
  return { status: verdict.ok ? 0 : 1, message: verdict.message }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { status, message } = run(process.argv.slice(2), process.cwd(), process.env)
  ;(status === 0 ? console.log : console.error)(status === 0 ? message : `✖ ${message}`)
  process.exit(status)
}
