/**
 * @fileoverview Pins `scripts/check-function-length.mjs`, the gate for the 50-line limit on a function or a test
 * body: how it compares with the baseline and with a base revision, how nested functions are
 * reported, what `--write-baseline` writes, and that the committed baseline is the generated one.
 * It is plain Node, so each case runs it the way CI does, as a child process against a throwaway
 * git repository, and asserts the exit code and the printed problems.
 *
 * @layer tests
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(__dirname, '..', 'scripts', 'check-function-length.mjs')

interface Result {
  readonly status: number | null
  readonly output: string
}

const roots: string[] = []

/** A segment of a key, as the format specifies them: a kind first, then its strings. */
type Segment = string[]

/**
 * The key the baseline holds for a function, written out from the format's definition and not by
 * the script: `[path, ...segments]`, with a trailing ordinal from 2.
 */
function keyOf(path: string, segments: Segment[], ordinal = 1): string {
  return JSON.stringify(ordinal === 1 ? [path, ...segments] : [path, ...segments, ordinal])
}

/** A top-level function `name` in `src/a.ts`. */
function fnKey(name: string, ordinal = 1): string {
  return keyOf('src/a.ts', [['fn', name]], ordinal)
}

/** `lines` lines of statements, for the inside of a body. */
function statements(lines: number): string {
  return '  work()\n'.repeat(lines)
}

/** A function declaration named `name` spanning exactly `lines` lines, signature and brace included. */
function declaration(name: string, lines: number): string {
  return `function ${name}() {\n${statements(lines - 2)}}\n`
}

/** Lays out a git repository holding `files` (path to text), all added to the index. */
function repo(files: Record<string, string>, functions: Record<string, number> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'function-length-spec-'))
  roots.push(root)
  spawnSync('git', ['init', '-q'], { cwd: root })
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeBaseline(root, functions)
  spawnSync('git', ['add', '-A'], { cwd: root })
  return root
}

/** Writes the working-tree baseline of `root` without committing it. */
function writeBaseline(root: string, functions: unknown): void {
  writeFileSync(
    join(root, 'scripts', 'function-length-baseline.json'),
    JSON.stringify({ functions })
  )
}

