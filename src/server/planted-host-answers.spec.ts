/**
 * @fileoverview A host answer or a store answer that is planted for one read must never decide an enforcement, a price or a usage count: an
 * over-limit consume stays refused when a one-shot `Array.prototype.map`/`push` or `then` was planted by the store, and a promise a scope
 * resolver, a markup policy, a tokenizer or an fx function returns is refused when it reads a constructor or `then` of its own.
 * @layer server
 */

import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import { context, makeService, TENANT, USER_SCOPE, budgetInput } from '../../test/fakes/budget-fixtures'
import { unplant } from '../../test/fakes/promise-plant'
import { AiTokensException } from './errors'
import { SqlExecutor, waited } from '../prisma/raw-client'
import { awaitStatement } from '../prisma/adapter-sql'
import { sql } from '../prisma/sql'
import { settled } from './utils/host-settled'
import { MarkupResolver } from './services/markup.resolver'
import { StreamUsageCollector } from './streaming/stream-usage-collector'
import { setRealmGuard } from './utils/prototype-guard'

// These rows plant members on the intrinsics to prove what the library does when a host does; the realm guard would refuse them first.
beforeAll(() => setRealmGuard(false))
afterAll(() => setRealmGuard(true))
afterEach(() => unplant())

const ARRAY = Array.prototype as unknown as Record<string, unknown>

/** Over-limit service with `hook` run inside the store's first call to `method`. */
async function exhausted(method: 'findMatching' | 'getWindow', hook: () => void): Promise<ReturnType<typeof makeService>> {
  const built = makeService()
  await built.service.upsertBudget(budgetInput({ limitNanoUsd: 100n, window: 'month' }))
  await built.service.consume(context(), { nanoUsd: 100n, tokens: 0, count: 0 })
  const original = built.store[method].bind(built.store) as (...args: unknown[]) => unknown
  let armed = true
  ;(built.store as unknown as Record<string, unknown>)[method] = (...args: unknown[]): unknown => {
    if (armed) {
      armed = false
      hook()
    }
    return original(...args)
  }
  return built
}

/** Swap a member of Array.prototype for one call, then put the original back. */
function plantArray(name: string, replacement: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(Array.prototype, name)
  return () => {
    Object.defineProperty(Array.prototype, name, { value: replacement, configurable: true, writable: true })
    ARRAY.__restore = (): void => {
      if (original === undefined) Reflect.deleteProperty(Array.prototype, name)
      else Object.defineProperty(Array.prototype, name, original)
    }
  }
}

/** Lift whatever a row planted on Array.prototype, so the matchers that follow run on the real intrinsics. */
function restorePlants(): void {
  const restore = ARRAY.__restore as (() => void) | undefined
  restore?.()
  Reflect.deleteProperty(Array.prototype, '__restore')
  Reflect.deleteProperty(Array.prototype, 'then')
}
afterEach(restorePlants)

/** What the call ended with, read before the plants are lifted: the value, or the error it rejected with. */
async function outcomeOf(call: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  let outcome: { value?: unknown; error?: unknown }
  try {
    outcome = { value: await call }
  } catch (error) {
    outcome = { error }
  }
  restorePlants()
  return outcome
}

describe('a member planted on Array.prototype by the store does not let an over-limit consume through', () => {
  it('refuses when Array.prototype.map answers nothing', async () => {
    const built = await exhausted('findMatching', plantArray('map', function () { return [] }))
    expect((await outcomeOf(built.service.consume(context(), { nanoUsd: 1n, tokens: 0, count: 0 }))).error).toBeInstanceOf(AiTokensException)
  })

  it('refuses when Array.prototype.filter answers nothing', async () => {
    const built = await exhausted('findMatching', plantArray('filter', function () { return [] }))
    expect((await outcomeOf(built.service.consume(context(), { nanoUsd: 1n, tokens: 0, count: 0 }))).error).toBeInstanceOf(AiTokensException)
  })

  it('refuses when Array.prototype.then resolves an empty list', async () => {
    const built = await exhausted('findMatching', () => {
      Object.defineProperty(Array.prototype, 'then', {
        configurable: true,
        value(resolve: (value: unknown[]) => void): void {
          Reflect.deleteProperty(Array.prototype, 'then')
          resolve([])
        },
      })
    })
    expect((await outcomeOf(built.service.consume(context(), { nanoUsd: 1n, tokens: 0, count: 0 }))).error).toBeInstanceOf(AiTokensException)
  })

  it('refuses the call or reports the exhausted budget when Array.prototype.push does nothing', async () => {
    const built = await exhausted('getWindow', plantArray('push', function () { return 0 }))
    const { value, error } = await outcomeOf(built.service.status(TENANT, USER_SCOPE))
    // Either the call is refused, or it reports the one budget there is, at its limit: an empty answer would read as no budget.
    if (error === undefined) {
      expect(value).toHaveLength(1)
      expect((value as { usedFraction: number }[])[0]?.usedFraction).toBe(1)
    } else {
      expect(error).toBeInstanceOf(AiTokensException)
    }
  })
})

