/**
 * @fileoverview The realm guard at the doors of the library: with a key planted on `Object.prototype`, or a built-in replaced, every public
 * method of every service is refused with the typed error and the count only, before anything is written or reported, and the same call
 * succeeds once the realm is clean again; the module does not start either.
 * @layer server
 */

import { rig } from '../test/fakes/call-registry'
import { makeFullStore } from '../test/fakes/full-store'
import { validateOptions } from './server/config'
import type { BymaxAiTokensModuleOptions } from './server/interfaces'
import { AiTokensException } from './server/errors'
import { AI_TOKENS_ERROR_MESSAGES } from './server/errors/ai-tokens-error-messages'
import { setRealmGuard } from './server/utils/prototype-guard'

const OPTIONS = { store: makeFullStore(), scopeResolver: (): never => undefined as never } as BymaxAiTokensModuleOptions

/** The typed refusal a call raises while it runs, or `undefined` when it returns. */
async function refusalOf(run: () => unknown): Promise<{ code: string; reason: string } | undefined> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof AiTokensException)) throw error
    const body = (error.getResponse() as { error: { code: string; details?: { reason?: string } } }).error
    return { code: body.code, reason: body.details?.reason ?? '' }
  }
  return undefined
}

/** Plant a key, run `run`, remove it. */
async function planted<T>(run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, 'zzSecretName', { value: 'zzSecretValue', configurable: true, writable: true, enumerable: false })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, 'zzSecretName')
  }
}