/** Runs the script in `root` and returns its exit status and combined output. */
function run(root: string, ...args: string[]): Result {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8'
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** Commits the index as the base revision of `root`, so `--base HEAD` can read the baseline from it. */
function commitBase(root: string): void {
  spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base'],
    { cwd: root }
  )
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('check-function-length', () => {
  describe('against the baseline', () => {
    const KEY = fnKey('big')
    const NAME = 'src/a.ts::big'

    it('passes a function at its recorded length', () => {
      expect(run(repo({ 'src/a.ts': declaration('big', 60) }, { [KEY]: 60 })).status).toBe(0)
    })

    it('fails a baselined function that grew', () => {
      const result = run(repo({ 'src/a.ts': declaration('big', 61) }, { [KEY]: 60 }))

      expect(result.status).toBe(1)
      expect(result.output).toContain(
        `${NAME} grew from 60 to 61 lines. A baselined function may only shrink.`
      )
    })

    it('fails until the entry of a function that shrank is lowered', () => {
      const result = run(repo({ 'src/a.ts': declaration('big', 55) }, { [KEY]: 60 }))

      expect(result.status).toBe(1)
      expect(result.output).toContain('Lower its baseline entry from 60 to 55')
    })

    it('fails until the entry of a function now within the limit is removed', () => {
      const result = run(repo({ 'src/a.ts': declaration('big', 50) }, { [KEY]: 60 }))

      expect(result.status).toBe(1)
      expect(result.output).toContain(
        `${NAME} now spans 50 lines, within the limit. Remove its entry.`
      )
    })

    it('fails until the entry of a function that no longer exists is removed', () => {
      const result = run(repo({ 'src/a.ts': 'export {}\n' }, { [KEY]: 60 }))

      expect(result.status).toBe(1)
      expect(result.output).toContain(
        `${NAME} is on the baseline but no longer exists. Remove its entry.`
      )
    })

    it('reports the stale entry of a numbered offender that is gone while its namesake stays', () => {
      const baseline = { [KEY]: 60, [fnKey('big', 2)]: 60 }

      const result = run(repo({ 'src/a.ts': declaration('big', 60) }, baseline))

      expect(result.output).toContain(
        `${NAME} #2 is on the baseline but no longer exists. Remove its entry.`
      )
      expect(result.output).not.toContain(`${NAME} spans`)
    })

    it('says a numbered entry is within the limit when its name no longer has two offenders', () => {
      const baseline = { [fnKey('big')]: 60, [fnKey('big', 2)]: 60 }

      const result = run(repo({ 'src/a.ts': declaration('big', 40) }, baseline))

      expect(result.output).toContain(`src/a.ts::big #2 now spans 40 lines, within the limit.`)
    })

    it('calls a numbered entry gone, not within the limit, while its namesake spans 51 lines', () => {
      const baseline = { [KEY]: 60, [fnKey('big', 2)]: 60 }

      const result = run(repo({ 'src/a.ts': declaration('big', 51) }, baseline))

      expect(result.output).toContain(
        `${NAME} #2 is on the baseline but no longer exists. Remove its entry.`
      )
      expect(result.output).not.toContain('within the limit')
    })

    it('names both sides of a rename', () => {
      const result = run(repo({ 'src/a.ts': declaration('renamed', 60) }, { [KEY]: 60 }))

      expect(result.output).toContain(
        'If it was renamed, its old entry `src/a.ts::big` is the stale one below.'
      )
      expect(result.output).toContain('If it was renamed, the new offender is `src/a.ts::renamed`.')
      expect(result.output).toContain('2 function-length problem(s).')
    })

    it('does not link a stale entry in one file to a new offender in another', () => {
      const result = run(
        repo({ 'src/a.ts': 'export {}\n', 'src/b.ts': declaration('other', 60) }, { [KEY]: 60 })
      )

      expect(result.output).not.toContain('If it was renamed')
    })

    it.each([
      ['a count of fifty or less', { [KEY]: 50 }],
      ['a count that is not an integer', { [KEY]: 60.5 }],
      ['a count that is not a number', { [KEY]: 'long' }]
    ])('refuses a baseline entry with %s', (_name, functions) => {
      const result = run(
        repo({ 'src/a.ts': declaration('big', 60) }, functions as Record<string, number>)
      )

      expect(result.status).not.toBe(0)
      expect(result.output).toContain('must record an integer above 50 lines')
    })

    it('refuses a baseline that is not the expected shape', () => {
      const root = repo({ 'src/a.ts': 'export {}\n' })
      writeFileSync(
        join(root, 'scripts', 'function-length-baseline.json'),
        JSON.stringify({ functions: [] })
      )

      const result = run(root)

      expect(result.status).not.toBe(0)
      expect(result.output).toContain('expected { "functions"')
    })
  })

  describe('a function nested in another', () => {
    const nested = (inner: number): string =>
      `export function outer() {\n  const run = () => {\n${statements(inner - 2)}  }\n${statements(5)}}\n`

    it('is measured on its own and inside its container, and says the two entries move together', () => {
      const result = run(repo({ 'src/a.ts': nested(52) }))

      expect(result.output).toContain('src/a.ts::outer > run spans 52 lines')
      expect(result.output).toContain('src/a.ts::outer spans 59 lines')
      expect(result.output).toContain(
        'It is also counted inside `src/a.ts::outer`, so that entry moves with it: this is one change, not two offenders.'
      )
    })

    it('reports growth of the inner function against both baseline entries', () => {
      const baseline = {
        [fnKey('outer')]: 59,
        [keyOf('src/a.ts', [
          ['fn', 'outer'],
          ['fn', 'run']
        ])]: 52
      }

      const result = run(repo({ 'src/a.ts': nested(53) }, baseline))

      expect(result.output).toContain('src/a.ts::outer > run grew from 52 to 53 lines')
      expect(result.output).toContain('src/a.ts::outer grew from 59 to 60 lines')
      expect(result.output).toContain('2 function-length problem(s).')
    })
  })

  describe('against a base revision', () => {
    it('refuses a baseline key that is not a structured key, naming it', () => {
      const result = run(repo({ 'src/a.ts': declaration('big', 60) }, { 'src/a.ts::big': 60 }))

      expect(result.status).not.toBe(0)
      expect(result.output).toContain('src/a.ts::big is not a function key')
    })

    it('refuses an option that has no value instead of skipping the base comparison', () => {
      const root = repo({ 'src/a.ts': declaration('big', 60) }, { [fnKey('big')]: 60 })
      commitBase(root)

      for (const option of ['--base', '--baseline']) {
        const result = run(root, option)

        expect(result.status).toBe(2)
        expect(result.output).toContain(`${option} needs a value.`)
      }
    })

    describe('whose baseline predates structured keys', () => {
      /** A repository whose base commit holds `files` and a baseline in the earlier string format. */
      function legacyBase(files: Record<string, string>, legacy: Record<string, number>): string {
        const root = repo(files, legacy)
        commitBase(root)
        return root
      }

      it('reads the base from its sources, so an unchanged entry passes', () => {
        const root = legacyBase({ 'src/a.ts': declaration('big', 60) }, { 'src/a.ts::big': 60 })
        writeBaseline(root, { [fnKey('big')]: 60 })

        expect(run(root, '--base', 'HEAD').status).toBe(0)
      })

      it('still refuses an entry raised above the base and one the base did not have', () => {
        const root = legacyBase({ 'src/a.ts': declaration('big', 60) }, { 'src/a.ts::big': 60 })
        writeFileSync(join(root, 'src/a.ts'), declaration('big', 70) + declaration('other', 60))
        writeBaseline(root, { [fnKey('big')]: 70, [fnKey('other')]: 60 })

        const result = run(root, '--base', 'HEAD')

        expect(result.output).toContain(
          'src/a.ts::big is recorded at 70 lines, above 60 on the base revision'
        )
        expect(result.output).toContain(
          'src/a.ts::other is on the baseline but the base revision does not have it'
        )
      })

      it('does not take a file added since the base for part of the base', () => {
        const root = legacyBase({ 'src/a.ts': declaration('big', 60) }, { 'src/a.ts::big': 60 })
        writeFileSync(join(root, 'src/b.ts'), declaration('added', 60))
        spawnSync('git', ['add', '-A'], { cwd: root })
        writeBaseline(root, {
          [fnKey('big')]: 60,
          [keyOf('src/b.ts', [['fn', 'added']])]: 60
        })

        const result = run(root, '--base', 'HEAD')

        expect(result.output).toContain(
          'src/b.ts::added is on the baseline but the base revision does not have it'
        )
      })

      it('does not admit a new test whose title spells the ordinal of an old one', () => {
        const test = (title: string): string => `it('${title}', () => {\n${statements(60)}})\n`
        const root = legacyBase(
          { 'src/a.spec.ts': test('x') + test('x') },
          { 'src/a.spec.ts::it x': 62, 'src/a.spec.ts::it x #2': 62 }
        )
        writeFileSync(join(root, 'src/a.spec.ts'), test('x') + test('x') + test('x #2'))
        run(root, '--write-baseline')

        const result = run(root, '--base', 'HEAD')

        expect(result.status).toBe(1)
        expect(result.output).toContain('the base revision does not have it')
      })

      it('keeps passing a title the earlier format escaped', () => {
        const root = legacyBase(
          { 'src/a.spec.ts': `it('foo#bar', () => {\n${statements(60)}})\n` },
          { 'src/a.spec.ts::it foo\\#bar': 62 }
        )
        run(root, '--write-baseline')

        expect(run(root, '--base', 'HEAD').status).toBe(0)
      })
    })

    it('refuses a baseline entry the base did not have', () => {
      const root = repo({ 'src/a.ts': declaration('big', 60) })
      commitBase(root)
      writeBaseline(root, { [fnKey('big')]: 60 })

      const result = run(root, '--base', 'HEAD')

      expect(result.status).toBe(1)
      expect(result.output).toContain('the base revision does not have it')
    })

    it('refuses a baseline entry raised above the base', () => {
      const root = repo({ 'src/a.ts': declaration('big', 70) }, { [fnKey('big')]: 60 })
      commitBase(root)
      writeBaseline(root, { [fnKey('big')]: 70 })

      const result = run(root, '--base', 'HEAD')

      expect(result.output).toContain(
        'src/a.ts::big is recorded at 70 lines, above 60 on the base revision'
      )
    })

    it('accepts an entry kept or lowered, imposes nothing when the base has no baseline, and fails on an unknown revision', () => {
      const root = repo({ 'src/a.ts': declaration('big', 60) }, { [fnKey('big')]: 60 })
      commitBase(root)

      expect(run(root, '--base', 'HEAD').status).toBe(0)
      expect(run(root, '--base', 'no-such-ref').status).not.toBe(0)

      writeFileSync(join(root, 'src', 'a.ts'), declaration('big', 55))
      writeBaseline(root, { [fnKey('big')]: 55 })

      expect(run(root, '--base', 'HEAD').status).toBe(0)

      const bare = mkdtempSync(join(tmpdir(), 'function-length-spec-'))
      roots.push(bare)
      spawnSync('git', ['init', '-q'], { cwd: bare })
      mkdirSync(join(bare, 'src'), { recursive: true })
      writeFileSync(join(bare, 'src', 'a.ts'), 'export {}\n')
      spawnSync('git', ['add', '-A'], { cwd: bare })
      commitBase(bare)
      mkdirSync(join(bare, 'scripts'), { recursive: true })
      writeBaseline(bare, {})

      expect(run(bare, '--base', 'HEAD').status).toBe(0)
    })
  })

  describe('--write-baseline', () => {
    it('writes every offender and nothing else, sorted, and the result passes the check', () => {
      const root = repo({
        'src/b.ts': declaration('second', 70),
        'src/a.ts':
          declaration('first', 60) +
          declaration('fine', 40) +
          declaration('atTheLimit', 50) +
          declaration('justOver', 51)
      })

      const written = run(root, '--write-baseline')
      const text = readFileSync(join(root, 'scripts', 'function-length-baseline.json'), 'utf8')

      expect(written.status).toBe(0)
      expect(written.output).toContain('Wrote 3 baseline entries')
      expect(JSON.parse(text)).toEqual({
        functions: {
          [fnKey('first')]: 60,
          [fnKey('justOver')]: 51,
          [keyOf('src/b.ts', [['fn', 'second']])]: 70
        }
      })
      expect(Object.keys((JSON.parse(text) as { functions: object }).functions)).toEqual([
        fnKey('first'),
        fnKey('justOver'),
        keyOf('src/b.ts', [['fn', 'second']])
      ])
      expect(text.endsWith('}\n')).toBe(true)
      expect(run(root).status).toBe(0)
    })

    it('round-trips: writing again over a passing baseline leaves the file byte for byte the same', () => {
      const root = repo({ 'src/a.ts': declaration('first', 60) })
      run(root, '--write-baseline')
      const first = readFileSync(join(root, 'scripts', 'function-length-baseline.json'), 'utf8')

      run(root, '--write-baseline')
      const second = readFileSync(join(root, 'scripts', 'function-length-baseline.json'), 'utf8')

      expect(second).toBe(first)
    })

    it('writes an empty table for a repository with no offender', () => {
      const root = repo({ 'src/a.ts': declaration('fine', 10) })

      run(root, '--write-baseline')

      expect(
        JSON.parse(readFileSync(join(root, 'scripts', 'function-length-baseline.json'), 'utf8'))
      ).toEqual({
        functions: {}
      })
    })
  })

  describe('the committed baseline', () => {
    it('is the one the script would generate for this repository, so it is never edited by hand', () => {
      const repoRoot = resolve(__dirname, '..')
      const committed = readFileSync(
        join(repoRoot, 'scripts', 'function-length-baseline.json'),
        'utf8'
      )
      const scratch = join(tmpdir(), `function-length-regenerated-${String(process.pid)}.json`)
      roots.push(scratch)

      const result = spawnSync(
        process.execPath,
        [SCRIPT, '--root', repoRoot, '--baseline', scratch, '--write-baseline'],
        { encoding: 'utf8' }
      )

      expect(result.status).toBe(0)
      expect(readFileSync(scratch, 'utf8')).toBe(committed)
    })
  })
})
