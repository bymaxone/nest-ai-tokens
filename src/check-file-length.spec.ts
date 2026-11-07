/**
 * Pins `scripts/check-file-length.mjs`, the gate for the 800-line rule. It is plain Node, so each
 * case runs it the way CI does, as a child process against a throwaway git repository, and asserts
 * the exit code and the printed problems.
 *
 * Layer: repository tooling, tests.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(__dirname, '..', 'scripts', 'check-file-length.mjs')

interface Result {
  readonly status: number | null
  readonly output: string
}

const roots: string[] = []

/** A text of `lines` lines, each ending in a line feed. */
const lines = (count: number): string => 'x\n'.repeat(count)

/** Lays out a git repository holding `files` (path to text), all added to the index. */
function repo(files: Record<string, string>, baseline: unknown = { files: {} }): string {
  const root = mkdtempSync(join(tmpdir(), 'file-length-spec-'))
  roots.push(root)
  spawnSync('git', ['init', '-q'], { cwd: root })
  const all: Record<string, string> = { ...files }
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'file-length-baseline.json'), JSON.stringify(baseline))
  spawnSync('git', ['add', '-A'], { cwd: root })
  return root
}

/** Runs the script in `root` and returns its exit status and combined output. */
function run(root: string, ...args: string[]): Result {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** Commits the index as the base revision of `root`, so `--base HEAD` can read the baseline from it. */
function commitBase(root: string): void {
  spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base'],
    { cwd: root },
  )
}

