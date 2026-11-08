/**
 * Pins `scripts/mutate-const-tables.mjs`, the development tool that mutates `as const` tables one
 * entry at a time. It is plain Node, so each case runs it as a child process against a throwaway
 * git repository whose test command is a small checker script, and asserts the exit code, what
 * is printed, the exact text of each mutant, and that the mutated file is restored.
 *
 * Layer: repository tooling, tests.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(__dirname, '..', 'scripts', 'mutate-const-tables.mjs')
const REPOSITORY_MODULES = resolve(__dirname, '..', 'node_modules')

interface Result {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const roots: string[] = []

/**
 * Lays out a git repository holding `files` (path to text), with the repository's own
 * `node_modules` linked in so the script finds `typescript`, and a checker that appends the text
 * of the file it is given to a log and exits 1 unless that text includes every `required` snippet.
 */
function repo(files: Record<string, string>, required: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mutate-const-spec-'))
  roots.push(root)
  spawnSync('git', ['init', '-q'], { cwd: root })
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  writeFileSync(join(root, 'package.json'), '{}\n')
  writeFileSync(
    join(root, 'checker.mjs'),
    [
      "import { appendFileSync, readFileSync } from 'node:fs'",
      'const file = process.argv[2]',
      "const text = readFileSync(file, 'utf8')",
      "appendFileSync('log.jsonl', JSON.stringify(text) + '\\n')",
      `const required = ${JSON.stringify(required)}`,
      'process.exit(required.every((snippet) => text.includes(snippet)) ? 0 : 1)'
    ].join('\n')
  )
  symlinkSync(REPOSITORY_MODULES, join(root, 'node_modules'))
  spawnSync('git', ['add', 'package.json', 'checker.mjs', ...Object.keys(files)], { cwd: root })
  return root
}