describe('a store answer that is no list never reads as no budget', () => {
  /** No budget row means unlimited, so an answer that is no array must refuse the call and not enforce nothing. */
  it.each([[{}], [{ length: 0 }], ['']])('refuses consume, status and list when findMatching answers %j', async (answer) => {
    const built = makeService()
    await built.service.upsertBudget(budgetInput({ limitNanoUsd: 100n, window: 'month' }))
    ;(built.store as unknown as Record<string, unknown>).findMatching = () => Promise.resolve(answer)
    await expect(built.service.consume(context(), { nanoUsd: 1n, tokens: 0, count: 0 })).rejects.toBeInstanceOf(AiTokensException)
    await expect(built.service.status(TENANT, USER_SCOPE)).rejects.toBeInstanceOf(AiTokensException)
    await expect(built.service.list(TENANT)).rejects.toBeInstanceOf(AiTokensException)
  })
})

/** A native promise of `value` whose `then` is its own: the host's driver answers through it when the library waits. */
function forging<T>(value: T, forged: unknown): Promise<T> {
  const promise = Promise.resolve(value)
  Reflect.defineProperty(promise, 'then', { value: (resolve: (answer: unknown) => void): void => resolve(forged) })
  return promise
}

/** The call has already run the host code, so the plant is lifted before the test itself awaits anything. */
async function refused(call: Promise<unknown>): Promise<void> {
  unplant()
  await expect(call).rejects.toBeInstanceOf(AiTokensException)
}

describe('a promise a host function returns is refused when it reads a constructor or then of its own', () => {
  it('refuses a markup policy answer', async () => {
    const resolver = new MarkupResolver({ markup: { resolve: () => forging(2, 0.0001) } })
    await refused(resolver.resolve({ ...context(), provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard' } as never))
  })

  it('refuses a tokenizer answer', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: { countTokens: () => forging(50, 0) } })
    collector.push({ choices: [{ delta: { content: 'one two three' } }] })
    await refused(collector.finalize())
  })

  it('refuses a scope resolver answer', async () => {
    const { BudgetGuard } = await import('./enforcement/budget.guard')
    const built = makeService()
    const guard = new BudgetGuard(
      built.service,
      { holdFor: () => undefined } as never,
      new Reflector(),
      { scopeResolver: () => forging(context(), context({ tenantId: 'other' })) },
    )
    const executionContext = { getHandler: () => () => undefined, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({}) }) } as unknown as ExecutionContext
    await refused(guard.canActivate(executionContext))
  })
})

/** A promise that, as it settles, replaces `Array.prototype.push`: the host's code ran while the library waited, and left nothing but the replacement. */
function replacingWhileSettling(): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => {
      plantArray('push', function () { return 0 })()
      resolve(1)
    }, 0)
  })
}

describe('what a host did while the library waited for it is checked once the wait is over', () => {
  it('refuses a host answer after the arrays the library reads were replaced during the wait', async () => {
    expect((await outcomeOf(settled(replacingWhileSettling()))).error).toBeInstanceOf(AiTokensException)
  })

  it('refuses a driver answer after the arrays the library reads were replaced during the wait', async () => {
    const executor = new SqlExecutor({ $queryRawUnsafe: () => replacingWhileSettling(), $executeRawUnsafe: () => Promise.resolve(0), $transaction: () => Promise.resolve(undefined as never) } as never)
    expect((await outcomeOf(executor.query(sql`SELECT 1`))).error).toBeInstanceOf(Error)
  })
})

/** A thenable that is no native promise: its `then` is the host's code, and it resolves with `answer`. */
function lazy<T>(answer: T): PromiseLike<T> {
  return { then: (onFulfilled) => Promise.resolve(answer).then(onFulfilled) }
}

/** A native promise that resolves with an object whose `then` answers `undefined` on its first read and a function on every read after: the wait sees a value, and the resolution that follows it would run the function. */
function resolvesWithOneShotThen(): Promise<object> {
  let reads = 0
  const value = Object.defineProperty({}, 'then', {
    get: (): unknown => {
      reads += 1
      return reads === 1 ? undefined : (resolve: (answer: number) => void): void => resolve(7)
    },
  })
  return Promise.resolve(value)
}

