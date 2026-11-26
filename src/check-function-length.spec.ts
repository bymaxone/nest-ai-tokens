/**
 * @fileoverview Pins `scripts/check-function-length.mjs`, the gate for the 50-line limit on a function or a test
 * body: what it measures, and how test bodies, hooks and containers are told apart. It is plain
 * Node, so each case runs it the way CI does, as a child process against a throwaway git
 * repository, and asserts the exit code and the printed problems.
 *
 * @layer tests
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The first character of a template-literal placeholder, kept out of the source's own templates. */
const DOLLAR = '$'

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

/** `lines` lines of statements, for the inside of a body. */
function statements(lines: number): string {
  return '  work()\n'.repeat(lines)
}

/** A function declaration named `name` spanning exactly `lines` lines, signature and brace included. */
function declaration(name: string, lines: number): string {
  return `function ${name}() {\n${statements(lines - 2)}}\n`
}

/** A call `head(...)` whose callback spans exactly `lines` lines. */
function callback(head: string, lines: number): string {
  return `${head}(() => {\n${statements(lines - 2)}})\n`
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
  describe('what it measures', () => {
    it('passes a function of exactly 50 lines and fails one of 51, naming the line count', () => {
      expect(run(repo({ 'src/a.ts': declaration('fits', 50) })).status).toBe(0)

      const result = run(repo({ 'src/a.ts': declaration('tooLong', 51) }))

      expect(result.status).toBe(1)
      expect(result.output).toContain('src/a.ts::tooLong spans 51 lines, over the 50-line limit')
    })

    it('measures from the signature to the closing brace, not from the comment above it', () => {
      const comment = `/**\n${' * about it\n'.repeat(40)} */\n`

      expect(run(repo({ 'src/a.ts': `${comment}\n\n${declaration('f', 50)}` })).status).toBe(0)
    })

    it.each([
      ['a function declaration', declaration('named', 51), 'src/a.ts::named'],
      ['a method', `class Box {\n  open() {\n${statements(49)}  }\n}\n`, 'src/a.ts::Box.open'],
      [
        'a constructor',
        `class Box {\n  constructor() {\n${statements(49)}  }\n}\n`,
        'src/a.ts::Box.constructor'
      ],
      [
        'a getter',
        `class Box {\n  get size() {\n${statements(48)}    return 1\n  }\n}\n`,
        'src/a.ts::Box.size'
      ],
      [
        'a setter',
        `class Box {\n  set size(v: number) {\n${statements(49)}  }\n}\n`,
        'src/a.ts::Box.size'
      ],
      [
        'an arrow assigned to a constant',
        `const make = () => {\n${statements(49)}}\n`,
        'src/a.ts::make'
      ],
      [
        'a function expression assigned to a property',
        `const table = {\n  run: function () {\n${statements(49)}  }\n}\n`,
        'src/a.ts::run'
      ],
      [
        'an anonymous callback',
        `export default [1].map(() => {\n${statements(49)}})\n`,
        'src/a.ts::<anonymous>'
      ]
    ])('measures %s', (_name, text, key) => {
      const result = run(repo({ 'src/a.ts': text }))

      expect(result.status).toBe(1)
      expect(result.output).toContain(`${key} spans 51 lines`)
    })

    it('reads a tsx file and a file under test', () => {
      const tsx = `export const View = () => {\n${statements(49)}  return <div />\n}\n`

      expect(run(repo({ 'src/View.tsx': tsx })).output).toContain(
        'src/View.tsx::View spans 52 lines'
      )
      expect(run(repo({ 'test/b.ts': declaration('helper', 51) })).output).toContain(
        'test/b.ts::helper'
      )
    })

    it('leaves out what is not hand-written source in scope', () => {
      const files = {
        'scripts/tool.ts': declaration('inScripts', 80),
        'src/server/openapi/generated/schemas.ts': declaration('generated', 80),
        'src/a.js': declaration('plainJs', 80),
        'src/a.d.mts': declaration('other', 80)
      }

      expect(run(repo(files)).status).toBe(0)
    })
  })

  describe('test bodies and containers', () => {
    it.each([
      ['it', `it('does it', () => {\n${statements(49)}})\n`, 'it does it'],
      ['test', `test('does it', () => {\n${statements(49)}})\n`, 'test does it'],
      ['it.only', `it.only('does it', () => {\n${statements(49)}})\n`, 'it does it'],
      ['it.skip', `it.skip('does it', () => {\n${statements(49)}})\n`, 'it does it'],
      ['it.each', `it.each([1, 2])('does %s', () => {\n${statements(49)}})\n`, 'it does %s'],
      ['it.concurrent', `it.concurrent('does it', () => {\n${statements(49)}})\n`, 'it does it'],
      ['xit', `xit('does it', () => {\n${statements(49)}})\n`, 'xit does it'],
      ['fit', `fit('does it', () => {\n${statements(49)}})\n`, 'fit does it'],
      ['xtest', `xtest('does it', () => {\n${statements(49)}})\n`, 'xtest does it'],
      [
        'an it.each template table',
        `it.each\`\n  a | b\n  ${DOLLAR}{1} | ${DOLLAR}{2}\n\`('does it', () => {\n${statements(49)}})\n`,
        'it does it'
      ],
      ['a test with a dynamic title', `it(title, () => {\n${statements(49)}})\n`, 'it <dynamic>']
    ])('measures the body of %s', (_name, text, name) => {
      const spec = `describe('Suite', () => {\n${text}})\n`
      const result = run(repo({ 'src/a.spec.ts': spec }))

      expect(result.status).toBe(1)
      expect(result.output).toContain(`src/a.spec.ts::describe Suite > ${name}`)
    })

    it('keeps a describe callback and a describe.each callback out of the count', () => {
      const small = Array.from(
        { length: 30 },
        (_, i) => `it('t${String(i)}', () => {\n  work()\n})\n`
      ).join('')
      const spec = [
        `describe('Suite', () => {\n${small}})\n`,
        `describe.each([1])('each %s', () => {\n${statements(60)}})\n`,
        `context('ctx', () => {\n${statements(60)}})\n`,
        `suite('suite', () => {\n${statements(60)}})\n`,
        `describe.each\`\n  a | b\n  ${DOLLAR}{1} | ${DOLLAR}{2}\n\`('table', () => {\n${statements(60)}})\n`,
        `xdescribe('skipped', () => {\n${statements(60)}})\n`,
        `fdescribe('focused', () => {\n${statements(60)}})\n`,
        `describe.only('only', () => {\n${statements(60)}})\n`,
        `describe.skip('skip', () => {\n${statements(60)}})\n`
      ].join('')

      expect(run(repo({ 'src/a.spec.ts': spec })).status).toBe(0)
    })

    // Hooks are functions: a setup or teardown body is measured like an `it` body, with the same limit and the
    // same baseline.
    describe.each(['beforeEach', 'afterEach', 'beforeAll', 'afterAll'])('the %s hook', (hook) => {
      it('fails over the limit, named as a hook', () => {
        const spec = `describe('Suite', () => {\n${callback(hook, 61)}})\n`
        const result = run(repo({ 'src/a.spec.ts': spec }))

        expect(result.status).toBe(1)
        expect(result.output).toContain(`src/a.spec.ts::describe Suite > hook ${hook}`)
      })

      it('passes at the limit', () => {
        const spec = `describe('Suite', () => {\n${callback(hook, 50)}})\n`

        expect(run(repo({ 'src/a.spec.ts': spec })).status).toBe(0)
      })
    })

    it('keeps two hooks of one name in one describe apart, and holds a baselined hook to the baseline', () => {
      const spec = `describe('Suite', () => {\n${callback('beforeEach', 55)}${callback('beforeEach', 56)}})\n`
      const root = repo({ 'src/a.spec.ts': spec })

      expect(run(root).status).toBe(1)
      expect(run(root, '--write-baseline').status).toBe(0)
      const baseline = JSON.parse(
        readFileSync(join(root, 'scripts', 'function-length-baseline.json'), 'utf8')
      ) as { functions: Record<string, number> }
      expect(Object.values(baseline.functions).sort()).toEqual([55, 56])
      expect(run(root).status).toBe(0)

      writeFileSync(
        join(root, 'src', 'a.spec.ts'),
        `describe('Suite', () => {\n${callback('beforeEach', 55)}${callback('beforeEach', 57)}})\n`
      )
      expect(run(root).status).toBe(1)
    })

    it('keeps a tracked path that spells the delimiter apart from a title that does', () => {
      const test = `it('foo.ts::g', () => {\n${statements(49)}})\n`
      const root = repo({
        'src/a.spec.ts': test,
        'src/a.spec.ts::it foo.ts': declaration('g', 51)
      })

      run(root, '--write-baseline')
      const baseline = JSON.parse(
        readFileSync(join(root, 'scripts', 'function-length-baseline.json'), 'utf8')
      ) as { functions: Record<string, number> }

      expect(Object.keys(baseline.functions)).toHaveLength(2)
      expect(run(root).status).toBe(0)
    })

    it('does not let a suite title spell the path of nested suites', () => {
      const test = (lines: number): string => `it('case', () => {\n${statements(lines)}})\n`
      const nested = (lines: number): string =>
        `describe('outer', () => {\ndescribe('inner', () => {\n${test(lines)}})\n})\n`
      const spelled = `describe('outer > describe inner', () => {\n${test(49)}})\n`
      const root = repo({ 'src/a.spec.ts': nested(49) })
      run(root, '--write-baseline')
      commitBase(root)

      writeFileSync(join(root, 'src/a.spec.ts'), nested(5) + spelled)
      const result = run(root, '--base', 'HEAD')

      expect(result.status).toBe(1)
      expect(result.output).toContain('over the 50-line limit')
    })

    it('does not let a title spell the placeholder of a dynamic title', () => {
      const dynamic = `it(title, () => {\n${statements(49)}})\n`
      const literal = `it('<dynamic>', () => {\n${statements(49)}})\n`
      const root = repo({ 'src/a.spec.ts': dynamic })
      run(root, '--write-baseline')
      commitBase(root)

      writeFileSync(join(root, 'src/a.spec.ts'), `it(title, () => {})\n${literal}`)
      const result = run(root, '--base', 'HEAD')

      expect(result.status).toBe(1)
      expect(result.output).toContain('over the 50-line limit')
    })

    it('keeps a test titled like an ordinal apart from the second test of that title', () => {
      const long = (title: string, lines: number): string =>
        `  it('${title}', () => {\n${statements(lines)}  })\n`
      const spec = (second: number): string =>
        `describe('Suite', () => {\n${long('same', 49)}${long('same', second)}${long('same #2', 49)}})\n`
      const root = repo({ 'src/a.spec.ts': spec(49) })
      run(root, '--write-baseline')
      commitBase(root)

      writeFileSync(join(root, 'src/a.spec.ts'), spec(90))
      const result = run(root, '--base', 'HEAD')

      expect(result.status).toBe(1)
      expect(result.output).toContain('describe Suite > it same #2 grew from')
    })

    it('numbers only the tests over the limit, so a short test with the same title changes nothing', () => {
      const long = (): string => `  it('same', () => {\n${statements(49)}  })\n`
      const short = "  it('same', () => {\n    work()\n  })\n"
      const spec = (body: string): string => `describe('Suite', () => {\n${body}})\n`
      const root = repo({ 'src/a.spec.ts': spec(long() + short + long()) })

      run(root, '--write-baseline')
      const baseline = JSON.parse(
        readFileSync(join(root, 'scripts', 'function-length-baseline.json'), 'utf8')
      ) as { functions: Record<string, number> }
      writeFileSync(join(root, 'src/a.spec.ts'), spec(short + long() + short + long() + short))

      const suite = ['container', 'describe', 'Suite']
      expect(Object.keys(baseline.functions)).toEqual([
        keyOf('src/a.spec.ts', [suite, ['test', 'it', 'same']]),
        keyOf('src/a.spec.ts', [suite, ['test', 'it', 'same']], 2)
      ])
      expect(run(root).status).toBe(0)
    })

    it('does not rename a baselined function when a small function is added before it', () => {
      const big = `  return [2].map((v) => {\n${statements(55)}  })\n`
      const before = `function f() {\n  [1].map((v) => v)\n${big}}\n`
      const root = repo({ 'src/a.ts': before })
      run(root, '--write-baseline')

      writeFileSync(
        join(root, 'src/a.ts'),
        `function f() {\n  [0].map((v) => v)\n  [1].map((v) => v)\n${big}}\n`
      )

      expect(run(root).output).toContain('src/a.ts::f grew from')
      expect(run(root).output).not.toContain('<anonymous> #')
    })

    it('keys a class property arrow with its class, so two classes with one member name differ', () => {
      const member = (cls: string): string =>
        `class ${cls} {\n  run = () => {\n${statements(49)}  }\n}\n`

      const result = run(repo({ 'src/a.ts': member('A') + member('B') }))

      expect(result.output).toContain('src/a.ts::A.run spans 51 lines')
      expect(result.output).toContain('src/a.ts::B.run spans 51 lines')
    })

    it('numbers two tests with one title', () => {
      const long = (): string => `  it('same', () => {\n${statements(49)}  })\n`
      const spec = `describe('Suite', () => {\n${long()}${long()}})\n`

      const result = run(repo({ 'src/a.spec.ts': spec }))

      expect(result.output).toContain('it same spans 51 lines')
      expect(result.output).toContain('it same #2 spans 51 lines')
    })
  })
})
