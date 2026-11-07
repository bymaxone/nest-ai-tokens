/**
 * Pins the images the CI workflows pre-pull to the images the end-to-end suites start. A pre-pull warms the
 * runner's cache only when it names the exact tag a Testcontainers fixture starts; a different tag makes the
 * fixture download its own image during the timed run.
 *
 * Layer: repository tooling, tests.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')

/** Every image a Testcontainers fixture under `test/e2e` starts, as written in the source. */
function startedImages(): { postgres: Set<string>; all: Set<string> } {
  const dir = join(ROOT, 'test/e2e')
  const postgres = new Set<string>()
  const all = new Set<string>()
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const match of text.matchAll(
      /new PostgreSqlContainer\(\s*(?:process\.env\[[^\]]+\]\s*\?\?\s*)?'([^']+)'/g,
    )) {
      postgres.add(match[1]!)
      all.add(match[1]!)
    }
    for (const match of text.matchAll(/new GenericContainer\(\s*'([^']+)'/g)) all.add(match[1]!)
  }
  return { postgres, all }
}

/** Every image a workflow pre-pulls with `docker pull`. */
function pulledImages(workflow: string): Set<string> {
  const text = readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8')
  return new Set([...text.matchAll(/docker pull (\S+)/g)].map((match) => match[1]!))
}

describe('CI image pre-pulls', () => {
  /** The suites start at least a database and a cache, so an empty scan means the pattern stopped matching. */
  it('finds the images the end-to-end suites start', () => {
    const started = startedImages()
    expect(started.postgres.size).toBeGreaterThan(0)
    expect(started.all.size).toBeGreaterThan(started.postgres.size)
  })

  /** The end-to-end job runs every suite, so it warms every image they start. */
  it('has the end-to-end job pull every image the suites start', () => {
    const pulled = pulledImages('ci.yml')
    for (const image of startedImages().all) expect(pulled).toContain(image)
  })

  /** The matrix job runs the store's database specs, so it warms the database images. */
  it('has the Prisma matrix job pull every database image the suites start', () => {
    const pulled = pulledImages('prisma-matrix.yml')
    for (const image of startedImages().postgres) expect(pulled).toContain(image)
  })
})
