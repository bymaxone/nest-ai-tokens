import { Logger } from '@nestjs/common'
import type { ResolvedContentOptions } from '../config'
import type { IContentStore } from '../interfaces'
import { ContentCapture } from './content-capture'

/** A content store recording every put/purge. */
function makeStore(): IContentStore & { puts: { role: string; text: string; ttlSeconds: number }[] } {
  const puts: { role: string; text: string; ttlSeconds: number }[] = []
  return {
    puts,
    put: (input): Promise<void> => {
      puts.push({ role: input.role, text: input.text, ttlSeconds: input.ttlSeconds })
      return Promise.resolve()
    },
    purge: (): Promise<number> => Promise.resolve(0),
  }
}

const INPUT = { usageRecordId: 'rec-1', tenantId: 'tenant-1', prompt: 'hello world', completion: 'the answer' }

describe('ContentCapture', () => {
  /** Disabled (default): the store is never touched. */
  it('is a no-op when disabled', async () => {
    const store = makeStore()
    const put = jest.spyOn(store, 'put')
    await new ContentCapture({ enabled: false }).capture(INPUT)
    // A disabled instance holds no store; assert the standalone store was untouched.
    expect(put).not.toHaveBeenCalled()
  })

  /** Enabled: each role is masked before persistence and the TTL is propagated. */
  it('masks and stores each role with the TTL', async () => {
    const store = makeStore()
    const options: ResolvedContentOptions = { enabled: true, store, mask: (t) => t.replace(/o/g, '*'), ttlSeconds: 3_600 }
    await new ContentCapture(options).capture(INPUT)
    expect(store.puts).toEqual([
      { role: 'prompt', text: 'hell* w*rld', ttlSeconds: 3_600 },
      { role: 'completion', text: 'the answer', ttlSeconds: 3_600 },
    ])
  })

  /** Without a mask, the identity mask stores the text unchanged. */
  it('uses the identity mask by default', async () => {
    const store = makeStore()
    await new ContentCapture({ enabled: true, store, ttlSeconds: 60 }).capture({ usageRecordId: 'r', tenantId: 't', prompt: 'raw' })
    expect(store.puts).toEqual([{ role: 'prompt', text: 'raw', ttlSeconds: 60 }])
  })

  /** Only a completion is stored when only a completion is supplied. */
  it('stores only the supplied roles', async () => {
    const store = makeStore()
    await new ContentCapture({ enabled: true, store, ttlSeconds: 60 }).capture({ usageRecordId: 'r', tenantId: 't', completion: 'out' })
    expect(store.puts).toEqual([{ role: 'completion', text: 'out', ttlSeconds: 60 }])
  })

  /** No text supplied is a no-op even when enabled. */
  it('is a no-op with no text', async () => {
    const store = makeStore()
    const put = jest.spyOn(store, 'put')
    await new ContentCapture({ enabled: true, store, ttlSeconds: 60 }).capture({ usageRecordId: 'r', tenantId: 't' })
    expect(put).not.toHaveBeenCalled()
  })

  /** A store failure is swallowed (logged), never rethrown into the metering path. */
  it('never rethrows a store failure', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const store: IContentStore = { put: () => Promise.reject(new Error('sidecar down')), purge: () => Promise.resolve(0) }
    await expect(new ContentCapture({ enabled: true, store, ttlSeconds: 60 }).capture(INPUT)).resolves.toBeUndefined()
    // The catch block logged the failure — kills BlockStatement→{} which would empty the catch and skip the log:
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to write content sidecar'))
    errorSpy.mockRestore()
  })
})
