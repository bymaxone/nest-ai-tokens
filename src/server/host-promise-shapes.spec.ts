/**
 * @fileoverview The promises a host returns to the library are answered as the host gives them: a subclass of `Promise`, a thenable that
 * is a plain object or an instance of a class (a query builder), and a native promise of another realm resolve with what they hold,
 * wherever the library waits for a host: a store, a markup policy, a tokenizer, an fx function and the async options factory.
 * The shapes at the edge of that (a promise with no prototype, a row whose `then` a Proxy or an accessor answers) are pinned beside them.
 * @layer server
 */

import { types } from 'node:util'
import { runInNewContext } from 'node:vm'
import { Test } from '@nestjs/testing'
import { AiTokensException } from './errors'
import { BymaxAiTokensModule } from './bymax-ai-tokens.module'
import { MeteringService } from './services'
import { MarkupResolver } from './services/markup.resolver'
import { guardedStore } from './utils/guarded-store'
import { settled } from './utils/host-settled'
import { awaitStatement } from '../prisma/adapter-sql'
import { makeFullStore } from '../../test/fakes/full-store'

class SdkPromise<T> extends Promise<T> {}
class QueryBuilder<T> {
  constructor(private readonly value: T) {}

  then(resolve: (value: T) => void): void {
    resolve(this.value)
  }
}
const foreign = runInNewContext('Promise') as PromiseConstructor

/** Each way a host hands back an answer it will give later, as a function of the answer. */
const SHAPES: readonly (readonly [string, <T>(value: T) => PromiseLike<T>])[] = [
  ['a subclass of Promise', (value) => SdkPromise.resolve(value)],
  ['a thenable that is a plain object', (value) => ({ then: (resolve?: (value: never) => unknown) => resolve?.(value as never) }) as never],
  ['a thenable that is an instance of a class', (value) => new QueryBuilder(value) as never],
  ['a native promise of another realm', (value) => foreign.resolve(value)],
]

describe.each(SHAPES)('a host that answers with %s', (_name, shape) => {
  it('is waited for where the library waits for a host', async () => {
    await expect(settled(shape(7))).resolves.toBe(7)
  })

  it('answers for a store method', async () => {
    const store = guardedStore({ find: () => shape({ id: 'r1' }) })
    await expect(store.find()).resolves.toEqual({ id: 'r1' })
  })

  it('answers for a markup policy', async () => {
    const resolver = new MarkupResolver({ markup: { resolve: () => shape(1.5) as never } })
    const resolved = await resolver.resolve({ tenantId: 't', scope: { type: 'user', id: 'u' }, provider: 'openai', model: 'gpt-5', operation: 'chat', feature: 'chat.reply' } as never)
    expect(resolved.multiplier).toBe(1.5)
  })

  it('answers for the async options factory, which boots', async () => {
    const options = { store: makeFullStore(), pricing: { seedFromSnapshot: false } }
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRootAsync({ useFactory: () => shape(options) as never })],
    }).compile()
    expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService)
    await moduleRef.close()
  })

  it('answers for a statement of the Prisma adapter', async () => {
    await expect(awaitStatement(shape([1]))).resolves.toEqual([1])
  })
})

describe('a then planted on Object.prototype', () => {
  it('is refused for every shape, as the realm guard refuses it before anything is waited for', async () => {
    Object.defineProperty(Object.prototype, 'then', { value: (resolve: (value: string) => void): void => resolve('forged'), configurable: true, writable: true })
    const outcomes: string[] = []
    try {
      // No matcher runs, and no object is resolved into a promise, while the key is planted: every object would be a thenable.
      for (const [, shape] of SHAPES) {
        outcomes.push(await settled(shape(7)).then(() => 'answered', (error: unknown) => (error instanceof AiTokensException ? 'refused' : 'failed')))
      }
    } finally {
      delete (Object.prototype as { then?: unknown }).then
    }
    expect(outcomes).toEqual(SHAPES.map(() => 'refused'))
  })
})

describe('a host answer with a Proxy on its prototype chain, which answers a then with a function', () => {
  const answer = (runs: string[]): object =>
    Object.create(new Proxy({}, { get: (_target, key) => (key === 'then' ? (resolve: (value: number) => void): void => { runs.push('then'); resolve(123) } : undefined) })) as object

  /** Each place the library waits for a host, as a function that is given the answer. */
  const SITES: readonly (readonly [string, (value: object) => Promise<unknown>])[] = [
    ['settled', (value) => settled(value)],
    ['a store method', (value) => guardedStore({ find: () => value }).find() as Promise<unknown>],
    ['a statement of the Prisma adapter', (value) => awaitStatement(value as PromiseLike<unknown>)],
  ]

  it.each(SITES)('is refused, and its then is not run, at %s', async (_site, wait) => {
    const runs: string[] = []
    await expect(Promise.resolve().then(() => wait(answer(runs)))).rejects.toBeInstanceOf(AiTokensException)
    expect(runs).toEqual([])
  })
})

