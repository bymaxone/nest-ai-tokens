/**
 * @fileoverview Pins the mutation-testing scope to the code that ships. The shipped source is the closure of the relative imports
 * of the package entries in `tsup.config.ts`; every file in it must either be matched by `mutate` in
 * `stryker.config.json` or be listed in `./stryker-scope.data` with the reason it is not. A file that is neither, a
 * listed file that no longer exists, a listed file that `mutate` still matches, and a listed file whose kind no
 * longer holds all fail, so an exclusion cannot go stale or hide runtime code behind a name such as `index.ts`.
 *
 * This file is a template of the shared CI repository and is copied byte for byte. Everything that differs between
 * libraries lives in `./stryker-scope.data`, which is not compared.
 *
 * @layer tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import * as ts from 'typescript'
import { E2E_OWNED, EXCLUSIONS, EXPECTED, SHIPPED_DATA } from './stryker-scope.data'

/**
 * Why shipped files are not mutated, and the property that justifies it, checked against the files:
 * - `barrel`: re-exports only.
 * - `types`: compiles to nothing.
 * - `constants`: constant data with no logic, checked by the constants-logic check below.
 * - `const-table`: types and frozen `as const` literals only.
 * - `e2e-owned`: judged by an end-to-end suite, not by a unit spec.
 */
export type ExclusionKind = 'barrel' | 'types' | 'constants' | 'const-table' | 'e2e-owned'

/** One reason a group of shipped files is not mutated. */
export interface Exclusion {
  readonly kind: ExclusionKind
  readonly reason: string
  readonly files: readonly string[]
  /** A script that owns the excluded files, when the exclusion is only honest while that script exists. */
  readonly ownedBy?: { readonly packageScript: string; readonly file: string }
}

const ROOT = resolve(__dirname, '..')

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

/** The entry files an `entry: { name: 'path', ... }` object of a tsup config text names. */
function entriesOf(text: string): string[] {
  const pair = /(?:'[^']+'|"[^"]+"|[A-Za-z_$][\w$-]*)\s*:\s*(?:'([^']+)'|"([^"]+)")/g
  return [...text.matchAll(/entry:\s*\{([^}]*)\}/g)].flatMap((object) =>
    [...object[1]!.matchAll(pair)].map((match) => match[1] ?? match[2]!),
  )
}

/** The package entry files named by `tsup.config.ts`. */
function entries(): string[] {
  return entriesOf(read('tsup.config.ts'))
}

/** The relative module specifiers a source file imports or re-exports, as written. */
function relativeSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/?[^'"]*)['"]/g)].map(
    (match) => match[1]!,
  )
}

/** The runtime extension a TypeScript source file is imported by, and the source extensions that can back it. */
const SOURCE_FOR_RUNTIME: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}

/**
 * The file a relative specifier resolves to from `from`, or `undefined` when it is not TypeScript source: the
 * specifier as written, a runtime extension (`./a.js`) backed by its source, or a directory index.
 */
function resolveSpecifier(
  from: string,
  specifier: string,
  exists: (path: string) => boolean = (path) => existsSync(join(ROOT, path)),
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier))
  const runtime = Object.keys(SOURCE_FOR_RUNTIME).find((extension) => base.endsWith(extension))
  const candidates =
    runtime === undefined
      ? [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
      : SOURCE_FOR_RUNTIME[runtime]!.map((source) => `${base.slice(0, -runtime.length)}${source}`)
  return candidates.find((candidate) => exists(candidate))
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

/** The syntax kinds that make a file logic rather than data. */
const LOGIC_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.TaggedTemplateExpression,
  ts.SyntaxKind.DeleteExpression,
  ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
])

/** Arithmetic over number literals alone (`24 * 3600`): a constant written out, not a decision. */
function isLiteralArithmetic(node: ts.Node): boolean {
  if (ts.isNumericLiteral(node)) return true
  if (ts.isParenthesizedExpression(node)) return isLiteralArithmetic(node.expression)
  return (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
      node.operatorToken.kind,
    ) &&
    isLiteralArithmetic(node.left) &&
    isLiteralArithmetic(node.right)
  )
}

/** A `Symbol('description')` call: the one runtime call a constants file may make, since it builds a metadata key. */
function isSymbolToken(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Symbol'
  )
}

/** The runtime globals whose use makes a value depend on the environment rather than on the file. */
const RUNTIME_GLOBALS: ReadonlySet<string> = new Set([
  'process',
  'globalThis',
  'Date',
  'Math',
  'Reflect',
  'Object',
  'JSON',
  'Promise',
])

/** A read of a runtime global, such as `process.env.X` or `Date.now`, which is not constant data. */
function isRuntimeLookup(node: ts.Node): boolean {
  return ts.isIdentifier(node) && RUNTIME_GLOBALS.has(node.text)
}

