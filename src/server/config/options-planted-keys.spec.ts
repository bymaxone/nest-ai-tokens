/**
 * The options of the module are the host's and nobody else's. A key that another library, or an attacker, planted on `Object.prototype` is
 * not an option the host gave: it must not switch the wallet feature on, set the markup or the rating mode, turn off `strict`,
 * `failClosed` or the settlement sweep, or change an overdraft or a hold's lifetime. The options a class instance of the host defines
 * with a getter still count, since that is how a host builds a group.
 * @layer server
 */
import type { BymaxAiTokensModuleOptions, IAiTokensStore } from '../interfaces'
import { applyDefaults } from './apply-defaults'
import { validateOptions } from './validate-options'
import { GROUP_KEYS, OPTION_KEYS, withoutNullish } from './without-nullish'

/** A structurally complete store: validation checks the presence of the methods. */
function store(): IAiTokensStore {
  const fn = (): Promise<never> => Promise.reject(new Error('stub'))
  const names = ['append', 'transition', 'findByIdempotencyKey', 'findById', 'findExpiredHolds', 'query', 'sumCost', 'lastHash', 'resolveRate', 'upsertPrice', 'getPriceHistory', 'listModels', 'getWallet', 'appendEntry', 'conditionalDebit', 'openGrants', 'listEntries', 'reconcile', 'upsert', 'remove', 'findBudgetById', 'findMatching', 'conditionalConsume', 'adjustWindow', 'consumeWindowOnce', 'adjustWindowOnce', 'commitReference', 'dropReference', 'getWindow', 'setWindowStart']
  return Object.fromEntries(names.map((name) => [name, fn])) as unknown as IAiTokensStore
}

const BASE = { store: store(), scopeResolver: (): never => undefined as never } as BymaxAiTokensModuleOptions

/** Plant `value` as `key` on `Object.prototype`, run `run`, and remove it, whatever `run` does. */
function planted<T>(key: string, value: unknown, run: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
  try {
    return run()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

const GROUPS = Object.keys(GROUP_KEYS) as (keyof typeof GROUP_KEYS)[]
const TOP_LEVEL = Object.keys(OPTION_KEYS)
const GROUP_OPTIONS = GROUPS.flatMap((group) => Object.keys(GROUP_KEYS[group]).map((name) => [group, name] as const))

describe('a key planted on Object.prototype is not an option', () => {
  /** The copy of the options holds the keys the host gave and no other, for each option at the top level and in each group. */
  it.each(TOP_LEVEL)('leaves the top-level option %s out of the options when the host gave none', (name) => {
    const cleaned = planted(name, 'planted', () => withoutNullish({ ...BASE }))
    expect(Object.keys(cleaned).sort()).toEqual(Object.keys(BASE).sort())
  })

  it.each(GROUP_OPTIONS)('leaves the option %s.%s out of a group the host gave empty', (group, name) => {
    const cleaned = planted(name, 'planted', () => withoutNullish({ ...BASE, [group]: {} }))
    expect(Object.keys(cleaned[group] ?? {})).toEqual([])
  })

  /** A planted key never reaches the resolved options: the defaults stand. */
  it.each([
    ['pricing', 'strict', false, (o: ReturnType<typeof applyDefaults>) => o.pricing.strict, { seedFromSnapshot: true }, true],
    ['pricing', 'seedFromSnapshot', false, (o: ReturnType<typeof applyDefaults>) => o.pricing.seedFromSnapshot, { strict: true }, true],
    ['budgets', 'failClosed', false, (o: ReturnType<typeof applyDefaults>) => (o.budgets.enabled ? o.budgets.failClosed : 'off'), { defaultPolicy: 'block' }, true],
    ['settlement', 'enabled', false, (o: ReturnType<typeof applyDefaults>) => o.settlement.enabled, { graceSeconds: 5 }, true],
    ['wallets', 'overdraftNanoUsd', 999_999_999_999n, (o: ReturnType<typeof applyDefaults>) => (o.wallets.enabled ? o.wallets.overdraftNanoUsd : 'off'), { burnOrder: 'expiry' }, 0n],
    ['holds', 'ttlSeconds', 1, (o: ReturnType<typeof applyDefaults>) => o.holds.ttlSeconds, { reaperIntervalSeconds: 60 }, 3600],
    ['ledger', 'hashChain', true, (o: ReturnType<typeof applyDefaults>) => o.ledger.hashChain, {}, false],
  ] as const)('keeps the default of %s.%s when %s is planted and the host gave the group without it', (group, name, value, read, own, expected) => {
    const resolved = planted(name, value, () => applyDefaults({ ...BASE, [group]: own }))
    expect(read(resolved)).toBe(expected)
  })

  it.each([
    ['wallets', { creditRateNanoUsd: 1n }, (o: ReturnType<typeof applyDefaults>) => o.wallets.enabled, false],
    ['budgets', { defaultPolicy: 'block' }, (o: ReturnType<typeof applyDefaults>) => o.budgets.enabled, false],
    ['ratingMode', 'provider-reported', (o: ReturnType<typeof applyDefaults>) => o.ratingMode, 'rate-table'],
    ['markup', 1000, (o: ReturnType<typeof applyDefaults>) => o.markup, 1],
    ['currency', 'EUR', (o: ReturnType<typeof applyDefaults>) => o.currency, 'USD'],
  ] as const)('keeps the default of the top-level option %s when it is planted', (name, value, read, expected) => {
    expect(planted(name, value, () => read(applyDefaults({ ...BASE })))).toBe(expected)
  })

  /** What the host gave still wins over a planted key, and a getter of the host's own class still counts. */
  it('reads the value the host gave over a planted one', () => {
    const resolved = planted('strict', false, () => applyDefaults({ ...BASE, pricing: { strict: true } }))
    expect(resolved.pricing.strict).toBe(true)
  })

  it('reads an option that a class of the host defines with a getter', () => {
    class Pricing {
      get strict(): boolean {
        return Number('1') === 0
      }
    }
    const resolved = planted('strict', true, () => applyDefaults({ ...BASE, pricing: new Pricing() }))
    expect(resolved.pricing.strict).toBe(false)
  })

  /** The validators read the host's options, not the planted key: junk on the prototype refuses nothing the host did not write. */
  it.each([
    ['pricing', 'cacheTtlMs'],
    ['holds', 'ttlSeconds'],
    ['budgets', 'defaultPolicy'],
    ['budgets', 'alertThresholds'],
    ['settlement', 'graceSeconds'],
    ['reporting', 'maxExportRows'],
    ['content', 'ttlSeconds'],
    ['ledger', 'hashChain'],
  ] as const)('does not refuse a group of the host because %s.%s is planted with a bad value', (group, name) => {
    expect(() => planted(name, 'not-valid', () => validateOptions({ ...BASE, [group]: {} }))).not.toThrow()
  })

  it.each(['ratingMode', 'currency', 'markup', 'pricing', 'wallets', 'budgets', 'holds', 'settlement', 'ledger', 'events', 'fx', 'scopeResolver'])('does not refuse the options because the top-level option %s is planted with a bad value', (name) => {
    expect(() => planted(name, 'not-valid', () => validateOptions({ ...BASE }))).not.toThrow()
  })
})