/** Rewrites the working-tree baseline of `root` without committing it. */
function setBaseline(root: string, baseline: unknown): void {
  writeFileSync(join(root, 'scripts', 'file-length-baseline.json'), JSON.stringify(baseline))
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('check-file-length', () => {
  it('passes when every source file is within the limit, 800 lines included', () => {
    // 800 is allowed; the limit is exclusive of the line it names.
    const result = run(repo({ 'src/a.ts': lines(800), 'src/b.ts': lines(3) }))

    expect(result.status).toBe(0)
    expect(result.output).toContain('within 800 lines')
  })

  it('fails a source file of 801 lines that is not on the baseline', () => {
    const result = run(repo({ 'src/big.ts': lines(801) }))

    expect(result.status).toBe(1)
    expect(result.output).toContain('src/big.ts has 801 lines, over the limit of 800')
  })

  it('counts a last line that has no line feed', () => {
    // 800 feeds plus an unterminated line is 801 lines.
    const result = run(repo({ 'src/big.ts': `${lines(800)}last` }))

    expect(result.status).toBe(1)
    expect(result.output).toContain('src/big.ts has 801 lines')
  })

  it.each(['src/a.ts', 'src/a.tsx', 'scripts/a.mjs', 'scripts/a.cjs', 'test/a.js', 'src/a.mts'])(
    'checks %s',
    (path) => {
      expect(run(repo({ [path]: lines(900) })).status).toBe(1)
    },
  )

  it.each(['README.md', 'pnpm-lock.yaml', 'package.json', 'data.txt'])('ignores %s', (path) => {
    // Markdown, lockfiles and data have no layers to split.
    expect(run(repo({ [path]: lines(2000) })).status).toBe(0)
  })

  it('ignores an untracked file', () => {
    const root = repo({ 'src/a.ts': lines(3) })
    writeFileSync(join(root, 'src', 'untracked.ts'), lines(2000))

    expect(run(root).status).toBe(0)
  })

  it('passes a baselined file that is exactly at its recorded length', () => {
    const root = repo({ 'src/big.ts': lines(950) }, { files: { 'src/big.ts': 950 } })

    expect(run(root).status).toBe(0)
  })

  it('fails a baselined file that grew past its recorded length', () => {
    const root = repo({ 'src/big.ts': lines(951) }, { files: { 'src/big.ts': 950 } })

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.output).toContain('src/big.ts grew from 950 to 951 lines')
  })

  it('fails a baselined file that shrank but is still over, until the entry is lowered', () => {
    const root = repo({ 'src/big.ts': lines(900) }, { files: { 'src/big.ts': 950 } })

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.output).toContain('Lower its baseline entry from 950 to 900')
  })

  it('fails a baselined file that is now within the limit', () => {
    const root = repo({ 'src/big.ts': lines(800) }, { files: { 'src/big.ts': 950 } })

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.output).toContain(
      'src/big.ts is on the baseline but is no longer over 800 lines or tracked',
    )
  })

  it('fails a baselined file that is no longer tracked', () => {
    const root = repo({ 'src/a.ts': lines(3) }, { files: { 'src/gone.ts': 950 } })

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.output).toContain('src/gone.ts is on the baseline')
  })

  it('reports every problem, not only the first', () => {
    const root = repo(
      { 'src/new.ts': lines(900), 'src/old.ts': lines(960) },
      { files: { 'src/old.ts': 950, 'src/gone.ts': 900 } },
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.output).toContain('src/new.ts has 900 lines')
    expect(result.output).toContain('src/old.ts grew')
    expect(result.output).toContain('src/gone.ts is on the baseline')
    expect(result.output).toContain('3 file-length problem(s)')
  })

  it.each([
    ['a missing files table', {}],
    ['a files array', { files: [] }],
    ['a recorded length at or under the limit', { files: { 'src/a.ts': 800 } }],
    ['a non-integer length', { files: { 'src/a.ts': 'long' } }],
  ])('rejects a baseline with %s', (_label, baseline) => {
    const result = run(repo({ 'src/a.ts': lines(3) }, baseline))

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('file-length-baseline.json')
  })

  it('reads the baseline named by --baseline', () => {
    const root = repo({ 'src/big.ts': lines(900) })
    const other = join(root, 'elsewhere.json')
    writeFileSync(other, JSON.stringify({ files: { 'src/big.ts': 900 } }))

    expect(run(root, '--baseline', other).status).toBe(0)
  })

  describe('against a base revision', () => {
    // The baseline in a pull request is the pull request's own file, so on its own it can be edited to
    // admit a new offender; the base revision's baseline is the one that cannot be argued with.
    const big = (count: number): Record<string, string> => ({ 'src/big.ts': lines(count) })

    it('passes when the baseline is unchanged from the base', () => {
      const root = repo(big(950), { files: { 'src/big.ts': 950 } })
      commitBase(root)

      expect(run(root, '--base', 'HEAD').status).toBe(0)
    })

    it('fails an entry the base did not have', () => {
      const root = repo({ 'src/a.ts': lines(3) })
      commitBase(root)
      writeFileSync(join(root, 'src', 'new.ts'), lines(900))
      setBaseline(root, { files: { 'src/new.ts': 900 } })
      spawnSync('git', ['add', '-A'], { cwd: root })

      const result = run(root, '--base', 'HEAD')

      expect(result.status).toBe(1)
      expect(result.output).toContain(
        'src/new.ts is on the baseline but the base revision does not have it',
      )
    })

    it('fails an entry raised above the base', () => {
      const root = repo(big(950), { files: { 'src/big.ts': 950 } })
      commitBase(root)
      writeFileSync(join(root, 'src', 'big.ts'), lines(1000))
      setBaseline(root, { files: { 'src/big.ts': 1000 } })
      spawnSync('git', ['add', '-A'], { cwd: root })

      const result = run(root, '--base', 'HEAD')

      expect(result.status).toBe(1)
      expect(result.output).toContain(
        'src/big.ts is recorded at 1000 lines, above 950 on the base revision',
      )
    })

    it('passes an entry lowered below the base', () => {
      const root = repo(big(950), { files: { 'src/big.ts': 950 } })
      commitBase(root)
      writeFileSync(join(root, 'src', 'big.ts'), lines(900))
      setBaseline(root, { files: { 'src/big.ts': 900 } })

      expect(run(root, '--base', 'HEAD').status).toBe(0)
    })

    it('passes an entry removed because the file is now within the limit', () => {
      const root = repo(big(950), { files: { 'src/big.ts': 950 } })
      commitBase(root)
      writeFileSync(join(root, 'src', 'big.ts'), lines(10))
      setBaseline(root, { files: {} })

      expect(run(root, '--base', 'HEAD').status).toBe(0)
    })

    it('accepts any baseline when the base revision has none yet', () => {
      // The pull request that introduces the baseline has nothing to compare with.
      const root = mkdtempSync(join(tmpdir(), 'file-length-spec-'))
      roots.push(root)
      spawnSync('git', ['init', '-q'], { cwd: root })
      writeFileSync(join(root, 'a.ts'), lines(3))
      spawnSync('git', ['add', '-A'], { cwd: root })
      commitBase(root)
      mkdirSync(join(root, 'scripts'))
      setBaseline(root, { files: { 'src/old.ts': 900 } })
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'old.ts'), lines(900))
      spawnSync('git', ['add', '-A'], { cwd: root })

      expect(run(root, '--base', 'HEAD').status).toBe(0)
    })

    it('fails when the base revision does not exist', () => {
      const root = repo({ 'src/a.ts': lines(3) })
      commitBase(root)

      const result = run(root, '--base', 'no-such-ref')

      expect(result.status).not.toBe(0)
      expect(result.output).toContain('no-such-ref')
    })

    it('does not compare with any base when none is given', () => {
      const root = repo(big(950), { files: { 'src/big.ts': 950 } })
      commitBase(root)
      writeFileSync(join(root, 'src', 'big.ts'), lines(1000))
      setBaseline(root, { files: { 'src/big.ts': 1000 } })
      spawnSync('git', ['add', '-A'], { cwd: root })

      expect(run(root).status).toBe(0)
    })
  })
})
