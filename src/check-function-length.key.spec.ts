/**
 * @fileoverview Pins `scripts/function-length-key.mjs`, the module that encodes and decodes the keys of the
 * function-length baseline: every key reads back as the value it was built from, malformed keys
 * are refused, and a key is shown as `file::outer > inner #2`. The module is plain Node, so each
 * case runs it as a child process.
 *
 * @layer tests
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/** Runs `source` as an ES module that can import the key module, and parses what it prints. */
function runKeyModule(source: string): unknown {
  const keyModule = resolve(__dirname, '..', 'scripts', 'function-length-key.mjs')
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as k from ${JSON.stringify(keyModule)}\n${source}`],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout)
}

describe('the function key', () => {
  // The property that makes the gate's identity safe: every key reads back as exactly the
  // value it was built from, so two different values can never share a key. Free text is drawn from
  // the pieces that have broken string-joined keys: both separators, an ordinal, a placeholder, the
  // escape character, quotes and brackets.
  it('reads back as what was encoded, for random values spelled with every delimiter', () => {
    const outcome = runKeyModule(`
      let seed = 20260711
      const next = () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const pick = (list) => list[Math.floor(next() * list.length)]
      const pieces = ['a', 'b', '::', ' > ', ' #2', '#', '<dynamic>', '<anonymous>', String.fromCharCode(92), '"', '[', ']', ',', 'é', ' ', '']
      const text = () => Array.from({ length: Math.floor(next() * 3) }, () => pick(pieces)).join('')
      const arity = { fn: 1, member: 2, ctor: 1, anon: 0, test: 2, 'dynamic-test': 1, container: 2, 'dynamic-container': 1 }
      const segment = () => {
        const kind = pick(Object.keys(arity))
        return [kind, ...Array.from({ length: arity[kind] }, text)]
      }
      const seen = new Map()
      const failures = []
      for (let i = 0; i < 20000; i++) {
        const value = {
          path: text(),
          segments: Array.from({ length: 1 + Math.floor(next() * 3) }, segment),
          ordinal: next() < 0.3 ? 2 + Math.floor(next() * 3) : 1
        }
        const key = k.encodeKey(value.path, value.segments, value.ordinal)
        const canonical = JSON.stringify(value)
        if (JSON.stringify(k.decodeKey(key)) !== canonical) failures.push(['round trip', canonical])
        if (seen.has(key) && seen.get(key) !== canonical) failures.push(['collision', canonical])
        seen.set(key, canonical)
      }
      console.log(JSON.stringify({ failures, distinct: seen.size }))
    `) as { failures: unknown[]; distinct: number }

    expect(outcome.failures).toEqual([])
    expect(outcome.distinct).toBeGreaterThan(5000)
  })

  it.each([
    ['text that is not JSON', 'src/a.ts::big'],
    ['a JSON string', '"fn"'],
    ['a segment that is a string', '["src/a.ts","fn"]'],
    ['JSON that is not an array', '{"a":1}'],
    ['a path that is not a string', '[1,["fn","big"]]'],
    ['no segment at all', '["src/a.ts"]'],
    ['an empty segment', '["src/a.ts",[]]'],
    ['a segment of an unknown kind', '["src/a.ts",["nope","big"]]'],
    ['a segment with the wrong number of strings', '["src/a.ts",["fn"]]'],
    ['a segment holding a number', '["src/a.ts",["fn",1]]'],
    ['an explicit ordinal of 1', '["src/a.ts",["fn","big"],1]'],
    ['a fractional ordinal', '["src/a.ts",["fn","big"],2.5]'],
    ['spacing the serialization would not write', '["src/a.ts", ["fn","big"]]']
  ])('refuses %s', (_name, key) => {
    const message = runKeyModule(
      `try { k.decodeKey(${JSON.stringify(key)}); console.log('null') } catch (e) { console.log(JSON.stringify(e.message)) }`
    )

    expect(message).toBe(`${key} is not a function key`)
  })

  it('shows a key as file::outer > inner #2', () => {
    const shown = runKeyModule(`
      console.log(JSON.stringify([
        k.displayKey(k.encodeKey('src/a.ts', [['fn', 'outer'], ['member', 'Box', 'run']], 2)),
        k.displayKey(k.encodeKey('src/a.ts', [['ctor', '<class>'], ['anon']])),
        k.displayKey(k.encodeKey('t.ts', [['container', 'describe', 'S'], ['dynamic-test', 'it']]))
      ]))
    `)

    expect(shown).toEqual([
      'src/a.ts::outer > Box.run #2',
      'src/a.ts::<class>.constructor > <anonymous>',
      't.ts::describe S > it <dynamic>'
    ])
  })
})
