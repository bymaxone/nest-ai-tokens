/**
 * Pins the mutation-testing scope to the code that ships. The shipped source is the closure of the relative imports
 * of the package entries in `tsup.config.ts`; every file in it must either be matched by `mutate` in
 * `stryker.config.json` or be listed below with the reason it is not. A file that is neither, a listed file that no
 * longer exists, a listed file that `mutate` still matches, and a listed file whose kind no longer holds all fail,
 * so an exclusion cannot go stale or hide runtime code behind a name such as `index.ts`.
 *
 * Layer: repository tooling, tests.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import * as ts from 'typescript'

const ROOT = resolve(__dirname, '..')

/** Why shipped files are not mutated, and the property that justifies it, checked against the files. */
type ExclusionKind = 'barrel' | 'types' | 'e2e-owned'

interface Exclusion {
  readonly kind: ExclusionKind
  readonly reason: string
  readonly files: readonly string[]
}

/** Every shipped source file that `mutate` leaves out. */
const EXCLUSIONS: readonly Exclusion[] = [
  {
    kind: 'barrel',
    reason:
      'Re-exports only: there is no statement to mutate, and a barrel that gains logic fails this spec.',
    files: [
      'src/prices/index.ts',
      'src/shared/index.ts',
      'src/shared/normalizers/index.ts',
      'src/server/index.ts',
      'src/server/config/index.ts',
      'src/server/enforcement/index.ts',
      'src/server/errors/index.ts',
      'src/server/interfaces/index.ts',
      'src/server/services/index.ts',
    ],
  },
  {
    kind: 'types',
    reason:
      'Types only: it compiles to nothing, and a runtime declaration added to it fails this spec.',
    files: ['src/server/config/resolved-options.ts', 'src/server/interfaces/*.interface.ts'],
  },
  {
    kind: 'e2e-owned',
    reason:
      'The store runs its statements against PostgreSQL, so a mutant needs a database to be judged: it has no unit spec, ' +
      'and the Testcontainers suite on the four Prisma cells pins its behaviour. Mutating it would start one database ' +
      'per mutant, hours per cell.',
    files: ['src/prisma/index.ts'],
  },
]

/** Shipped files that are data, not TypeScript, copied next to the Prisma bundle by `tsup.config.ts`. */
const SHIPPED_DATA = ['src/prisma/schema.prisma.fragment', 'src/prisma/migrations/0001_init.sql']

/** The text of a file under the repository root. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** A glob (`**`, `*`, literal text) as a regular expression over repository-relative paths. */
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i)
    if (rest.startsWith('**/')) {
      source += '(?:.*/)?'
      i += 2
    } else if (rest.startsWith('**')) {
      source += '.*'
      i += 1
    } else if (glob[i] === '*') {
      source += '[^/]*'
    } else {
      source += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** Whether the path is selected by the `mutate` list: patterns apply in order, `!` removes. */
function mutated(path: string, mutate: readonly string[]): boolean {
  let selected = false
  for (const entry of mutate) {
    const negated = entry.startsWith('!')
    if (globToRegExp(negated ? entry.slice(1) : entry).test(path)) selected = !negated
  }
  return selected
}

/** The package entry files named by `tsup.config.ts`. */
function entries(): string[] {
  return [...read('tsup.config.ts').matchAll(/entry:\s*\{\s*'[^']+':\s*'([^']+)'/g)].map(
    (match) => match[1]!,
  )
}

/** The relative module specifiers a source file imports or re-exports, as written. */
function relativeSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/?[^'"]*)['"]/g)].map(
    (match) => match[1]!,
  )
}

/** The file a relative specifier resolves to from `from`, or `undefined` when it is not TypeScript source. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier))
  return [`${base}.ts`, `${base}/index.ts`].find((candidate) => existsSync(join(ROOT, candidate)))
}

/** The source closure of the package entries: every non-spec file they reach through relative imports. */
function shippedSource(): string[] {
  const seen = new Set<string>()
  const queue = entries()
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (seen.has(path)) continue
    seen.add(path)
    for (const specifier of relativeSpecifiers(read(path))) {
      const next = resolveSpecifier(path, specifier)
      if (next !== undefined) queue.push(next)
    }
  }
  return [...seen].sort()
}

/** Every shipped file a listed exclusion matches, with the exclusion that matched it. */
function excluded(shipped: readonly string[]): Map<string, Exclusion> {
  const found = new Map<string, Exclusion>()
  for (const exclusion of EXCLUSIONS) {
    for (const pattern of exclusion.files) {
      const matcher = globToRegExp(pattern)
      for (const path of shipped) if (matcher.test(path)) found.set(path, exclusion)
    }
  }
  return found
}

/** The statements the compiler emits for the source, without the module boilerplate every file gets. */
function emittedStatements(text: string): string[] {
  const { outputText } = ts.transpileModule(text, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
      removeComments: true,
    },
  })
  return outputText
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        line !== '"use strict";' &&
        line !== 'Object.defineProperty(exports, "__esModule", { value: true });' &&
        !line.startsWith('//'),
    )
}

