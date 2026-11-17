/**
 * @fileoverview A misconfiguration never means "no limit". A budget policy or a rating mode that is not a documented value is
 * refused with the typed error and a message that names the documented values and never the value given; a stored policy that is
 * not a documented value is evaluated as `block`, so a row written before the check, or edited in the database, still stops
 * spending at the limit; and a group of options set to null is absent, as it is when undefined.
 * @layer server
 */

import { TENANT, USER_SCOPE, budgetInput, context, makeService } from '../test/fakes/budget-fixtures'
import { makeFullStore } from '../test/fakes/full-store'
import { applyDefaults, validateOptions } from './server/config'
import { BymaxAiTokensModule } from './server/bymax-ai-tokens.module'
import { AiTokensException } from './server/errors'

/** A string no documented value contains, to show a refusal never repeats what it was given. */
const MARKER = 'blocc-9876543'
const BAD_POLICIES: readonly unknown[] = ['blocc', 'BLOCK', '', ' block', 'block ', MARKER, 5, true, {}, []]
const POLICIES = ['block', 'throttle', 'allow'] as const
const withStore = { store: makeFullStore(true) }

/** The exception `run` throws or rejects with; fails when it neither throws nor rejects. */
async function refusal(run: () => unknown): Promise<AiTokensException> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AiTokensException) return error
    throw error
  }
  throw new Error('expected the call to be refused')
}

/** Assert the refusal is the typed invalid-configuration error, names the option, and carries none of the value. */
async function expectRefused(run: () => unknown, option: string): Promise<void> {
  const body = JSON.stringify((await refusal(run)).getResponse())
  expect(body).toContain('AI_TOKENS_INVALID_CONFIG')
  expect(body).toContain(option)
  expect(body).not.toContain(MARKER)
}

describe('budget policy at startup and at upsert', () => {
  it.each(BAD_POLICIES)('refuses budgets.defaultPolicy %p', async (value) => {
    await expectRefused(() => validateOptions({ ...withStore, budgets: { defaultPolicy: value } } as never), 'budgets.defaultPolicy')
  })

  it.each(BAD_POLICIES)('refuses the policy %p of a budget at upsert', async (value) => {
    const { service } = makeService()
    await expectRefused(() => service.upsertBudget(budgetInput({ policy: value } as never)), 'policy')
  })

  it.each([...POLICIES, undefined, null])('accepts the documented policy or none: %p', async (value) => {
    expect(() => validateOptions({ ...withStore, budgets: { defaultPolicy: value } } as never)).not.toThrow()
    const { service } = makeService()
    await expect(service.upsertBudget(budgetInput({ policy: value } as never))).resolves.toBeDefined()
  })
})

describe('a stored policy that is not a documented value', () => {
  /** Invariant: a row with a mistyped policy never lets spending pass the limit, whatever wrote it. */
  it.each(['blocc', 'BLOCK', '', ' block'])('is evaluated as block: %p', async (policy) => {
    const { service, store } = makeService()
    const budget = await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
    await store.upsert({ ...budget, policy } as never)
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      try {
        await service.consume(context(), { nanoUsd: 60n, tokens: 0, count: 0 })
        outcomes.push('ok')
      } catch (error) {
        outcomes.push((error as { response?: { error?: { code?: string } } }).response?.error?.code ?? 'raw')
      }
    }
    expect(outcomes).toEqual(['ok', 'AI_TOKENS_BUDGET_EXCEEDED', 'AI_TOKENS_BUDGET_EXCEEDED'])
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.spent.nanoUsd).toBe(60n)
    expect(status?.policy).toBe('block')
  })

  /** The documented soft policies keep passing the limit, so the defence changes nothing for a documented value. */
  it.each(['allow', 'throttle'] as const)('leaves the documented %s policy soft', async (policy) => {
    const { service } = makeService()
    await service.upsertBudget(budgetInput({ policy, limitNanoUsd: 100n }))
    for (let i = 0; i < 3; i++) await expect(service.consume(context(), { nanoUsd: 60n, tokens: 0, count: 0 })).resolves.toBeUndefined()
    const [status] = await service.status(TENANT, USER_SCOPE)
    expect(status?.spent.nanoUsd).toBe(180n)
    expect(status?.policy).toBe(policy)
  })
})