/** A prefix `++x` or `--x`: an update, unlike the prefix minus of `-1`, which is a constant written out. */
function isIncrementOrDecrement(node: ts.Node): boolean {
  return (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  )
}

/** The names of the logic constructs a source file contains: none for a file that is only constant data. */
function logicIn(text: string): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (isRuntimeLookup(node)) found.push(`global ${node.getText()}`)
    if (isIncrementOrDecrement(node)) found.push('update expression')
    if (LOGIC_KINDS.has(node.kind) && !isLiteralArithmetic(node) && !isSymbolToken(node)) {
      found.push(ts.SyntaxKind[node.kind])
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('file.ts', text, ts.ScriptTarget.ES2022, true))
  return found
}

/** Whether an expression is a literal made of strings, numbers and nested object literals only, with plain keys. */
function isPlainLiteral(node: ts.Expression): boolean {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return true
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        isPlainLiteral(property.initializer),
    )
  }
  return false
}

/** The top-level statements of a file that are neither a type declaration nor an exported `as const` table. */
function nonTableStatements(text: string): string[] {
  const file = ts.createSourceFile('table.ts', text, ts.ScriptTarget.ES2022, true)
  return file.statements
    .filter((statement) => {
      if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return false
      if (ts.isVariableStatement(statement)) {
        return !statement.declarationList.declarations.every(
          (declaration) =>
            (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
            declaration.initializer !== undefined &&
            ts.isAsExpression(declaration.initializer) &&
            ts.isTypeReferenceNode(declaration.initializer.type) &&
            declaration.initializer.type.typeName.getText(file) === 'const' &&
            isPlainLiteral(declaration.initializer.expression),
        )
      }
      return true
    })
    .map((statement) => statement.getText(file))
}

const mutateList = (JSON.parse(read('stryker.config.json')) as { mutate: string[] }).mutate
const shipped = shippedSource()
const listed = excluded(shipped)

/** The listed files of one kind. */
function listedOfKind(kind: ExclusionKind): string[] {
  return [...listed].filter(([, exclusion]) => exclusion.kind === kind).map(([path]) => path)
}

describe('mutation scope', () => {
  /** An empty closure would make every other check pass vacuously. */
  it('finds the shipped source from the package entries', () => {
    expect(entries()).toHaveLength(EXPECTED.entries)
    expect(shipped).toEqual(expect.arrayContaining([...EXPECTED.includes]))
    expect(shipped).toHaveLength(EXPECTED.shipped)
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
      expect({
        path,
        rest: withoutComments(read(path))
          .replace(/^\s*'use client'\s*;?/m, '')
          .replace(reexport, '')
          .trim(),
      }).toEqual({
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

  /** A constants file holds data only: any logic in it is code the exclusion would hide from the mutation run. */
  it('keeps every listed constants file free of logic', () => {
    for (const [path, exclusion] of listed) {
      if (exclusion.kind !== 'constants') continue
      expect({ path, logic: logicIn(read(path)) }).toEqual({ path, logic: [] })
    }
  })

  /** The check sees logic a name-based scan cannot: a function, a branch or a constructor call. */
  it('detects logic in a constants file that a name scan misses', () => {
    expect(logicIn("export const A = { a: 'a' } as const\nexport const B = Symbol('b')")).toEqual(
      [],
    )
    expect(logicIn('export const A = () => 1')).not.toEqual([])
    expect(logicIn("export const A = process.env.X ? 'a' : 'b'")).not.toEqual([])
    expect(logicIn('export const A = new Map()')).not.toEqual([])
    expect(logicIn('export const A = Math.random()')).not.toEqual([])
    expect(logicIn('export const A = process.env.X')).not.toEqual([])
    expect(logicIn('export const A = { value() { return 1 } } as const')).not.toEqual([])
    expect(logicIn('export const A = { get value() { return 1 } }')).not.toEqual([])
    expect(logicIn('export const A = { set value(v: number) {} }')).not.toEqual([])
    expect(logicIn('export const A = tag`x`')).not.toEqual([])
    expect(logicIn("export const A = Symbol('a')")).toEqual([])
    expect(logicIn('export const A = 24 * 3600')).toEqual([])
    expect(logicIn('export const A = B * 3600')).not.toEqual([])
    expect(logicIn('export const A = 1 < 2')).not.toEqual([])
    expect(logicIn('export const A = counter++')).not.toEqual([])
    expect(logicIn('export const A = ++counter')).not.toEqual([])
    expect(logicIn('export const A = --counter')).not.toEqual([])
    expect(logicIn('export const A = delete table.key')).not.toEqual([])
    expect(logicIn('export const A = -1')).toEqual([])
  })

  /** A runtime extension is resolved to the source that backs it, and a directory to its index, `.tsx` included. */
  it('resolves a .js specifier to its TypeScript source and a directory to its index', () => {
    const files = new Set([
      'src/runtime.ts',
      'src/view.tsx',
      'src/component/index.tsx',
      'src/util/index.ts',
    ])
    const resolve = (specifier: string): string | undefined =>
      resolveSpecifier('src/index.ts', specifier, (path) => files.has(path))

    expect(resolve('./runtime.js')).toBe('src/runtime.ts')
    expect(resolve('./view.js')).toBe('src/view.tsx')
    expect(resolve('./component')).toBe('src/component/index.tsx')
    expect(resolve('./util')).toBe('src/util/index.ts')
    expect(resolve('./runtime')).toBe('src/runtime.ts')
    expect(resolve('./missing.js')).toBeUndefined()
  })

  /** The entries are read from the config text: every pair of an entry object counts, whatever its key is spelled like. */
  it('reads every entry of a tsup entry object, with quoted or bare keys', () => {
    expect(entriesOf("entry: { 'index': 'src/index.ts' }")).toEqual(['src/index.ts'])
    expect(entriesOf("entry: { 'a': 'src/a.ts', 'b': 'src/b.ts' }")).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    expect(entriesOf("entry: { index: 'src/index.ts', server: 'src/server.ts' }")).toEqual([
      'src/index.ts',
      'src/server.ts',
    ])
    expect(entriesOf('entry: {\n  "a/b": "src/a/b.ts",\n  c: "src/c.ts",\n}')).toEqual([
      'src/a/b.ts',
      'src/c.ts',
    ])
    expect(entriesOf("entry: { 'a': 'src/a.ts' }, x: 1, entry: { 'b': 'src/b.ts' }")).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
  })

  /** A const-table file holds types and `as const` literals only: any other statement is code the exclusion would hide. */
  it('keeps every listed const-table file to as-const tables and types', () => {
    for (const [path, exclusion] of listed) {
      if (exclusion.kind !== 'const-table') continue
      expect({ path, other: nonTableStatements(read(path)) }).toEqual({ path, other: [] })
    }
  })

  /** The table check rejects a function, a mutable literal and a computed value, and accepts the real shape. */
  it('detects a statement that is not an as-const table', () => {
    expect(
      nonTableStatements(
        "export const A = { a: 'x' } as const\nexport type B = (typeof A)[keyof typeof A]",
      ),
    ).toEqual([])
    expect(nonTableStatements("export const A = { a: 'x' }")).toHaveLength(1)
    expect(nonTableStatements('export function f() { return 1 }')).toHaveLength(1)
    expect(nonTableStatements('export const A = f() as const')).toHaveLength(1)
    expect(nonTableStatements('export const A = { a: g() } as const')).toHaveLength(1)
    expect(
      nonTableStatements("export const A = { [String(Date.now())]: 'x' } as const"),
    ).toHaveLength(1)
    expect(nonTableStatements("export const A = { ['a']: 'x' } as const")).toHaveLength(1)
    expect(nonTableStatements('export const A = { ...B } as const')).toHaveLength(1)
    expect(nonTableStatements("export const A = { 'a-b': 'x', 1: 'y', c: 'z' } as const")).toEqual(
      [],
    )
    expect(nonTableStatements("export const A = { a: 'x' } as const\nA.a")).toHaveLength(1)
  })

  /** An exclusion that names an owning script is only honest while the script and its package entry exist. */
  it('keeps the script that owns an exclusion', () => {
    for (const exclusion of EXCLUSIONS) {
      if (exclusion.ownedBy === undefined) continue
      expect(read('package.json')).toContain(`"${exclusion.ownedBy.packageScript}"`)
      expect(existsSync(join(ROOT, exclusion.ownedBy.file))).toBe(true)
    }
  })

  /** An end-to-end-owned file is only excused while an end-to-end suite exercises its subpath. */
  it('keeps an end-to-end suite that exercises the subpath of the end-to-end-owned files', () => {
    if (E2E_OWNED === null) {
      expect(listedOfKind('e2e-owned')).toEqual([])
      return
    }
    const { suites, subpath } = E2E_OWNED
    const e2e = suites.map((suite) => read(suite))
    expect(e2e.length).toBeGreaterThan(0)
    expect(e2e.some((text) => text.includes(subpath))).toBe(true)
    expect(listedOfKind('e2e-owned').length).toBeGreaterThan(0)
  })

  /** The shipped data files are not code; they must still be the files the build copies. */
  it('names the data files the build ships', () => {
    const tsup = read('tsup.config.ts')
    for (const { path, tsupNeedle } of SHIPPED_DATA) {
      expect(existsSync(join(ROOT, path))).toBe(true)
      expect(tsup).toContain(`'${tsupNeedle}'`)
    }
  })
})