describe('every public method of the services under a polluted realm', () => {
  it('refuses each with the count only, writes nothing, and works again once the realm is clean', async () => {
    const { calls } = await rig()
    const names = Object.keys(calls)
    expect(names.length).toBeGreaterThan(25)
    for (const name of names) {
      const call = calls[name]!
      const refused = await planted(async () => refusalOf(async () => call.run(await call.base())))
      expect({ name, code: refused?.code }).toEqual({ name, code: 'AI_TOKENS_INVALID_CONFIG' })
      expect(refused?.reason).toContain('1 name(s)')
      expect(refused?.reason).not.toContain('zzSecretName')
      expect(refused?.reason).not.toContain('zzSecretValue')
      expect({ name, refused: await refusalOf(async () => call.run(await call.base())) }).toEqual({ name, refused: undefined })
    }
  })

  it('writes no record and moves no money while it refuses', async () => {
    const { calls } = await rig()
    const record = calls['metering.record']!
    const query = calls['ledger.query']!
    const before = ((await query.run(await query.base())) as unknown[]).length
    expect((await planted(async () => refusalOf(async () => record.run(await record.base()))))?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(((await query.run(await query.base())) as unknown[]).length).toBe(before)
  })

  it('refuses a built-in that is replaced, with the count', async () => {
    const { calls } = await rig()
    const hold = calls['metering.hold']!
    const base = await hold.base()
    const keys = Object.keys
    let refused: { code: string; reason: string } | undefined
    try {
      ;(Object as { keys: unknown }).keys = (): string[] => []
      refused = await refusalOf(() => hold.run(base))
    } finally {
      ;(Object as { keys: unknown }).keys = keys
    }
    expect(refused?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(refused?.reason).toContain('1 name(s)')
  })

  it('does not let the module start beside a planted key', async () => {
    const refused = await planted(async () => refusalOf(() => validateOptions(OPTIONS)))
    expect(refused?.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(refused?.reason).not.toContain('zzSecretName')
    expect(await refusalOf(() => validateOptions(OPTIONS))).toBeUndefined()
  })
})

describe('the refusal of the guard and the exception it throws', () => {
  /** What a planted key could put into an exception: its text, the body it carries, its status and its name. */
  const PLANTS: [string, PropertyDescriptor][] = [
    ['message', { value: 'planted-text', enumerable: true, writable: true }],
    ['message', { set(): void { /* swallows the write */ }, get: (): string => 'planted-text' }],
    ['response', { set(): void { /* swallows the write */ }, get: (): undefined => undefined }],
    ['status', { set(): void { /* swallows the write */ }, get: (): number => 200 }],
    ['name', { value: 'PlantedName', enumerable: true, writable: true }],
    ['options', { value: { cause: 'planted' }, enumerable: true, writable: true }],
    ['cause', { value: 'planted-cause', enumerable: true, writable: true }],
  ]

  /** Keys planted read-only (`defineProperty` without `writable`): NestJS's own constructor throws on them, which only the guard's refusal is built to survive. */
  const READ_ONLY: [string, PropertyDescriptor][] = [
    ['options', { value: { cause: 'planted' }, enumerable: true }],
    ['message', { value: 'planted-text', enumerable: true }],
    ['response', { value: 'planted-body', enumerable: true }],
    ['status', { value: 200, enumerable: true }],
    ['name', { value: 'PlantedName', enumerable: true }],
  ]

  /** Plant `key` as `descriptor` on `Object.prototype`, run `run`, remove it. */
  function plantedAs<T>(key: string, descriptor: PropertyDescriptor, run: () => T): T {
    Object.defineProperty(Object.prototype, key, { ...descriptor, configurable: true })
    try {
      return run()
    } finally {
      Reflect.deleteProperty(Object.prototype, key)
    }
  }

  it.each(PLANTS)('keeps its own code, status, text and name when %s is planted on Object.prototype', (key, descriptor) => {
    setRealmGuard(false)
    try {
      const error = plantedAs(key, descriptor, () => new AiTokensException('AI_TOKENS_INSUFFICIENT_CREDITS', undefined, { walletId: 'w1' }))
      expect(error.getStatus()).toBe(402)
      expect((error.getResponse() as { error: { code: string; message: string; details: unknown } }).error).toEqual({ code: 'AI_TOKENS_INSUFFICIENT_CREDITS', message: error.message, details: { walletId: 'w1' } })
      expect(error.message).toBe(AI_TOKENS_ERROR_MESSAGES.AI_TOKENS_INSUFFICIENT_CREDITS)
      expect(error.name).toBe('AiTokensException')
      expect(Object.getPrototypeOf(error.getResponse())).toBeNull()
    } finally {
      setRealmGuard(true)
    }
  })

  it.each([...PLANTS, ...READ_ONLY])('refuses with the typed code and a count, and no planted value, when %s is planted on Object.prototype', async (key, descriptor) => {
    const { calls } = await rig()
    const hold = calls['metering.hold']!
    const base = await hold.base()
    let thrown: unknown
    Object.defineProperty(Object.prototype, key, { ...descriptor, configurable: true })
    try {
      await Promise.resolve(hold.run(base)).catch((error: unknown) => (thrown = error))
    } finally {
      Reflect.deleteProperty(Object.prototype, key)
    }
    const error = thrown as AiTokensException
    expect(error).toBeInstanceOf(AiTokensException)
    expect(error.getStatus()).toBe(500)
    const body = (error.getResponse() as { error: { code: string; details: { reason: string } } }).error
    expect(body.code).toBe('AI_TOKENS_INVALID_CONFIG')
    expect(body.details.reason).toContain('1 name(s)')
    expect(error.message).toBe(AI_TOKENS_ERROR_MESSAGES.AI_TOKENS_INVALID_CONFIG)
    expect(error.name).toBe('AiTokensException')
    expect(Object.getPrototypeOf(error.getResponse())).toBeNull()
    expect(Object.getPrototypeOf(body)).toBeNull()
    expect(Object.getPrototypeOf(body.details)).toBeNull()
  })

  it('refuses with the typed error when the global String or Object is rebound after the library loaded', async () => {
    const { calls } = await rig()
    const hold = calls['metering.hold']!
    const base = await hold.base()
    const original = { String: globalThis.String, Object: globalThis.Object }
    Object.defineProperty(Object.prototype, 'zzPlantedName', { value: 1, configurable: true, writable: true, enumerable: false })
    let thrown: unknown
    try {
      ;(globalThis as { String: unknown }).String = (): never => { throw new Error('rebound String') }
      ;(globalThis as { Object: unknown }).Object = { prototype: {} }
      try {
        await Promise.resolve(hold.run(base)).catch((error: unknown) => (thrown = error))
      } catch (error) {
        thrown = error
      }
    } finally {
      ;(globalThis as { String: unknown }).String = original.String
      ;(globalThis as { Object: unknown }).Object = original.Object
      Reflect.deleteProperty(Object.prototype, 'zzPlantedName')
    }
    expect(thrown).toBeInstanceOf(AiTokensException)
    expect((thrown as AiTokensException).message).not.toContain('rebound')
  })
})
