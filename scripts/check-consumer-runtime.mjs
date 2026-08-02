#!/usr/bin/env node
/**
 * Consumer runtime gate.
 *
 * Every other gate reads the source or the type declarations. This one packs the
 * tarball, lays it out the way npm would, and boots NestJS against it — in ESM
 * and in CommonJS — because a defect in how the entry points are *bundled* is
 * invisible to all of them.
 *
 * What it proves: an error thrown by `PrismaAiTokensStore`, from the `./prisma`
 * subpath, satisfies `instanceof AiTokensException` against the class the package
 * root exports. Entry points are separate bundles, so a class reached from two of
 * them by a relative path is copied into each, and a copied class is a different
 * `instanceof` target. The server guards on `instanceof AiTokensException` in four
 * places, so a second copy does not crash — it silently reclassifies store errors
 * as unexpected ones, which no source-based gate can observe: the unit suite maps
 * the specifiers to `src` and sees a single copy.
 *
 * It shells out to `npm pack` and `tar`, both of which have to be on PATH. That
 * is deliberate: packing through npm itself is what makes the gate inspect the
 * same tarball a publish would produce, rather than a directory that resembles
 * it. On Windows, run it from a shell that provides `tar` (Git Bash, WSL, or
 * Windows 10 1803+, which ships bsdtar).
 *
 * Usage: `node scripts/check-consumer-runtime.mjs` (run after `pnpm build`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = '@bymax-one/nest-ai-tokens'

// The consumer lives inside the repository so Node walks up to the repo's own
// `node_modules` for the peer dependencies. Nothing is installed and nothing is
// fetched; only the package under test comes from the tarball.
const consumerDir = join(rootDir, '.consumer-runtime-check')

/** Values the package root must expose, whatever the resolution mode. */
const ROOT_EXPORTS = ['AiTokensException', 'BymaxAiTokensModule']

/** Values each secondary subpath must expose. */
const SUBPATH_EXPORTS = {
  './prisma': ['PrismaAiTokensStore'],
  './redis': ['RedisBudgetCounterStore'],
  './shared': [],
  './prices': [],
}

/**
 * The probe, identical in both formats. Only the bindings it opens with differ,
 * which is the point: the same assertions have to hold under `import` and under
 * `require`, and only running both can show that they do.
 */
const probeBody = `
const failures = []

const absent = ${JSON.stringify(ROOT_EXPORTS)}.filter((n) => root[n] === undefined)
if (absent.length) failures.push('root does not export: ' + absent.join(', '))
if (prisma.PrismaAiTokensStore === undefined) failures.push('./prisma does not export PrismaAiTokensStore')

const main = async () => {
  // A Prisma client that always reports "no such wallet", which is the documented
  // path to AI_TOKENS_INSUFFICIENT_CREDITS and the cheapest reachable throw site.
  const fakePrisma = { $queryRaw: async () => [], $transaction: async (fn) => fn(fakePrisma) }
  const store = new prisma.PrismaAiTokensStore(fakePrisma)

  let thrown
  try {
    await store.reconcile({ tenantId: 't', userId: 'u' })
  } catch (error) {
    thrown = error
  }

  if (thrown === undefined) {
    failures.push('reconcile did not throw on a missing wallet — the probe is no longer reaching the throw site')
  } else if (!(thrown instanceof root.AiTokensException)) {
    const name = thrown && thrown.constructor ? thrown.constructor.name : String(thrown)
    failures.push(
      './prisma threw ' + name + ' which is not an instanceof the root AiTokensException — ' +
        'the four server guards would silently misclassify it',
    )
  }

  if (failures.length) {
    for (const failure of failures) console.error('  ✗ ' + failure)
    process.exit(1)
  }
  console.log('  ✓ ' + FORMAT + ': ./prisma errors satisfy instanceof against the root AiTokensException')
}

main().catch((error) => {
  console.error('  ✗ ' + FORMAT + ' probe crashed: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
`

const esmProbe = `import * as root from '${packageName}'
import * as prisma from '${packageName}/prisma'
const FORMAT = 'ESM'
${probeBody}`

const cjsProbe = `const root = require('${packageName}')
const prisma = require('${packageName}/prisma')
const FORMAT = 'CJS'
${probeBody}`

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options })
}

function cleanup() {
  rmSync(consumerDir, { recursive: true, force: true })
}

console.log('Consumer runtime gate')

if (!existsSync(join(rootDir, 'dist'))) {
  console.error('✗ dist/ is missing — run `pnpm build` first')
  process.exit(1)
}

cleanup()
const packDir = mkdtempSync(join(tmpdir(), 'nest-ai-tokens-pack-'))
let failed = false

try {
  // `--ignore-scripts` keeps `prepublishOnly` from rebuilding underneath the
  // artifact this gate is meant to inspect.
  const packOutput = run('npm', [
    'pack',
    '--ignore-scripts',
    '--silent',
    '--pack-destination',
    packDir,
  ])
  const tarball = join(packDir, packOutput.trim().split('\n').pop().trim())

  const packageDir = join(consumerDir, 'node_modules', packageName)
  mkdirSync(packageDir, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1'])

  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'consumer-runtime-check', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`,
  )
  writeFileSync(join(consumerDir, 'probe.mjs'), esmProbe)
  writeFileSync(join(consumerDir, 'probe.cjs'), cjsProbe)

  for (const probe of ['probe.mjs', 'probe.cjs']) {
    try {
      process.stdout.write(run('node', [probe], { cwd: consumerDir, stdio: 'pipe' }))
    } catch (error) {
      process.stdout.write(error.stdout ?? '')
      process.stderr.write(error.stderr ?? '')
      failed = true
    }
  }
} catch (error) {
  console.error(`✗ gate setup failed: ${error.message}`)
  if (error.stderr) process.stderr.write(error.stderr)
  failed = true
} finally {
  cleanup()
  rmSync(packDir, { recursive: true, force: true })
}

if (failed) {
  console.error('\n✗ The published artifact does not work for a consumer.')
  process.exit(1)
}

console.log('✓ Entry points share one runtime in ESM and CommonJS.')
