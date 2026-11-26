/**
 * @fileoverview No decision path chains a promise. A chain (`.then`, `.catch`, `.finally`) returns a promise built by the constructor that
 * `Promise[Symbol.species]` names, read on every call, and `Promise.resolve`, `Promise.all` and the other combinators read `Promise.resolve`
 * live, so a host that plants either decides what the chain resolves to. The scan lists every such use in the shipped source; each one that
 * stays is named with the reason its result decides nothing. A new use fails here until it is waited for with a native `await` (through
 * `settled` for a promise a host returned) or is named with its reason.
 * @layer server
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname)
const CHAIN = /\.(?:then|catch|finally)\(|Promise\.(?:resolve|reject|all|race|any|allSettled)\(|\bfor await\b/

/** A use that stays, by the file and the exact text of its line (trimmed), with why its result decides nothing. */
const EXEMPT: readonly { file: string; text: string; reason: string }[] = [
  { file: 'server/utils/absorb-host-call.ts', text: 'Promise.resolve(call()).catch((error: unknown) => {', reason: 'Absorbs a host callback: the chain result is discarded and only logs the failure.' },
  { file: 'server/enforcement/metering.interceptor.ts', text: "const released = this.metering.release(enrichment.hold, enrichment.context, 'handler threw').catch(() => {", reason: 'The release of a hold after a handler threw: the chain result is only awaited to keep the failure from escaping, never read.' },
  { file: 'server/utils/prototype-guard.ts', text: 'if (result instanceof Promise) return result.finally(() => void (active = was)) as T', reason: 'The test seam withoutRealmGuard restores a flag after a promise settles; it is removed from the shipped bundle and the result is the caller own promise.' },
  ...['usageRecorded', 'priceMissing', 'holdReleased', 'usageReversed', 'settleFailed', 'audit'].map((name) => ({
    file: 'server/services/metering-hooks.ts',
    text: `${name}: (): Promise<void> => Promise.resolve(),`,
    reason: 'A resolved promise of nothing for a no-op event hook; it carries no value.',
  })),
  { file: 'server/services/metering.service.ts', text: "await this.release(hold, context, 'capture failed').catch(() => undefined)", reason: 'The compensating release after a failed capture: its result is ignored and the original failure is rethrown.' },
  { file: 'server/services/metering.service.ts', text: 'if (content === undefined) return Promise.resolve()', reason: 'A resolved promise of nothing for an absent content capture; it carries no value.' },
]

/**
 * What a host supplies as a function, a port or a sink: an `await` of a call on one of these is a wait for host code, and decides through its
 * value. Each must go through `settled` (or `reply` and `waited` for Redis and the driver), which check the promise before the wait and the value after it.
 */
