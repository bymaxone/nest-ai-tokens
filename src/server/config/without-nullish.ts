/**
 * @fileoverview A copy of the module options without the keys that hold `undefined` or `null`, at the top level and inside each
 * group of options, so that an option left out, set to `undefined` or set to `null` all mean the same thing: the default. A
 * group set to `null` is absent, and an option inside a group set to `null` is absent from it; neither switches anything off.
 *
 * Each key the options define is read as a field of the object (see `fieldOf`), so a value that sits on the prototype of the host's class (a
 * getter of a class instance, a group built by a factory) is read as one that sits on the object, and a key on `Object.prototype` is not; the keys are listed once per group, and the compiler refuses
 * a list that misses an option or names one that does not exist.
 * @layer server
 */

import type { BymaxAiTokensModuleOptions } from '../interfaces'
import { fieldOf } from '../utils/field-names'

type Options = BymaxAiTokensModuleOptions

/** Every key of `T` mapped to `true`, so that a list built from it names each key exactly once and the compiler checks it. */
type Keys<T> = { readonly [K in keyof Required<T>]: true }

/** The groups of options, whose own keys are cleaned too. */
type GroupName = 'pricing' | 'wallets' | 'budgets' | 'holds' | 'settlement' | 'ledger' | 'events' | 'telemetry' | 'reporting' | 'content'

/** Every option the module takes at the top level. */
export const OPTION_KEYS: Keys<Options> = {
  store: true,
  scopeResolver: true,
  ratingMode: true,
  currency: true,
  fx: true,
  markup: true,
  pricing: true,
  wallets: true,
  budgets: true,
  holds: true,
  settlement: true,
  ledger: true,
  tokenizer: true,
  events: true,
  telemetry: true,
  reporting: true,
  content: true,
}

/** Every option inside each group. */
export const GROUP_KEYS: { readonly [G in GroupName]: Keys<NonNullable<Options[G]>> } = {
  pricing: { seedFromSnapshot: true, strict: true, cacheTtlMs: true, modelAliases: true },
  wallets: { creditRateNanoUsd: true, overdraftNanoUsd: true, burnOrder: true },
  budgets: { defaultPolicy: true, alertThresholds: true, counter: true, failClosed: true, onThrottle: true },
  holds: { ttlSeconds: true, reaperIntervalSeconds: true },
  settlement: { enabled: true, graceSeconds: true, retentionSeconds: true },
  ledger: { hashChain: true },
  events: { emitter: true, sink: true },
  telemetry: { sink: true, metrics: true },
  reporting: { maxExportRows: true },
  content: { store: true, mask: true, ttlSeconds: true },
}

/** A copy of `source` with the entries of `names` that it holds a value for, read as fields (see `fieldOf`): a getter of the host's class counts, a key of `Object.prototype` does not. */
function valuesOf<T extends object>(source: T, names: Keys<T>): T {
  // No prototype: a key that another library planted on `Object.prototype` is not an option the host gave, and a read of this copy never finds one.
  const kept = Object.create(null) as Record<string, unknown>
  for (const name of Object.keys(names)) {
    const value: unknown = fieldOf(source, name)
    if (value !== undefined && value !== null) kept[name] = value
  }
  return kept as T
}

/**
 * Drop the keys holding `undefined` or `null` from the options and from each of their groups.
 *
 * @param options The options as the host gave them.
 * @returns A copy in which every key that is present holds a value.
 */
export function withoutNullish(options: Options): Options {
  const top = valuesOf(options, OPTION_KEYS)
  const groups: Record<string, object> = {}
  for (const group of Object.keys(GROUP_KEYS) as GroupName[]) {
    const value = top[group]
    if (typeof value === 'object' && !Array.isArray(value)) groups[group] = valuesOf<object>(value, GROUP_KEYS[group])
  }
  return Object.assign(top, groups)
}
