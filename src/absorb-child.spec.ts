/**
 * @fileoverview What a real process sees when the host's logger throws while an absorbed failure is written. Jest never delivers an
 * `unhandledRejection` to a listener of the test process, so a case run in it passes whether or not a rejection is left behind. Here the
 * helper is bundled and run in a `node` child of its own, which counts the real `unhandledRejection` events it raises and whether
 * the call returned.
 * @layer server
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Inside `node_modules`, which is not tracked, and below the package, so that `@nestjs/common` is found from the bundle. */
const FIXTURE_DIR = join(process.cwd(), 'node_modules', '.absorb-child-fixture')
const BUNDLE = join(FIXTURE_DIR, 'absorb-host-call.cjs')

/** The child: a logger whose `warn` throws, one host call of the shape named, and what the process observed. */
const CHILD = `
const { absorbHostCall, absorbHostCallAndWait } = require(process.argv[1])
let unhandled = 0
process.on('unhandledRejection', () => { unhandled += 1 })
const logger = { warn() { throw new Error('logger') } }
const calls = {
  throws: () => { throw new Error('host') },
  rejects: () => Promise.reject(new Error('host')),
  thenable: () => ({ then: (_resolve, reject) => reject(new Error('host')) }),
}
const shape = process.argv[2]
let returned = false
const run = async () => {
  if (shape === 'waits') await absorbHostCallAndWait(logger, 'k', calls.rejects)
  else absorbHostCall(logger, 'k', calls[shape])
  returned = true
  await new Promise((resolve) => setTimeout(resolve, 30))
}
run().then(() => process.stdout.write(JSON.stringify({ returned, unhandled })), (error) => process.stdout.write(JSON.stringify({ returned, unhandled, error: String(error.message) })))
`

describe('an absorbed failure when the logger throws, in a real process', () => {
  beforeAll(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true })
    execFileSync('pnpm', ['exec', 'tsup', 'src/server/utils/absorb-host-call.ts', '--format', 'cjs', '--out-dir', FIXTURE_DIR, '--no-config', '--silent'], { stdio: 'pipe' })
  }, 120_000)

  it.each(['throws', 'rejects', 'thenable', 'waits'])('returns normally and raises no unhandled rejection when the host call %s', (shape) => {
    const out = execFileSync('node', ['-e', CHILD, BUNDLE, shape], { encoding: 'utf8', timeout: 30_000 })
    expect(JSON.parse(out)).toEqual({ returned: true, unhandled: 0 })
  })
})