describe('the reason a refused host answer carries', () => {
  /** The reason rides in the details of the typed error: it says which check refused, before the wait or after it. */
  const reasonOf = async (answer: Promise<unknown>): Promise<unknown> => {
    const error: unknown = await answer.catch((failure: unknown) => failure)
    return ((error as AiTokensException).getResponse() as { error: { details: { reason: unknown } } }).error.details.reason
  }

  it('names a promise that reads a constructor or then of its own when it is refused before the wait', async () => {
    const planted = Promise.resolve(1)
    void Object.defineProperty(planted, 'then', { value: () => undefined })
    await expect(reasonOf(settled(planted))).resolves.toBe('what a host returned reads a constructor or then of its own, or the arrays the library reads were replaced')
  })

  it('names the check that refuses a Proxy the host resolved with, for the function meter() runs, after the wait', async () => {
    await expect(reasonOf(settled(Promise.resolve(new Proxy({}, {})), true))).resolves.toBe('what a host resolved with has a then of its own, or the arrays the library reads were replaced')
  })
})

describe('a host that resolves with a Proxy', () => {
  const proxy = (): object => new Proxy({ id: 'r1' }, {})

  it('is waited for and answers with the Proxy the host resolved with', async () => {
    const resolved = proxy()
    await expect(settled(Promise.resolve(resolved))).resolves.toBe(resolved)
  })

  it('is refused for the function meter() runs, whose answer is resolved into the promise it returns', async () => {
    await expect(settled(Promise.resolve(proxy()), true)).rejects.toBeInstanceOf(AiTokensException)
  })

  it('boots the module when the options factory resolves with a Proxy', async () => {
    const options = new Proxy({ store: makeFullStore(), pricing: { seedFromSnapshot: false } }, {})
    const moduleRef = await Test.createTestingModule({ imports: [BymaxAiTokensModule.forRootAsync({ useFactory: () => Promise.resolve(options) })] }).compile()
    expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService)
    await moduleRef.close()
  })
})

describe('a host whose promise is no longer what the engine made', () => {
  it('still refuses a native promise with a then of its own', async () => {
    const planted = Promise.resolve(1)
    void Object.defineProperty(planted, 'then', { value: () => undefined })
    await expect(settled(planted)).rejects.toBeInstanceOf(AiTokensException)
  })

  /** The statement of the Prisma adapter is refused with the typed store error, and the reason it was refused rides on the cause. */
  it('types the refusal of a statement that is a native promise with a then of its own and says why on the cause', async () => {
    const planted = Promise.resolve([1])
    void Object.defineProperty(planted, 'then', { value: () => undefined })
    const error: unknown = await awaitStatement(planted).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AiTokensException)
    expect(((error as AiTokensException).cause as Error).message).toBe('a promise a statement returned reads a constructor or then of its own')
  })
})

describe('a store answer at the edge of what is a promise', () => {
  /**
   * A native promise whose prototype was taken away has no `then`, so a native `await` of it settles with the promise object itself, not with
   * the value it holds. The store method has nothing to unwrap either, and answers with a copy of that object, which holds no `id`.
   */
  it('answers a native promise that has no prototype with a copy of the promise that holds no id, not with the value it holds', async () => {
    const promise = Promise.resolve({ id: 'r1' })
    Object.setPrototypeOf(promise, null)
    const answer = guardedStore({ find: () => promise }).find()
    expect(types.isPromise(answer)).toBe(true)
    const settledWith = (await answer) as object
    expect([Object.getPrototypeOf(settledWith), Object.keys(settledWith)]).toEqual([null, []])
  })

  /** A row whose `then` is answered by a Proxy trap, or is an accessor, is refused as the call is made: nothing is returned to wait for. */
  it.each([
    ['a Proxy that answers a then', (): unknown => new Proxy({ id: 'r' }, { get: (target, key) => (key === 'then' ? () => 1 : (target as never)[key]) })],
    ['an accessor named then', (): unknown => ({ id: 'r', get then() { return undefined } })],
  ] as const)('refuses a row that is %s at once', (_name, make) => {
    expect(() => guardedStore({ find: make }).find()).toThrow(AiTokensException)
  })

  /** A value that reads as no thenable when the promise resolves and as one when the library copies it is refused before it is handed on. */
  it('refuses a resolved row whose then turns into a function between the wait and the copy', async () => {
    let reads = 0
    const row = { id: 'r', get then(): unknown { reads += 1; return reads === 1 ? undefined : (): string => 'forged' } }
    await expect(guardedStore({ find: () => Promise.resolve(row) }).find()).rejects.toBeInstanceOf(AiTokensException)
  })
})

describe('settled on a polluted realm', () => {
  /** The thenable is the host's own and its `then` is code of the host: refusing the realm does not run it. */
  it('does not run the then of a thenable it refuses', async () => {
    const then = jest.fn()
    class Builder {
      then(): void {
        then()
      }
    }
    Object.defineProperty(Object.prototype, 'plantedKey', { value: 1, configurable: true, writable: true })
    try {
      await expect(settled(new Builder())).rejects.toBeInstanceOf(AiTokensException)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      delete (Object.prototype as { plantedKey?: unknown }).plantedKey
    }
    expect(then).not.toHaveBeenCalled()
  })
})
