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
  { file: 'redis/index.ts', text: 'const outcome = await Promise.race([client.quit(), late])', reason: 'Shutdown only: the outcome decides whether disconnect() is also called after quit(); a forged outcome costs at most one extra disconnect of a client being closed.' },
  { file: 'server/bymax-ai-tokens.module.ts', text: 'useFactory: (...args: unknown[]): Promise<ResolvedAiTokensOptions> => safeResolve(Promise.resolve(factory(...args))),', reason: 'Lifts the options a host factory returned into a promise that safeResolve waits for natively; the options are validated after the wait.' },
  { file: 'server/bymax-ai-tokens.module.ts', text: 'useFactory: (factory: BymaxAiTokensModuleOptionsFactory): Promise<ResolvedAiTokensOptions> => safeResolve(Promise.resolve(factory.createAiTokensOptions())),', reason: 'Lifts the options a host factory returned into a promise that safeResolve waits for natively; the options are validated after the wait.' },
  { file: 'server/utils/absorb-host-call.ts', text: 'Promise.resolve(call()).catch((error: unknown) => {', reason: 'Absorbs a host callback: the chain result is discarded and only logs the failure.' },
  { file: 'server/enforcement/metering.interceptor.ts', text: "const released = this.metering.release(enrichment.hold, enrichment.context, 'handler threw').catch(() => {", reason: 'The release of a hold after a handler threw: the chain result is only awaited to keep the failure from escaping, never read.' },
  { file: 'server/utils/prototype-guard.ts', text: 'if (result instanceof Promise) return result.finally(() => void (active = was)) as T', reason: 'The test seam withoutRealmGuard restores a flag after a promise settles; it is removed from the shipped bundle and the result is the caller own promise.' },
  ...['usageRecorded', 'priceMissing', 'holdReleased', 'usageReversed', 'audit'].map((name) => ({
    file: 'server/services/metering.service.ts',
    text: `${name}: (): Promise<void> => Promise.resolve(),`,
    reason: 'A resolved promise of nothing for a no-op event hook; it carries no value.',
  })),
  { file: 'server/services/metering.service.ts', text: "await this.release(hold, context, 'capture failed').catch(() => undefined)", reason: 'The compensating release after a failed capture: its result is ignored and the original failure is rethrown.' },
  { file: 'server/services/metering.service.ts', text: 'if (content === undefined) return Promise.resolve()', reason: 'A resolved promise of nothing for an absent content capture; it carries no value.' },
]

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
