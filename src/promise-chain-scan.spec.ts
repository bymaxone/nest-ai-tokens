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

/** A use that stays, by the file it is in and the text of its line, with why its result decides nothing. */
const EXEMPT: readonly { file: string; line: RegExp; reason: string }[] = [
  { file: 'redis/index.ts', line: /Promise\.race\(/, reason: 'Shutdown only: the outcome decides whether disconnect() is also called after quit(); a forged outcome costs at most one extra disconnect of a client being closed.' },
  { file: 'redis/index.ts', line: /Promise\.resolve\(this\.#source\)/, reason: 'Wraps the client the host handed in; the host is the client, and the value is waited for by the caller with await.' },
  { file: 'redis/index.ts', line: /Promise\.reject\(new Error/, reason: 'A rejection for a closed store, which the caller waits for with await; it carries no host value.' },
  { file: 'server/bymax-ai-tokens.module.ts', line: /safeResolve\(Promise\.resolve\(/, reason: 'Lifts the options a host factory returned into a promise that safeResolve waits for natively; the options are validated after the wait.' },
  { file: 'server/utils/absorb-host-call.ts', line: /Promise\.resolve\(call\(\)\)\.catch\(/, reason: 'Absorbs a host callback: the chain result is discarded and only logs the failure.' },
  { file: 'server/enforcement/metering.interceptor.ts', line: /\.release\(.*\)\.catch\(/, reason: 'The release of a hold after a handler threw: the chain result is only awaited to keep the failure from escaping, never read.' },
  { file: 'server/utils/prototype-guard.ts', line: /result\.finally\(/, reason: 'The test seam withoutRealmGuard restores a flag after a promise settles; it is removed from the shipped bundle and the result is the caller own promise.' },
  { file: 'server/enforcement/hold-reaper.ts', line: /\.(?:catch|finally)\(/, reason: 'The reaper tick: the chain result is discarded, it logs a failure and clears the running flag.' },
  { file: 'server/services/metering.service.ts', line: /Promise\.resolve\(\)/, reason: 'A resolved promise of nothing for a no-op event hook or an absent content capture; it carries no value.' },
  { file: 'server/services/metering.service.ts', line: /this\.release\(.*\)\.catch\(\(\) => undefined\)/, reason: 'The compensating release after a failed capture: its result is ignored and the original failure is rethrown.' },
]

/** Every shipped source file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** Whether a line is only a comment. */
function isComment(line: string): boolean {
  return /^\s*(?:\/\/|\*|\/\*)/.test(line)
}

describe('no decision path chains a promise', () => {
  const found = sources(ROOT).flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((text, index) => (!isComment(text) && CHAIN.test(text) ? [{ file: relative(ROOT, path), line: index + 1, text: text.trim() }] : [])),
  )

  it('names every chain, combinator and for-await in the shipped source with the reason it decides nothing', () => {
    const unnamed = found.filter((hit) => !EXEMPT.some((entry) => entry.file === hit.file && entry.line.test(hit.text)))
    expect(unnamed.map((hit) => `${hit.file}:${String(hit.line)}  ${hit.text}`)).toEqual([])
  })

  it('keeps no exemption that no line uses', () => {
    const stale = EXEMPT.filter((entry) => !found.some((hit) => hit.file === entry.file && entry.line.test(hit.text)))
    expect(stale.map((entry) => `${entry.file} ${String(entry.line)}`)).toEqual([])
  })
})
