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
    findMatching: fn,
    conditionalConsume: fn,
    adjustWindow: fn,
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

  /** Non-positive hold TTL or reaper interval is rejected. */
  it('rejects non-positive hold timings', () => {
    expect(codeOf(caught(() => validateOptions(opts({ holds: { ttlSeconds: 0 } }))))).toBe(
      'AI_TOKENS_INVALID_CONFIG',
    )
    expect(codeOf(caught(() => validateOptions(opts({ holds: { reaperIntervalSeconds: -1 } }))))).toBe(
      'AI_TOKENS_INVALID_CONFIG',
    )
  })

  /** Positive hold timings are accepted. */
  it('accepts positive hold timings', () => {
    expect(() => validateOptions(opts({ holds: { ttlSeconds: 60, reaperIntervalSeconds: 30 } }))).not.toThrow()
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
