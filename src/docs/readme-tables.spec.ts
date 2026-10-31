/**
 * @fileoverview Pins the README's option-defaults table to the defaults the code
 * assigns. The table is prose a reader trusts, so a default that drifts from
 * `DEFAULT_AI_TOKENS_OPTIONS` fails here by name instead of surviving until a
 * consumer notices.
 * @layer docs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AI_TOKENS_OPTIONS } from '../server/config/default-options.constants'
import type { BymaxAiTokensModuleOptions } from '../server/interfaces'
import type { BudgetPolicy, RatingMode } from '../shared'

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8')

/** The rows of the first Markdown table after `heading`, as trimmed cell arrays (header and rule skipped). */
function tableAfter(heading: string): string[][] {
  const start = README.indexOf(heading)
  if (start === -1) {
    throw new Error(`README heading not found: ${heading}`)
  }
  const lines = README.slice(start).split('\n')
  const first = lines.findIndex((line) => line.startsWith('|'))
  const rows: string[][] = []
  for (const line of lines.slice(first)) {
    if (!line.startsWith('|')) {
      break
    }
    // Split on unescaped pipes: a cell may contain `\|` (a union type).
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim())
    rows.push(cells)
  }
  return rows.slice(2)
}

/** The text inside the first pair of backticks in a cell, or undefined. */
function code(cell: string | undefined): string | undefined {
  return cell === undefined ? undefined : /`([^`]+)`/.exec(cell)?.[1]
}

/** Parses a documented default: `'rate-table'`, `1.0`, `3600`, `true`, `1_000_000_000n` or `[0.8, 1.0]`. */
function parseDefault(raw: string): unknown {
  const text = raw.replaceAll('_', '')
  if (text === 'true' || text === 'false') {
    return text === 'true'
  }
  if (/^\d+n$/.test(text)) {
    return BigInt(text.slice(0, -1))
  }
  if (/^[\d.]+$/.test(text)) {
    return Number(text)
  }
  if (text.startsWith('[')) {
    return JSON.parse(text) as unknown
  }
  return text.replace(/^'|'$/g, '')
}

function valueAt(source: object, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], source)
}

/** Options with a default in the table: each must be documented, and with the value the code assigns. */
const DOCUMENTED_DEFAULTS = [
  'ratingMode',
  'markup',
  'pricing.seedFromSnapshot',
  'wallets.creditRateNanoUsd',
  'wallets.burnOrder',
  'budgets.defaultPolicy',
  'budgets.alertThresholds',
  'holds.ttlSeconds',
  'telemetry.metrics',
]

/** Every member of a literal-union option, kept exhaustive by the compiler: a new member fails to compile until it is listed. */
const MEMBERS: Record<string, string[]> = {
  ratingMode: Object.keys({ 'rate-table': true, 'provider-reported': true } satisfies Record<
    RatingMode,
    true
  >),
  'budgets.defaultPolicy': Object.keys({
    block: true,
    throttle: true,
    allow: true,
  } satisfies Record<BudgetPolicy, true>),
  'wallets.burnOrder': Object.keys({ expiry: true, priority: true, fifo: true } satisfies Record<
    NonNullable<NonNullable<BymaxAiTokensModuleOptions['wallets']>['burnOrder']>,
    true
  >),
}

describe('README configuration table', () => {
  const rows = tableAfter('## ⚙️ Configuration')
  const documented = new Map(rows.map((cells) => [code(cells[0]), code(cells[2])]))

  it('documents a default for every option listed here', () => {
    // Guards the spec itself: a renamed row would otherwise leave the value check below with nothing to compare.
    for (const path of DOCUMENTED_DEFAULTS) {
      expect(documented.get(path)).toBeDefined()
    }
  })

  it.each(DOCUMENTED_DEFAULTS)('documents the default the code assigns to %s', (path) => {
    const raw = documented.get(path)
    expect(parseDefault(raw ?? '')).toEqual(valueAt(DEFAULT_AI_TOKENS_OPTIONS, path))
  })

  it('pins every row that states a default', () => {
    // Every row that states a backticked default must be one the spec pins, so a new row cannot skip the check.
    const withDefault = rows
      .filter((cells) => code(cells[2]) !== undefined)
      .map((cells) => code(cells[0]))
    expect(withDefault.sort()).toEqual([...DOCUMENTED_DEFAULTS].sort())
  })

  /** The Type column lists every member of a literal-union option, and no other. */
  it.each(Object.keys(MEMBERS))('lists exactly the members of %s in its Type column', (path) => {
    const row = rows.find((cells) => code(cells[0]) === path)
    const listed = [...(row?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect(listed.sort()).toEqual([...(MEMBERS[path] ?? [])].sort())
  })
})
