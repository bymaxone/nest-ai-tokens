import type { AiTokensErrorResponse } from '../../shared'
import type { AiTokensException } from '../errors'
import type { BymaxAiTokensModuleOptions, IAiTokensStore, IMarkupPolicy } from '../interfaces'
import { applyDefaults } from './apply-defaults'
import { validateOptions } from './validate-options'

/** A structurally-complete store stub; validation only checks method presence. */
function makeStore(): IAiTokensStore {
  const fn = (): Promise<never> => Promise.reject(new Error('stub'))
  return {
    append: fn,
    transition: fn,
    findByIdempotencyKey: fn,
    findById: fn,
    findExpiredHolds: fn,
    query: fn,
    sumCost: fn,
    lastHash: fn,
    resolveRate: fn,
    upsertPrice: fn,
    getPriceHistory: fn,
    listModels: fn,
    getWallet: fn,
    appendEntry: fn,
    conditionalDebit: fn,
    openGrants: fn,
    listEntries: fn,
    reconcile: fn,
    upsert: fn,
    remove: fn,
    findBudgetById: fn,
    findMatching: fn,
    conditionalConsume: fn,
    adjustWindow: fn,
    consumeWindowOnce: fn,
    adjustWindowOnce: fn,
    commitReference: fn,
    dropReference: fn,
    getWindow: fn,
    setWindowStart: fn,
  }
}

/** A ledger+pricing-only store (no wallet/budget methods) — a valid minimal store. */
function ledgerPricingStore(): IAiTokensStore {
  const fn = (): Promise<never> => Promise.reject(new Error('stub'))
  return {
    append: fn,
    transition: fn,
    findByIdempotencyKey: fn,
    findById: fn,
    findExpiredHolds: fn,
    query: fn,
    sumCost: fn,
    lastHash: fn,
    resolveRate: fn,
    upsertPrice: fn,
    getPriceHistory: fn,
    listModels: fn,
  }
}

function opts(overrides: Partial<BymaxAiTokensModuleOptions> = {}): BymaxAiTokensModuleOptions {
  return { store: makeStore(), ...overrides }
}

/** Capture the exception a validation call throws. */
function caught(fn: () => void): AiTokensException {
  try {
    fn()
  } catch (error) {
    return error as AiTokensException
  }
  throw new Error('expected validateOptions to throw')
}

function codeOf(exception: AiTokensException): string {
  return (exception.getResponse() as AiTokensErrorResponse).error.code
}