const HOST_CALL = /\bawait\s+(?!settled\(|reply\(|waited\()[^;]*?(?:scopeResolver|policy\.resolve|countTokens|options\.fx|\bfn\(|\blist\(|\bcall\(|sink\.deliver|factory|createAiTokensOptions|\.eval\(|\.quit\(|\.del\()/

/** A bare wait for host code that stays, by file and exact trimmed line, with why a forged answer decides nothing. */
const HOST_EXEMPT: readonly { file: string; text: string; reason: string }[] = [
  { file: 'server/utils/absorb-host-call.ts', text: 'await call()', reason: 'Absorbs a host callback: the outcome is discarded and only a failure is logged.' },
  { file: 'server/enforcement/budget-reference-sweeper.ts', text: "found = await list({ selection, olderThan, limit: this.pageSize, ...(after === undefined ? {} : { after }) })", reason: 'Lists references of a store to clean up; a forged page only skips or repeats cleanup, and every reference is re-read from the store before it is dropped.' },
  { file: 'server/enforcement/orphan-debit-sweeper.ts', text: 'found = await list({', reason: 'Lists orphan debits of a store to settle; a forged page only skips or repeats a settlement, and each debit is claimed through the store.' },
  { file: 'server/events/event-dispatcher.ts', text: 'await sink.deliver(toJsonSafe(envelope))', reason: 'A host event sink: delivery is observation only, and the result is never read.' },
]

/** Every wait for host code in `text` not routed through the checking helpers, with its line number and trimmed text. */
export function scanHostAwaits(text: string): { line: number; text: string }[] {
  return text.split('\n').flatMap((line, index) => (!isComment(line) && HOST_CALL.test(line) ? [{ line: index + 1, text: line.trim() }] : []))
}

/** Every shipped source file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** Whether a line holds no code: it is empty, a line comment, a block-comment line, or block comments alone. A comment before code does not hide the code. */
export function isComment(line: string): boolean {
  const code = line.replace(/\/\*.*?\*\//g, '').trim()
  return code === '' || code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')
}

/** Every use of a chain, combinator or for-await in `text`, with its line number and its trimmed text. */
export function scan(text: string): { line: number; text: string }[] {
  return text.split('\n').flatMap((line, index) => (!isComment(line) && CHAIN.test(line) ? [{ line: index + 1, text: line.trim() }] : []))
}

describe('the scan itself', () => {
  it('flags a bare wait for a host callback and not one routed through settled', () => {
    expect(scanHostAwaits('const context = await this.scopeResolver(executionContext)')).toHaveLength(1)
    expect(scanHostAwaits('return await policy.resolve(context)')).toHaveLength(1)
    expect(scanHostAwaits('const context = await settled(this.scopeResolver(executionContext))')).toEqual([])
    expect(scanHostAwaits('// await this.scopeResolver(x)')).toEqual([])
  })

  it('reads a chain that follows a block comment on the same line', () => {
    expect(scan('/* note */ pending.then(read)')).toEqual([{ line: 1, text: '/* note */ pending.then(read)' }])
  })

  it('skips a line that is only a comment, however it is written', () => {
    expect(scan(['// pending.then(read)', ' * pending.then(read)', '/* pending.then(read) */', '  /** a.catch( */'].join('\n'))).toEqual([])
  })
})

describe('no decision path chains a promise', () => {
  const found = sources(ROOT).flatMap((path) => scan(readFileSync(path, 'utf8')).map((hit) => ({ ...hit, file: relative(ROOT, path) })))
  const named = (entry: (typeof EXEMPT)[number], hit: (typeof found)[number]): boolean => entry.file === hit.file && entry.text === hit.text

  it('names every chain, combinator and for-await in the shipped source with the reason it decides nothing', () => {
    const unnamed = found.filter((hit) => !EXEMPT.some((entry) => named(entry, hit)))
    expect(unnamed.map((hit) => `${hit.file}:${String(hit.line)}  ${hit.text}`)).toEqual([])
  })

  it('keeps no exemption that no line uses', () => {
    const stale = EXEMPT.filter((entry) => !found.some((hit) => named(entry, hit)))
    expect(stale.map((entry) => `${entry.file} ${entry.text}`)).toEqual([])
  })
})

describe('no decision path waits for host code unchecked', () => {
  const found = sources(ROOT).flatMap((path) => scanHostAwaits(readFileSync(path, 'utf8')).map((hit) => ({ ...hit, file: relative(ROOT, path) })))
  const named = (entry: (typeof HOST_EXEMPT)[number], hit: (typeof found)[number]): boolean => entry.file === hit.file && hit.text.includes(entry.text)

  it('routes every wait for a host function, port or sink through settled, reply or waited, or names it with its reason', () => {
    const unnamed = found.filter((hit) => !HOST_EXEMPT.some((entry) => named(entry, hit)))
    expect(unnamed.map((hit) => `${hit.file}:${String(hit.line)}  ${hit.text}`)).toEqual([])
  })

  it('keeps no host exemption that no line uses', () => {
    const stale = HOST_EXEMPT.filter((entry) => !found.some((hit) => named(entry, hit)))
    expect(stale.map((entry) => `${entry.file} ${entry.text}`)).toEqual([])
  })
})
