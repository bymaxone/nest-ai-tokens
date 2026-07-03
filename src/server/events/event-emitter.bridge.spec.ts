import type { ModuleRef } from '@nestjs/core'
import { resolveEmitterChannel } from './event-emitter.bridge'

describe('resolveEmitterChannel', () => {
  /** Disabled: no DI lookup, no channel. */
  it('returns null when the channel is disabled', async () => {
    const get = jest.fn()
    const moduleRef = { get } as unknown as ModuleRef
    expect(await resolveEmitterChannel(moduleRef, false)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })

  /** Enabled + emitter present: the channel forwards to the host's EventEmitter2. */
  it('forwards to the resolved EventEmitter2 instance', async () => {
    const emitter = { emit: jest.fn() }
    const moduleRef = { get: jest.fn().mockReturnValue(emitter) } as unknown as ModuleRef
    const channel = await resolveEmitterChannel(moduleRef, true)
    channel?.emit('ai_tokens.usage.recorded', { id: 'e1' })
    expect(emitter.emit).toHaveBeenCalledWith('ai_tokens.usage.recorded', { id: 'e1' })
  })

  /** Enabled but the peer/instance is not provided: silently disabled. */
  it('returns null when EventEmitter2 is not provided', async () => {
    const moduleRef = {
      get: jest.fn(() => {
        throw new Error('EventEmitter2 not found')
      }),
    } as unknown as ModuleRef
    expect(await resolveEmitterChannel(moduleRef, true)).toBeNull()
  })
})