describe('validateOptions', () => {
  /** A minimal ledger+pricing store is valid. */
  it('accepts a minimal valid store', () => {
    expect(() => validateOptions(opts({ store: ledgerPricingStore() }))).not.toThrow()
  })

  /** A missing store is rejected. */
  it('rejects a missing store', () => {
    // Simulates a JS host passing no store.
    const exception = caught(() => validateOptions({} as BymaxAiTokensModuleOptions))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A store missing a required ledger method is rejected. */
  it('rejects a store missing a ledger method', () => {
    const store: Partial<IAiTokensStore> = { ...makeStore() }
    delete store.append
    const exception = caught(() => validateOptions(opts({ store: store as IAiTokensStore })))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A store missing a required pricing method is rejected. */
  it('rejects a store missing a pricing method', () => {
    const store: Partial<IAiTokensStore> = { ...makeStore() }
    delete store.resolveRate
    const exception = caught(() => validateOptions(opts({ store: store as IAiTokensStore })))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** Every method of every port table is required: a store missing exactly one of them is rejected. */
  it.each([
    ['ledger', {}, ['append', 'transition', 'findByIdempotencyKey', 'findById', 'findExpiredHolds', 'query', 'sumCost', 'lastHash']],
    ['pricing', {}, ['resolveRate', 'upsertPrice', 'getPriceHistory', 'listModels']],
    ['wallet', { wallets: {} }, ['getWallet', 'appendEntry', 'conditionalDebit', 'openGrants', 'listEntries', 'reconcile']],
    ['budget', { budgets: {} }, ['upsert', 'remove', 'findBudgetById', 'findMatching', 'conditionalConsume', 'adjustWindow', 'consumeWindowOnce', 'adjustWindowOnce', 'commitReference', 'dropReference', 'getWindow', 'setWindowStart']],
  ] as const)('requires every %s port method', (_port, feature, methods) => {
    for (const method of methods) {
      const { [method as keyof IAiTokensStore]: _removed, ...store } = makeStore()
      const exception = caught(() => validateOptions({ store: store as IAiTokensStore, ...feature }))
      expect({ method, code: codeOf(exception) }).toEqual({ method, code: 'AI_TOKENS_INVALID_CONFIG' })
    }
  })

  /** Enabling wallets without wallet store methods is rejected (feature-port validation). */
  it('rejects wallets enabled with a store missing conditionalDebit', () => {
    const exception = caught(() => validateOptions({ store: ledgerPricingStore(), wallets: {} }))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** Wallets with a complete store are accepted. */
  it('accepts wallets enabled with a complete store', () => {
    expect(() => validateOptions(opts({ wallets: {} }))).not.toThrow()
  })

  /** Enabling budgets without budget store methods is rejected. */
  it('rejects budgets enabled with a store missing budget methods', () => {
    const exception = caught(() => validateOptions({ store: ledgerPricingStore(), budgets: {} }))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** Budgets with a complete store are accepted. */
  it('accepts budgets enabled with a complete store', () => {
    expect(() => validateOptions(opts({ budgets: {} }))).not.toThrow()
  })

  /** A non-USD currency without an fx resolver raises FX_REQUIRED. */
  it('requires fx for a non-USD currency', () => {
    const exception = caught(() => validateOptions(opts({ currency: 'BRL' })))
    expect(codeOf(exception)).toBe('AI_TOKENS_FX_REQUIRED')
  })

  /** A non-USD currency with an fx resolver is accepted. */
  it('accepts a non-USD currency with fx', () => {
    expect(() => validateOptions(opts({ currency: 'BRL', fx: () => 5_000_000_000n }))).not.toThrow()
  })

  /** USD and an absent currency need no fx. */
  it('accepts USD and absent currency without fx', () => {
    expect(() => validateOptions(opts({ currency: 'USD' }))).not.toThrow()
    expect(() => validateOptions(opts({}))).not.toThrow()
  })

  /** An invalid numeric markup is rejected. */
  it.each([0, -1, Number.NaN])('rejects the invalid markup %p', (markup) => {
    const exception = caught(() => validateOptions(opts({ markup })))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** A valid numeric markup and a policy with resolve() are accepted. */
  it('accepts a valid markup and a resolve policy', () => {
    expect(() => validateOptions(opts({ markup: 4.0 }))).not.toThrow()
    expect(() => validateOptions(opts({ markup: { resolve: () => 2 } }))).not.toThrow()
  })

  /** A markup policy without a resolve method is rejected. */
  it('rejects a markup policy without resolve', () => {
    // Simulates a JS host passing a malformed policy.
    const exception = caught(() => validateOptions(opts({ markup: {} as IMarkupPolicy })))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** Alert thresholds outside (0, 1] are rejected. */
  it.each([[[1.5]], [[0]], [[-0.1]]])('rejects out-of-range alert thresholds %p', (alertThresholds) => {
    const exception = caught(() => validateOptions(opts({ budgets: { alertThresholds } })))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** In-range alert thresholds are accepted. */
  it('accepts in-range alert thresholds', () => {
    expect(() => validateOptions(opts({ budgets: { alertThresholds: [0.8, 1.0] } }))).not.toThrow()
  })

  /** A null store (JS caller omitting the field) is rejected — the guard covers both undefined and null. */
  it('rejects a null store', () => {
    const exception = caught(() => validateOptions({ store: null as unknown as IAiTokensStore }))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** Non-positive hold TTL or reaper interval is rejected. */
  it('rejects non-positive hold timings', () => {
    expect(codeOf(caught(() => validateOptions(opts({ holds: { ttlSeconds: 0 } }))))).toBe(
      'AI_TOKENS_INVALID_CONFIG',
    )
    expect(codeOf(caught(() => validateOptions(opts({ holds: { reaperIntervalSeconds: -1 } }))))).toBe(
      'AI_TOKENS_INVALID_CONFIG',
    )
  })

  /** Zero reaperIntervalSeconds is rejected (boundary: the condition is <= 0, not < 0). */
  it('rejects reaperIntervalSeconds of exactly 0', () => {
    expect(codeOf(caught(() => validateOptions(opts({ holds: { reaperIntervalSeconds: 0 } }))))).toBe(
      'AI_TOKENS_INVALID_CONFIG',
    )
  })

  /**
   * `setInterval` runs a delay above 2^31-1 ms, and NaN, every millisecond, so the reaper interval must be a finite
   * positive integer of at most 2,147,483 seconds, and the hold TTL, the content TTL and the export row cap finite
   * positive integers.
   */
  it.each([
    { option: 'holds.reaperIntervalSeconds', over: { holds: { reaperIntervalSeconds: Number.NaN } } },
    { option: 'holds.reaperIntervalSeconds', over: { holds: { reaperIntervalSeconds: Number.POSITIVE_INFINITY } } },
    { option: 'holds.reaperIntervalSeconds', over: { holds: { reaperIntervalSeconds: 2_147_484 } } },
    { option: 'holds.reaperIntervalSeconds', over: { holds: { reaperIntervalSeconds: 1.5 } } },
    { option: 'holds.ttlSeconds', over: { holds: { ttlSeconds: Number.NaN } } },
    { option: 'holds.ttlSeconds', over: { holds: { ttlSeconds: Number.POSITIVE_INFINITY } } },
    { option: 'holds.ttlSeconds', over: { holds: { ttlSeconds: 1.5 } } },
    { option: 'content.ttlSeconds', over: { content: { store: {} as never, ttlSeconds: Number.NaN } } },
    { option: 'content.ttlSeconds', over: { content: { store: {} as never, ttlSeconds: 0 } } },
    { option: 'reporting.maxExportRows', over: { reporting: { maxExportRows: Number.NaN } } },
    { option: 'reporting.maxExportRows', over: { reporting: { maxExportRows: 0 } } },
  ])('refuses $option when it is not a bounded positive integer', ({ option, over }) => {
    const exception = caught(() => validateOptions(opts(over)))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(JSON.stringify((exception).getResponse())).toContain(option)
  })

  /** Each bound is inclusive: 1 is accepted everywhere, and so is the largest value whose milliseconds stay safe. */
  it('accepts the smallest and the largest bounded values', () => {
    expect(() => validateOptions(opts({ holds: { ttlSeconds: 1, reaperIntervalSeconds: 1 } }))).not.toThrow()
    // The retention must exceed the hold TTL, so a TTL near its largest needs an explicit retention above it.
    expect(() => validateOptions(opts({ holds: { ttlSeconds: 2_147_483_646 }, settlement: { retentionSeconds: 2_147_483_647 } }))).not.toThrow()
    expect(() => validateOptions(opts({ content: { store: {} as never, ttlSeconds: 1 }, reporting: { maxExportRows: 1 } }))).not.toThrow()
    expect(() => validateOptions(opts({ reporting: { maxExportRows: Number.MAX_SAFE_INTEGER } }))).not.toThrow()
    expect(codeOf(caught(() => validateOptions(opts({ holds: { ttlSeconds: 2_147_483_648 } }))))).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(codeOf(caught(() => validateOptions(opts({ content: { store: {} as never, ttlSeconds: 2_147_483_648 } }))))).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(codeOf(caught(() => validateOptions(opts({ reporting: { maxExportRows: Number.MAX_SAFE_INTEGER + 2 } }))))).toBe('AI_TOKENS_INVALID_CONFIG')
  })

  /** The largest interval `setInterval` can run is accepted. */
  it('accepts a reaper interval of 2,147,483 seconds', () => {
    expect(() => validateOptions(opts({ holds: { reaperIntervalSeconds: 2_147_483 } }))).not.toThrow()
  })

  /** Positive hold timings are accepted. */
  it('accepts positive hold timings', () => {
    expect(() => validateOptions(opts({ holds: { ttlSeconds: 60, reaperIntervalSeconds: 30 } }))).not.toThrow()
  })

  /**
   * The settlement sweep's grace is a whole number of seconds from 1 to 2,147,483, and `enabled` a boolean: anything
   * else is refused at boot naming the option. The grace is a performance knob, so no relation to a timeout is checked.
   */
  it.each([
    { option: 'settlement.graceSeconds', over: { settlement: { graceSeconds: Number.NaN } } },
    { option: 'settlement.graceSeconds', over: { settlement: { graceSeconds: Number.POSITIVE_INFINITY } } },
    { option: 'settlement.graceSeconds', over: { settlement: { graceSeconds: 1.5 } } },
    { option: 'settlement.graceSeconds', over: { settlement: { graceSeconds: 0 } } },
    { option: 'settlement.graceSeconds', over: { settlement: { graceSeconds: -1 } } },
    { option: 'settlement.graceSeconds', over: { settlement: { graceSeconds: 2_147_484 } } },
    { option: 'settlement.graceSeconds', over: { settlement: { graceSeconds: '300' as unknown as number } } },
    { option: 'settlement.enabled', over: { settlement: { enabled: 'yes' as unknown as boolean } } },
  ])('refuses $option when it is not a valid setting', ({ option, over }) => {
    const exception = caught(() => validateOptions(opts(over)))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(JSON.stringify(exception.getResponse())).toContain(option)
  })

  /**
   * The retention of the budget applications is a whole number of seconds that exceeds both the grace and the hold TTL:
   * a key must stay replayable for as long as a sweep or a reaper may still judge its reference. Each relation is checked
   * on the effective values, the defaults included, and each refusal names `settlement.retentionSeconds`.
   */
  it.each([
    { name: 'NaN', over: { settlement: { retentionSeconds: Number.NaN } } },
    { name: 'a fraction', over: { settlement: { retentionSeconds: 1000.5 } } },
    { name: 'zero', over: { settlement: { retentionSeconds: 0 } } },
    { name: 'negative', over: { settlement: { retentionSeconds: -1 } } },
    { name: 'a string', over: { settlement: { retentionSeconds: '604800' as unknown as number } } },
    { name: 'above the largest', over: { settlement: { retentionSeconds: 2_147_483_648 } } },
    { name: 'equal to the grace', over: { settlement: { graceSeconds: 1_000, retentionSeconds: 1_000 } } },
    { name: 'below the grace', over: { settlement: { graceSeconds: 1_000, retentionSeconds: 999 } } },
    { name: 'equal to the hold TTL', over: { holds: { ttlSeconds: 7_200 }, settlement: { retentionSeconds: 7_200 } } },
    { name: 'below the hold TTL', over: { holds: { ttlSeconds: 7_200 }, settlement: { retentionSeconds: 7_199 } } },
    { name: 'the default, with a grace above it', over: { settlement: { graceSeconds: 604_800 } } },
    { name: 'the default, with a hold TTL above it and no settlement section', over: { holds: { ttlSeconds: 700_000 } } },
  ])('refuses a retention that is $name', ({ over }) => {
    const exception = caught(() => validateOptions(opts(over)))
    expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(JSON.stringify(exception.getResponse())).toContain('settlement.retentionSeconds')
  })

  it('accepts a retention one second above both the grace and the hold TTL', () => {
    expect(() => validateOptions(opts({ holds: { ttlSeconds: 7_200 }, settlement: { graceSeconds: 7_200, retentionSeconds: 7_201 } }))).not.toThrow()
    expect(() => validateOptions(opts({ holds: { ttlSeconds: 604_799 } }))).not.toThrow()
  })

  /** The smallest and the largest grace, an omitted section and a disabled sweep are accepted. */
  it('accepts the bounds of the settlement grace and a disabled sweep', () => {
    expect(() => validateOptions(opts({ settlement: { graceSeconds: 1 } }))).not.toThrow()
    expect(() => validateOptions(opts({ settlement: { graceSeconds: 2_147_483, retentionSeconds: 2_147_484 } }))).not.toThrow()
    expect(() => validateOptions(opts({ settlement: { enabled: false } }))).not.toThrow()
    expect(() => validateOptions(opts({}))).not.toThrow()
  })

  /** The sweep is on by default with a grace of 300 seconds, and an explicit setting replaces each default. */
  it('resolves the settlement defaults and keeps an explicit setting', () => {
    expect(applyDefaults(opts({})).settlement).toEqual({ enabled: true, graceSeconds: 300, retentionSeconds: 604_800 })
    expect(applyDefaults(opts({ settlement: { enabled: false, graceSeconds: 60, retentionSeconds: 3_600 } })).settlement).toEqual({ enabled: false, graceSeconds: 60, retentionSeconds: 3_600 })
  })

  /** A non-positive credit rate or negative overdraft is rejected. */
  it('rejects invalid wallet amounts', () => {
    expect(codeOf(caught(() => validateOptions(opts({ wallets: { creditRateNanoUsd: 0n } }))))).toBe(
      'AI_TOKENS_INVALID_CONFIG',
    )
    expect(codeOf(caught(() => validateOptions(opts({ wallets: { overdraftNanoUsd: -1n } }))))).toBe(
      'AI_TOKENS_INVALID_CONFIG',
    )
  })

  /** Valid wallet amounts are accepted. */
  it('accepts valid wallet amounts', () => {
    expect(() =>
      validateOptions(opts({ wallets: { creditRateNanoUsd: 5_000_000_000n, overdraftNanoUsd: 0n } })),
    ).not.toThrow()
  })

  /** A zero, negative, non-integer, or non-finite pricing.cacheTtlMs is rejected (divisor safety). */
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the invalid pricing.cacheTtlMs %p',
    (cacheTtlMs) => {
      const exception = caught(() => validateOptions(opts({ pricing: { cacheTtlMs } })))
      expect(codeOf(exception)).toBe('AI_TOKENS_INVALID_CONFIG')
    },
  )

  /** A positive integer cacheTtlMs, and an absent pricing block, are accepted. */
  it('accepts a positive integer cacheTtlMs and an absent pricing block', () => {
    expect(() => validateOptions(opts({ pricing: { cacheTtlMs: 300_000 } }))).not.toThrow()
    expect(() => validateOptions(opts({}))).not.toThrow()
  })
})

describe('applyDefaults', () => {
  /** With only a store, every default from §4.2 is resolved. */
  it('resolves the full default set', () => {
    const resolved = applyDefaults(opts({}))
    expect(resolved.ratingMode).toBe('rate-table')
    expect(resolved.currency).toBe('USD')
    expect(resolved.markup).toBe(1.0)
    expect(resolved.pricing).toEqual({
      seedFromSnapshot: true,
      strict: true,
      cacheTtlMs: 300_000,
      modelAliases: {},
    })
    expect(resolved.holds).toEqual({ ttlSeconds: 3_600, reaperIntervalSeconds: 300 })
    expect(resolved.ledger).toEqual({ hashChain: false })
    expect(resolved.events).toEqual({ emitter: true, sink: undefined })
    expect(resolved.reporting).toEqual({ maxExportRows: 1_000_000 })
    expect(resolved.wallets).toEqual({ enabled: false })
    expect(resolved.budgets).toEqual({ enabled: false })
    expect(resolved.telemetry).toEqual({ enabled: false })
    expect(resolved.content).toEqual({ enabled: false })
  })

  /** The resolved object is frozen. */
  it('freezes the resolved options', () => {
    expect(Object.isFrozen(applyDefaults(opts({})))).toBe(true)
  })

  /** A numeric markup is rounded to 4 dp; a policy is carried through. */
  it('resolves the markup', () => {
    expect(applyDefaults(opts({ markup: 1.23456 })).markup).toBe(1.2346)
    const policy: IMarkupPolicy = { resolve: () => 2 }
    expect(applyDefaults(opts({ markup: policy })).markup).toBe(policy)
  })

  /** Enabling wallets resolves its defaults and provided values. */
  it('resolves the wallet feature', () => {
    expect(applyDefaults(opts({ wallets: {} })).wallets).toEqual({
      enabled: true,
      creditRateNanoUsd: 1_000_000_000n,
      overdraftNanoUsd: 0n,
      burnOrder: 'expiry',
    })
    expect(applyDefaults(opts({ wallets: { creditRateNanoUsd: 5n, overdraftNanoUsd: 2n, burnOrder: 'fifo' } })).wallets).toEqual(
      { enabled: true, creditRateNanoUsd: 5n, overdraftNanoUsd: 2n, burnOrder: 'fifo' },
    )
  })

  /** Enabling budgets resolves defaults and carries counter/onThrottle. */
  it('resolves the budget feature', () => {
    expect(applyDefaults(opts({ budgets: {} })).budgets).toEqual({
      enabled: true,
      defaultPolicy: 'block',
      alertThresholds: [0.8, 1.0],
      failClosed: true,
      counter: undefined,
      onThrottle: undefined,
    })
    const onThrottle = jest.fn()
    const resolved = applyDefaults(opts({ budgets: { defaultPolicy: 'throttle', failClosed: false, onThrottle } }))
    expect(resolved.budgets).toMatchObject({ enabled: true, defaultPolicy: 'throttle', failClosed: false, onThrottle })
  })

  /** Telemetry is enabled only when a sink is present. */
  it('resolves the telemetry feature', () => {
    const sink = { recordUsage: (): void => undefined }
    expect(applyDefaults(opts({ telemetry: { sink } })).telemetry).toEqual({ enabled: true, sink, metrics: true })
    expect(applyDefaults(opts({ telemetry: { sink, metrics: false } })).telemetry).toEqual({
      enabled: true,
      sink,
      metrics: false,
    })
    expect(applyDefaults(opts({ telemetry: {} })).telemetry).toEqual({ enabled: false })
  })

  /** The content sidecar resolves store, mask, and TTL. */
  it('resolves the content feature', () => {
    const store = { put: async (): Promise<void> => undefined, purge: async (): Promise<number> => 0 }
    expect(applyDefaults(opts({ content: { store } })).content).toEqual({
      enabled: true,
      store,
      mask: undefined,
      ttlSeconds: 604_800,
    })
    const mask = (text: string): string => text
    expect(applyDefaults(opts({ content: { store, mask, ttlSeconds: 60 } })).content).toEqual({
      enabled: true,
      store,
      mask,
      ttlSeconds: 60,
    })
  })

  /** Scalar blocks and passthrough fields resolve to provided values. */
  it('resolves scalar blocks and passthrough fields', () => {
    const scopeResolver = jest.fn()
    const fx = (): bigint => 1n
    const tokenizer = { countTokens: (): number => 1 }
    const resolved = applyDefaults({
      store: makeStore(),
      ratingMode: 'provider-reported',
      currency: 'EUR',
      fx,
      scopeResolver,
      tokenizer,
      pricing: { strict: false, cacheTtlMs: 10, seedFromSnapshot: false, modelAliases: { a: 'b' } },
      holds: { ttlSeconds: 5 },
      ledger: { hashChain: true },
      events: { emitter: false },
      reporting: { maxExportRows: 7 },
    })
    expect(resolved.ratingMode).toBe('provider-reported')
    expect(resolved.currency).toBe('EUR')
    expect(resolved.fx).toBe(fx)
    expect(resolved.scopeResolver).toBe(scopeResolver)
    expect(resolved.tokenizer).toBe(tokenizer)
    expect(resolved.pricing).toEqual({ strict: false, cacheTtlMs: 10, seedFromSnapshot: false, modelAliases: { a: 'b' } })
    expect(resolved.holds).toEqual({ ttlSeconds: 5, reaperIntervalSeconds: 300 })
    expect(resolved.ledger).toEqual({ hashChain: true })
    expect(resolved.events).toEqual({ emitter: false, sink: undefined })
    expect(resolved.reporting).toEqual({ maxExportRows: 7 })
  })
})
