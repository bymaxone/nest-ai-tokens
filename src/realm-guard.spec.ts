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