/** Runs the script against `root`, with the checker as the test command unless `args` say otherwise. */
function run(
  root: string,
  args: readonly string[] = ['--', 'node', 'checker.mjs', '{file}']
): Result {
  const result = spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * The texts the checker saw, one per run: for each file with a table its unmutated baseline first,
 * then each mutant. Nothing was run when no file holds a table.
 */
function seen(root: string): string[] {
  const log = join(root, 'log.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string)
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const TABLE = 'export const T = { a: 1, b: 2 } as const\n'

describe('mutate-const-tables', () => {
  // A checker that pins every entry by exact text kills the removal and the bump of each one.
  it('should kill every mutant of a table the command pins in full', () => {
    const root = repo({ 'src/table.ts': TABLE }, ['a: 1', 'b: 2'])

    const result = run(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Every mutant of every `as const` table was killed.')
  })

  // The mutants are the contract of the tool, so their exact text is pinned: a removal cuts the
  // entry and one comma, a bump adds one to the number, and the order is entry by entry.
  it('should remove each entry and bump each number, in order', () => {
    const root = repo({ 'src/table.ts': TABLE }, ['a: 1', 'b: 2'])

    run(root)

    expect(seen(root)).toEqual([
      TABLE,
      'export const T = { b: 2 } as const\n',
      'export const T = { a: 2, b: 2 } as const\n',
      'export const T = { a: 1 } as const\n',
      'export const T = { a: 1, b: 3 } as const\n'
    ])
  })

  // An entry no test pins is the point of the tool: it must be named, and the exit code must say
  // so, while a pinned entry must not be listed.
  it('should list the survivors and exit 1 when an entry is not pinned', () => {
    const root = repo({ 'src/table.ts': TABLE }, ['a: 1'])

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('2 mutant(s) survived')
    expect(result.stdout).toContain('remove  src/table.ts:1 b: 2')
    expect(result.stdout).toContain('bump  src/table.ts:1 b: 2')
    expect(result.stdout).not.toContain('a: 1')
  })

  // The tool edits tracked source, so the file must come back exactly, survivors or not.
  it('should restore the mutated file', () => {
    const root = repo({ 'src/table.ts': TABLE }, ['a: 1'])

    run(root)

    expect(readFileSync(join(root, 'src/table.ts'), 'utf8')).toBe(TABLE)
  })

  // Arrays, a trailing `satisfies`, multi-line entries with a trailing comma, and a number with
  // separators are all tables in this codebase.
  it('should mutate arrays, satisfies, multi-line entries and numeric separators', () => {
    const source = [
      "export const L = ['x', 'y'] as const satisfies readonly string[]",
      'export const M = {',
      '  big: 1_000,',
      '  nested: {',
      "    deep: 'v'",
      '  },',
      '} as const',
      ''
    ].join('\n')
    const root = repo({ 'src/table.ts': source }, [])

    run(root)

    const texts = seen(root).slice(1)
    expect(texts).toContain(source.replace("['x', 'y']", "[ 'y']"))
    expect(texts).toContain(source.replace("['x', 'y']", "['x']"))
    expect(texts).toContain(source.replace('1_000', '1001'))
    expect(texts).toContain(source.replace('  big: 1_000,\n', ''))
    expect(texts).toContain(source.replace(",\n  nested: {\n    deep: 'v'\n  },\n", '\n'))
  })

  // Only an `as const` literal is a table; a plain object, a nested literal inside a table, and
  // a number that is not a plain literal are not separate or extra mutants.
  it('should ignore an object that is not asserted as const', () => {
    const root = repo({ 'src/table.ts': 'export const U = { z: 1 }\n' }, [])

    const result = run(root)

    expect(seen(root)).toHaveLength(0)
    expect(result.status).toBe(0)
  })

  // Specs, tests, declaration files and barrels never hold a table worth mutating.
  it.each(['src/a.spec.ts', 'src/a.test.ts', 'src/a.d.ts', 'src/index.ts'])(
    'should skip %s',
    (path) => {
      const root = repo({ [path]: TABLE, 'src/table.ts': 'export const none = 1\n' }, [])

      run(root)

      expect(seen(root)).toHaveLength(0)
    }
  )

  // `--only` narrows the run to the files whose path contains the text.
  it('should mutate only the files matching --only', () => {
    const root = repo({ 'src/one.ts': TABLE, 'src/two.ts': TABLE.replace('T', 'U') }, [])

    run(root, ['--only', 'two', '--', 'node', 'checker.mjs', 'src/two.ts'])

    expect(seen(root)).toHaveLength(5)
  })

  // `--src` selects the directory; files outside it are left alone.
  it('should mutate only the files under --src', () => {
    const root = repo({ 'lib/one.ts': TABLE, 'src/two.ts': TABLE }, [])

    run(root, ['--src', 'lib', '--', 'node', 'checker.mjs', 'lib/one.ts'])

    expect(seen(root)).toHaveLength(5)
  })

  // The command receives the mutated file's path both in `{file}` and in MUTATED_FILE.
  it('should hand the mutated file to the command', () => {
    const root = repo({ 'src/table.ts': TABLE }, [])
    writeFileSync(
      join(root, 'env.mjs'),
      "import { appendFileSync } from 'node:fs'\nappendFileSync('env.log', `${process.argv[2]}|${process.env.MUTATED_FILE}\\n`)\n"
    )

    run(root, ['--', 'node', 'env.mjs', '{file}'])

    const lines = readFileSync(join(root, 'env.log'), 'utf8').split('\n').filter(Boolean)
    expect(lines).toEqual(Array<string>(5).fill('src/table.ts|src/table.ts'))
  })

  // With no command the tool cannot run anything; it must say how to call it.
  it('should print the usage and exit 2 without a command', () => {
    const root = repo({ 'src/table.ts': TABLE }, [])

    const result = run(root, [])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage: node scripts/mutate-const-tables.mjs')
  })

  // A command that already fails would kill every mutant and report a clean run.
  it('should refuse a command that fails on the unmutated file', () => {
    const root = repo({ 'src/table.ts': TABLE }, ['never present'])

    const result = run(root)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('fails on the unmutated file src/table.ts')
    expect(seen(root)).toHaveLength(1)
  })

  // The baseline is the command's verdict on each file, run with that file's path: a command that
  // passes on one file and fails on another stops at the second and names it, after the first has
  // been mutated and restored.
  it('should name the file the command fails on when it passes on another', () => {
    const root = repo({ 'src/a.ts': TABLE, 'src/b.ts': 'export const U = { c: 3 } as const\n' }, [
      'a: 1',
      'b: 2'
    ])

    const result = run(root)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('fails on the unmutated file src/b.ts')
    expect(seen(root)).toHaveLength(6)
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe(TABLE)
  })

  // A file with no table has no mutant to judge, so the command is not run on it: a command that
  // would fail on that file cannot stop the run.
  it('should not run the command on a file without a table', () => {
    const root = repo({ 'src/a.ts': TABLE, 'src/b.ts': 'export const none = 1\n' }, [
      'a: 1',
      'b: 2'
    ])

    const result = run(root)

    expect(result.status).toBe(0)
    expect(seen(root)).toHaveLength(5)
  })
  // An inner object is part of the table it sits in, so its entries are mutated too.
  it('should mutate the entries of a literal nested inside a table', () => {
    const source = 'export const T = { outer: { inner: 1, other: 2 }, list: [3] } as const\n'
    const root = repo({ 'src/table.ts': source }, [])

    run(root)

    const texts = seen(root).slice(1)
    expect(texts).toContain(source.replace('{ inner: 1, other: 2 }', '{ other: 2 }'))
    expect(texts).toContain(source.replace('{ inner: 1, other: 2 }', '{ inner: 1 }'))
    expect(texts).toContain(source.replace('inner: 1', 'inner: 2'))
    expect(texts).toContain(source.replace('[3]', '[]'))
    expect(texts).toContain(source.replace('[3]', '[4]'))
  })

  // A comment between an entry and its comma must go with the entry, or the mutant would not
  // parse and a failing parse would be counted as a kill.
  it('should remove an entry together with a comment before its comma', () => {
    const source = 'export const T = { a: 1 /* note */, b: 2 } as const\n'
    const root = repo({ 'src/table.ts': source }, [])

    run(root)

    expect(seen(root)).toContain('export const T = { b: 2 } as const\n')
  })

  // Only a plain decimal integer is bumped: adding one to a float, a hex, an exponent or a value
  // past 2^53 would change nothing, or something other than adding one. Those are only removed.
  it('should bump a plain integer and only remove other forms of number', () => {
    const source = 'export const T = { f: 1.5, h: 0x10, e: 1e3, big: 9007199254740992 } as const\n'
    const root = repo({ 'src/table.ts': source }, [])

    run(root)

    expect(seen(root).slice(1)).toHaveLength(4)
  })

  // A tracked file that was deleted from the working tree has nothing to mutate.
  it('should skip a tracked file that no longer exists', () => {
    const root = repo({ 'src/table.ts': TABLE, 'src/gone.ts': TABLE.replace('T', 'G') }, [
      'a: 1',
      'b: 2'
    ])
    rmSync(join(root, 'src/gone.ts'))

    const result = run(root)

    expect(result.status).toBe(0)
    expect(seen(root)).toHaveLength(5)
  })

  // An interrupt must leave the source as it was: the mutant that was written is taken back, and
  // the run ends with the usage-error code rather than reporting survivors it never finished.
  it('should restore the file and exit 2 when interrupted mid-run', async () => {
    const root = repo({ 'src/table.ts': TABLE }, [])
    writeFileSync(
      join(root, 'hang.mjs'),
      [
        "import { readFileSync } from 'node:fs'",
        "if (readFileSync('src/table.ts', 'utf8').includes('a: 1, b: 2')) process.exit(0)",
        'setTimeout(() => undefined, 60_000)'
      ].join('\n')
    )
    const child = spawn('node', [SCRIPT, '--root', root, '--', 'node', 'hang.mjs'], {
      stdio: 'ignore'
    })
    const closed = new Promise<number | null>((done) => child.once('close', done))
    const deadline = Date.now() + 20_000
    while (readFileSync(join(root, 'src/table.ts'), 'utf8') === TABLE && Date.now() < deadline) {
      await new Promise((wait) => setTimeout(wait, 50))
    }

    child.kill('SIGTERM')

    expect(await closed).toBe(2)
    expect(readFileSync(join(root, 'src/table.ts'), 'utf8')).toBe(TABLE)
  })
  // A comment or a line break between `as` and `const` is still `as const`. A search of the text
  // for the exact spelling would skip such a file and the run would report every mutant killed;
  // a command that pins nothing must show both entries as survivors.
  it.each([
    ['a comment', 'export const T = { a: 1 } as /* keep */ const\n'],
    ['a line break', 'export const T = { a: 1 } as\nconst\n']
  ])('should find a table with %s between as and const', (_label, source) => {
    const root = repo({ 'src/table.ts': source }, [])

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('2 mutant(s) survived')
    expect(seen(root)).toHaveLength(3)
  })
})
