/**
 * Pins the images the end-to-end suites start to one digest-pinned file. The fixtures read it, the workflows
 * pre-pull from it and Dependabot bumps it, so a pre-pull warms the runner's cache only because all three name the
 * same reference; an image named anywhere else would be downloaded during the timed run, or run unpinned.
 *
 * Layer: repository tooling, tests.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const IMAGES_FILE = '.github/ci-images/Dockerfile'

/** The text of a file under the repository root. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** The images file's stages, name to reference. */
function stages(): Map<string, string> {
  return new Map(
    [...read(IMAGES_FILE).matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/gim)].map((match) => [
      match[2]!,
      match[1]!,
    ]),
  )
}

/** The end-to-end sources, with comments left in: a literal image in a comment is still a drift risk. */
function e2eSources(): { file: string; text: string }[] {
  const dir = join(ROOT, 'test/e2e')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(dir, name), 'utf8') }))
}

describe('CI image pins', () => {
  /** A tag alone moves under the runner; the digest is what makes the run reproducible. */
  it('pins the database and the cache by digest', () => {
    const found = stages()
    expect([...found.keys()].sort()).toEqual(['postgres', 'redis'])
    expect(found.get('postgres')).toMatch(/^postgres:[\w.-]+@sha256:[0-9a-f]{64}$/)
    expect(found.get('redis')).toMatch(/^redis:[\w.-]+@sha256:[0-9a-f]{64}$/)
  })

  /** The fixtures start whatever the images file says, never a literal of their own. */
  it('has every fixture start an image from the images file', () => {
    const sources = e2eSources()
    const starts = sources.filter(({ text }) =>
      /new (?:PostgreSqlContainer|GenericContainer)\(/.test(text),
    )
    expect(starts.length).toBeGreaterThan(0)
    for (const { file, text } of starts) {
      expect({
        file,
        literal: /new (?:PostgreSqlContainer|GenericContainer)\(\s*['"`]/.test(text),
      }).toEqual({ file, literal: false })
    }
    const harness = sources.find(({ file }) => file === 'harness.ts')!.text
    expect(harness).toMatch(/new GenericContainer\(REDIS_IMAGE\)/)
    expect(harness).toMatch(/\?\? POSTGRES_IMAGE\)/)
    expect(
      e2eSources()
        .filter(({ text }) =>
          /\b(?:postgres|redis):\d/.test(text.replace(/^\s*(?:\*|\/\/).*$/gm, '')),
        )
        .map(({ file }) => file),
    ).toEqual([])
  })

  /** A pre-pull reads the images file, so it warms the cache with the pin the fixtures start. */
  it('has the workflows pre-pull from the images file', () => {
    for (const workflow of ['ci.yml', 'prisma-matrix.yml']) {
      const lines = read(`.github/workflows/${workflow}`)
        .split('\n')
        .filter((line) => line.includes('docker pull'))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(line).toContain(IMAGES_FILE)
        expect(line).not.toMatch(/docker pull\s+\S*(?:postgres|redis)/)
      }
    }
  })

  /** The pin is only kept current if the bot is pointed at the file that holds it. */
  it('has Dependabot watch the images file', () => {
    expect(read('.github/dependabot.yml')).toMatch(
      /package-ecosystem: docker\s+directory: \/\.github\/ci-images/,
    )
  })
})