describe('what a call to the host may answer with, by the kind of call', () => {
  it('refuses a thenable that is no native promise when the call says nothing of thenables', async () => {
    await expect(settled(lazy(1))).rejects.toMatchObject({ response: { error: { code: 'AI_TOKENS_INVALID_CONFIG' } } })
  })

  it('lets a thenable through when the call is the metered function of a provider SDK', async () => {
    await expect(settled(lazy(1), true)).resolves.toBe(1)
  })

  it('refuses what a host resolved with when its then answers after the wait, even for a call that lets thenables through', async () => {
    await expect(settled(resolvesWithOneShotThen(), true)).rejects.toMatchObject({ response: { error: { code: 'AI_TOKENS_INVALID_CONFIG' } } })
  })

  it('lets the lazy thenable of a driver through, and refuses what it resolved with when that has a then of its own', async () => {
    await expect(waited(lazy(5))).resolves.toBe(5)
    await expect(waited(resolvesWithOneShotThen())).rejects.toThrow('what the driver resolved with reads a then of its own')
  })

  it('refuses a thenable a statement returned, with the typed store error and the reason on its cause', async () => {
    const failure = await awaitStatement(lazy(1)).then(
      () => undefined,
      (error: unknown) => error as AiTokensException,
    )
    expect(failure).toBeInstanceOf(AiTokensException)
    expect(failure?.getResponse()).toMatchObject({ error: { code: 'AI_TOKENS_STORE_ERROR' } })
    expect((failure?.cause as Error).message).toBe('a promise a statement returned reads a constructor or then of its own')
  })
})

/** The rejections the process reports as unhandled while `run` and the turns after it go by. */
async function unhandledDuring(run: () => Promise<unknown>): Promise<{ unhandled: unknown[]; error: unknown }> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  let error: unknown
  try {
    await run().catch((caught: unknown) => { error = caught })
    await new Promise<void>((done) => setImmediate(done))
    await new Promise<void>((done) => setImmediate(done))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return { unhandled, error }
}

/** A host callback that pollutes the realm while it runs and answers with a promise that rejects. */
function pollutingAndRejecting(): () => Promise<never> {
  return () => {
    ;(Object.prototype as Record<string, unknown>).accidentalExtension = 1
    return Promise.reject(new Error('callback failed'))
  }
}

describe('a host callback that pollutes the realm and rejects leaves nothing unhandled behind', () => {
  beforeEach(() => setRealmGuard(true))
  afterEach(() => {
    Reflect.deleteProperty(Object.prototype, 'accidentalExtension')
    setRealmGuard(false)
  })

  it('refuses the answer of settled with the realm error and handles the rejection it will not wait for', async () => {
    const outcome = await unhandledDuring(() => settled(pollutingAndRejecting()()))
    expect(outcome.error).toMatchObject({ response: { error: { code: 'AI_TOKENS_INVALID_CONFIG' } } })
    expect(outcome.unhandled).toEqual([])
  })

  it('does the same for a markup policy', async () => {
    const resolver = new MarkupResolver({ markup: { resolve: pollutingAndRejecting() } })
    const outcome = await unhandledDuring(() => resolver.resolve({ ...context(), provider: 'openai', model: 'gpt-5', operation: 'chat', serviceTier: 'standard' } as never))
    expect(outcome.error).toBeInstanceOf(AiTokensException)
    expect(outcome.unhandled).toEqual([])
  })

  it('does the same for a tokenizer', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: { countTokens: pollutingAndRejecting() } })
    collector.push({ choices: [{ delta: { content: 'one two three' } }] })
    const outcome = await unhandledDuring(() => collector.finalize())
    expect(outcome.error).toBeInstanceOf(AiTokensException)
    expect(outcome.unhandled).toEqual([])
  })

  it('does the same for the scope resolver of a guard and for a function the interceptor meters', async () => {
    const { BudgetGuard } = await import('./enforcement/budget.guard')
    const built = makeService()
    const guard = new BudgetGuard(built.service, { holdFor: () => undefined } as never, new Reflector(), { scopeResolver: pollutingAndRejecting() })
    const executionContext = { getHandler: () => () => undefined, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({}) }) } as unknown as ExecutionContext
    const outcome = await unhandledDuring(() => guard.canActivate(executionContext))
    expect(outcome.error).toBeInstanceOf(AiTokensException)
    expect(outcome.unhandled).toEqual([])
  })
})