/** The source with comments removed. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const mutateList = (JSON.parse(read('stryker.config.json')) as { mutate: string[] }).mutate
const shipped = shippedSource()
const listed = excluded(shipped)

describe('mutation scope', () => {
  /** An empty closure would make every other check pass vacuously. */
  it('finds the shipped source from the package entries', () => {
    expect(entries()).toHaveLength(5)
    expect(shipped).toEqual(
      expect.arrayContaining(['src/server/index.ts', 'src/redis/index.ts', 'src/prisma/index.ts']),
    )
    expect(shipped.length).toBeGreaterThan(60)
  })

  /** A shipped file is mutated or its absence is explained; nothing is left out by accident. */
  it('mutates every shipped file that is not listed with a reason', () => {
    const unexplained = shipped.filter((path) => !mutated(path, mutateList) && !listed.has(path))
    expect(unexplained).toEqual([])
  })

  /** A listed file that `mutate` still selects would be both mutated and excused. */
  it('lists no file that mutate still selects', () => {
    expect([...listed.keys()].filter((path) => mutated(path, mutateList))).toEqual([])
  })

  /** A listed pattern that matches no shipped file is a reason about code that is gone. */
  it('lists no pattern that matches no shipped file', () => {
    for (const exclusion of EXCLUSIONS) {
      for (const pattern of exclusion.files) {
        expect({
          pattern,
          matches: shipped.filter((path) => globToRegExp(pattern).test(path)).length,
        }).not.toEqual({
          pattern,
          matches: 0,
        })
      }
      expect(exclusion.reason.length).toBeGreaterThan(20)
    }
  })

  /** A barrel holds re-exports only: any other statement is code the exclusion would hide. */
  it('keeps every listed barrel to re-exports', () => {
    const reexport =
      /(?:export|import)\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+'[^']+'/g
    for (const [path, exclusion] of listed) {
      if (exclusion.kind !== 'barrel') continue
      expect({ path, rest: withoutComments(read(path)).replace(reexport, '').trim() }).toEqual({
        path,
        rest: '',
      })
    }
  })

  /** A types-only file compiles to nothing: the compiler, not a list of keywords, decides what is runtime. */
  it('keeps every listed types file free of runtime output', () => {
    for (const [path, exclusion] of listed) {
      if (exclusion.kind !== 'types') continue
      expect({ path, emitted: emittedStatements(read(path)) }).toEqual({ path, emitted: [] })
    }
  })

  /** The check sees what a keyword scan cannot: re-exports, default exports, namespaces and bare calls. */
  it('detects runtime output in a types file that a keyword scan misses', () => {
    expect(
      emittedStatements(
        "export type A = { a: 1 }\nexport interface B { b: A }\nimport type { C } from './c'",
      ),
    ).toEqual([])
    expect(emittedStatements("export { value } from './runtime'")).not.toEqual([])
    expect(emittedStatements('export default { a: 1 }')).not.toEqual([])
    expect(emittedStatements('export namespace N { export const x = 1 }')).not.toEqual([])
    expect(emittedStatements('Object.freeze({})')).not.toEqual([])
  })

  /** An end-to-end-owned file is only excused while an end-to-end suite exercises its subpath. */
  it('keeps every end-to-end-owned file exercised by an end-to-end suite', () => {
    const e2e = ['wallet-plan-stability', 'prisma-wallet-budget', 'prisma-migrations'].map((name) =>
      read(`test/e2e/${name}.e2e-spec.ts`),
    )
    expect(e2e.some((text) => text.includes('@bymax-one/nest-ai-tokens/prisma'))).toBe(true)
    expect([...listed.values()].some((exclusion) => exclusion.kind === 'e2e-owned')).toBe(true)
  })

  /** The shipped data files are not code; they must still be the files the build copies. */
  it('names the data files the build ships', () => {
    for (const path of SHIPPED_DATA) expect(existsSync(join(ROOT, path))).toBe(true)
    expect(read('tsup.config.ts')).toContain("'src/prisma/schema.prisma.fragment'")
    expect(read('tsup.config.ts')).toContain("'src/prisma/migrations'")
  })
})