describe('rating mode', () => {
  it.each(['calc', 'Rate-Table', '', 'provider_reported', MARKER, 5, true])('refuses ratingMode %p', async (value) => {
    await expectRefused(() => validateOptions({ ...withStore, ratingMode: value } as never), 'ratingMode')
  })

  it.each(['rate-table', 'provider-reported', undefined, null])('accepts the documented mode or none: %p', (value) => {
    expect(() => validateOptions({ ...withStore, ratingMode: value } as never)).not.toThrow()
    expect(applyDefaults({ ...withStore, ratingMode: value } as never).ratingMode).toBe(value ?? 'rate-table')
  })
})

describe('a group of options set to null', () => {
  const GROUPS = ['pricing', 'holds', 'settlement', 'events', 'telemetry', 'reporting', 'content'] as const

  it.each(GROUPS)('resolves %s as absent, as undefined does', (group) => {
    const withNull = { ...withStore, [group]: null } as never
    const withUndefined = { ...withStore, [group]: undefined } as never
    expect(() => validateOptions(withNull)).not.toThrow()
    expect(applyDefaults(withNull)).toEqual(applyDefaults(withUndefined))
  })

  /** An option inside a group that is null or undefined takes its default, and does not switch the option off. */
  it.each([null, undefined])('resolves a defaulted option set to %p as its default', (value) => {
    const resolved = applyDefaults({
      ...withStore,
      wallets: { overdraftNanoUsd: value, burnOrder: value, creditRateNanoUsd: value },
      budgets: { defaultPolicy: value, failClosed: value, alertThresholds: value },
      holds: { ttlSeconds: value, reaperIntervalSeconds: value },
      settlement: { enabled: value, graceSeconds: value, retentionSeconds: value },
      pricing: { strict: value, cacheTtlMs: value, seedFromSnapshot: value },
      ledger: { hashChain: undefined },
      reporting: { maxExportRows: value },
    } as never)
    expect(resolved.wallets).toMatchObject({ creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' })
    expect(resolved.budgets).toMatchObject({ defaultPolicy: 'block', failClosed: true, alertThresholds: [0.8, 1] })
    expect(resolved.holds).toMatchObject({ ttlSeconds: 3_600, reaperIntervalSeconds: 300 })
    expect(resolved.settlement).toMatchObject({ enabled: true, graceSeconds: 300, retentionSeconds: 604_800 })
    expect(resolved.pricing).toMatchObject({ strict: true, cacheTtlMs: 300_000, seedFromSnapshot: true })
    expect(resolved.ledger).toEqual({ hashChain: false })
    expect(resolved.reporting).toMatchObject({ maxExportRows: 1_000_000 })
    expect(resolved).toEqual(applyDefaults({ ...withStore, wallets: {}, budgets: {}, holds: {}, settlement: {}, pricing: {}, ledger: {}, reporting: {} }))
  })
})

/** A group of options built by a class, whose values are getters of the prototype and so are not own keys of the object. */
class BudgetsFromClass {
  private readonly unset: unknown = null
  constructor(private readonly policy: unknown) {}
  get defaultPolicy(): unknown {
    return this.policy
  }
  get failClosed(): unknown {
    return this.unset
  }
}

/** A ledger group built by a class, whose integrity-chain flag is a getter of the prototype that holds null. */
class LedgerFromClass {
  private readonly unset: unknown = null
  get hashChain(): unknown {
    return this.unset
  }
}

/** The options themselves built by a class, with the rating mode a getter of the prototype. */
class OptionsFromClass {
  readonly store = makeFullStore(true)
  constructor(private readonly mode: unknown) {}
  get ratingMode(): unknown {
    return this.mode
  }
}

/** A wallets group whose only option is a getter of the prototype that holds null. */
class UnsetBurnOrder {
  private readonly unset: unknown = null
  get burnOrder(): unknown {
    return this.unset
  }
}

describe('a value that sits on the prototype is read as one that sits on the object', () => {
  it.each(BAD_POLICIES)('refuses the default policy %p of a group that is a class instance', async (value) => {
    await expectRefused(() => validateOptions({ ...withStore, budgets: new BudgetsFromClass(value) } as never), 'budgets.defaultPolicy')
  })

  it('resolves the null getters of a class-instance group to their defaults', () => {
    const resolved = applyDefaults({ ...withStore, budgets: new BudgetsFromClass(null) } as never)
    expect(resolved.budgets).toMatchObject({ enabled: true, defaultPolicy: 'block', failClosed: true })
  })

  it.each(['calc', MARKER, 5])('refuses the rating mode %p of an options object that is a class instance', async (value) => {
    await expectRefused(() => validateOptions(new OptionsFromClass(value) as never), 'ratingMode')
  })

  it.each([['provider-reported', 'provider-reported'], [null, 'rate-table'], [undefined, 'rate-table']])('resolves the getter %p of a class-instance options object to %p', (value, expected) => {
    expect(applyDefaults(new OptionsFromClass(value) as never).ratingMode).toBe(expected)
  })

  it('resolves a group that is a class instance with all its getters null as enabled with the defaults', () => {
    expect(applyDefaults({ ...withStore, wallets: new UnsetBurnOrder() } as never).wallets).toMatchObject({ enabled: true, burnOrder: 'expiry' })
  })
})

describe('the module entry point', () => {
  it('refuses a mistyped default policy at forRoot, and a budgets group set to null', async () => {
    await expectRefused(() => BymaxAiTokensModule.forRoot({ ...withStore, wallets: {}, budgets: { defaultPolicy: 'blocc' } } as never), 'budgets.defaultPolicy')
    await expectRefused(() => BymaxAiTokensModule.forRoot({ ...withStore, budgets: null } as never), 'budgets')
  })
})

/** A protection that the library leaves off when the option is omitted: a null there is refused, never read as off. */
describe('the integrity chain of the ledger set to null', () => {
  it('refuses ledger.hashChain null, naming the option, with the value never echoed', async () => {
    await expectRefused(() => validateOptions({ ...withStore, ledger: { hashChain: null } } as never), 'ledger.hashChain')
  })

  it('refuses a null that sits on the prototype of a ledger group that is a class instance', async () => {
    await expectRefused(() => validateOptions({ ...withStore, ledger: new LedgerFromClass() } as never), 'ledger.hashChain')
  })

  it('refuses it at forRoot too', async () => {
    await expectRefused(() => BymaxAiTokensModule.forRoot({ ...withStore, ledger: { hashChain: null } } as never), 'ledger.hashChain')
  })

  /** Omitted and `undefined` keep the default, a boolean is taken as it is, and a ledger group that is itself null is absent. */
  it.each([[undefined, false], [true, true], [false, false]])('takes ledger.hashChain %p as %p', (value, expected) => {
    const options = { ...withStore, ledger: { hashChain: value } } as never
    expect(() => validateOptions(options)).not.toThrow()
    expect(applyDefaults(options).ledger).toEqual({ hashChain: expected })
  })

  /** A ledger value that is not a group is left to the other checks: reading its chain flag must not raise a raw error. */
  it('does not read the chain flag of a ledger value that is not a group', () => {
    expect(() => validateOptions({ ...withStore, ledger: 'yes' } as never)).not.toThrow()
  })

  /** A ledger group that failed to load as null would leave the chain off, so it is refused as the flag is; left out or undefined keeps the default. */
  it('refuses a ledger group set to null, naming the option, and takes one left out or undefined as the default', async () => {
    await expectRefused(() => validateOptions({ ...withStore, ledger: null } as never), 'ledger')
    await expectRefused(() => BymaxAiTokensModule.forRoot({ ...withStore, ledger: null } as never), 'ledger')
    for (const ledger of [undefined]) {
      expect(() => validateOptions({ ...withStore, ledger } as never)).not.toThrow()
      expect(applyDefaults({ ...withStore, ledger } as never).ledger).toEqual({ hashChain: false })
    }
    expect(() => validateOptions(withStore as never)).not.toThrow()
  })
})

/** A group whose omission means "no limit" or "no protection" refuses null: a configuration that failed to load must not remove it. */
describe.each(['budgets', 'wallets', 'ledger'] as const)('the %s group set to null', (group) => {
  it('is refused at startup and at forRoot, the option named and no value echoed', async () => {
    await expectRefused(() => validateOptions({ ...withStore, [group]: null }), group)
    await expectRefused(() => BymaxAiTokensModule.forRoot({ ...withStore, [group]: null }), group)
  })

  /** Left out or undefined keeps the feature off, as it is by default. */
  it.each([undefined, 'omitted'])('keeps the default when it is %p', (value) => {
    const options = value === 'omitted' ? withStore : { ...withStore, [group]: value }
    expect(() => validateOptions(options as never)).not.toThrow()
    expect(applyDefaults(options as never)[group]).toEqual(applyDefaults(withStore as never)[group])
  })
})

