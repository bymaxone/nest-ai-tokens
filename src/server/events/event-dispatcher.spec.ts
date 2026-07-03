import { Logger } from '@nestjs/common'
import type { ModuleRef } from '@nestjs/core'
import type { AiTokensEvent } from '../../shared'
import type { ResolvedAiTokensOptions } from '../config'
import type { IEventSink } from '../interfaces'
import { EventDispatcher } from './event-dispatcher'

/** A capturing sink; failing sinks reject. */
function capturingSink(): { sink: IEventSink; delivered: AiTokensEvent[] } {
  const delivered: AiTokensEvent[] = []
  const sink: IEventSink = {
    deliver: (event) => {
      delivered.push(event)
      return Promise.resolve()
    },
  }
  return { sink, delivered }
}

/** Assemble a dispatcher with the given events options and a mock DI container. */
function makeDispatcher(over: { emitter?: boolean; sink?: IEventSink; get?: jest.Mock }): EventDispatcher {
  const options = { events: { emitter: over.emitter ?? false, sink: over.sink } } as Pick<
    ResolvedAiTokensOptions,
    'events'
  >
  const moduleRef = { get: over.get ?? jest.fn() } as unknown as ModuleRef
  return new EventDispatcher(moduleRef, options)
}

describe('EventDispatcher', () => {
  /** The sink receives a unique-id envelope with bigints as decimal strings. */
  it('delivers to the sink with bigints serialized and unique ids', async () => {
    const { sink, delivered } = capturingSink()
    const dispatcher = makeDispatcher({ sink })
    await dispatcher.emit('ai_tokens.usage.recorded', 't1', { type: 'user', id: 'u1' }, { billedCostNanoUsd: 5_000_000n })
    await dispatcher.emit('ai_tokens.usage.recorded', 't1', undefined, { billedCostNanoUsd: 6n })
    expect(delivered[0]).toMatchObject({ tenantId: 't1', scope: { type: 'user', id: 'u1' }, data: { billedCostNanoUsd: '5000000' } })
    expect(delivered[0]?.occurredAt).toBeInstanceOf(Date)
    expect(delivered[0]?.id).not.toBe(delivered[1]?.id)
    expect(delivered[1]?.scope).toBeUndefined()
  })

  /** A sink failure is logged and never rethrown. */
  it('logs and swallows a sink failure', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const sink: IEventSink = { deliver: () => Promise.reject(new Error('webhook down')) }
    const dispatcher = makeDispatcher({ sink })
    await expect(dispatcher.emit('ai_tokens.usage.recorded', 't1', undefined, {})).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
  })

  /** With no sink configured, emit is a safe no-op. */
  it('is a no-op when no sink is configured', async () => {
    const dispatcher = makeDispatcher({})
    await expect(dispatcher.emit('ai_tokens.audit', 't1', undefined, {})).resolves.toBeUndefined()
  })

  /** After init, the emitter channel receives the envelope with bigints intact; the sink also delivers. */
  it('emits on the emitter channel with bigints intact', async () => {
    const emitter = { emit: jest.fn() }
    const { sink, delivered } = capturingSink()
    const dispatcher = makeDispatcher({ emitter: true, sink, get: jest.fn().mockReturnValue(emitter) })
    await dispatcher.onModuleInit()
    await dispatcher.emit('ai_tokens.usage.recorded', 't1', undefined, { billedCostNanoUsd: 7n })
    expect(emitter.emit).toHaveBeenCalledWith('ai_tokens.usage.recorded', expect.objectContaining({ data: { billedCostNanoUsd: 7n } }))
    expect(delivered).toHaveLength(1)
  })

  /** An emitter listener failure is logged and never rethrown; the sink still delivers. */
  it('logs and swallows an emitter listener failure', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const emitter = {
      emit: jest.fn(() => {
        throw new Error('listener boom')
      }),
    }
    const { sink, delivered } = capturingSink()
    const dispatcher = makeDispatcher({ emitter: true, sink, get: jest.fn().mockReturnValue(emitter) })
    await dispatcher.onModuleInit()
    await expect(dispatcher.emit('ai_tokens.usage.recorded', 't1', undefined, {})).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    expect(delivered).toHaveLength(1)
  })

  /** When the emitter peer is absent, the sink still delivers. */
  it('still delivers via the sink when the emitter peer is absent', async () => {
    const { sink, delivered } = capturingSink()
    const dispatcher = makeDispatcher({
      emitter: true,
      sink,
      get: jest.fn(() => {
        throw new Error('absent')
      }),
    })
    await dispatcher.onModuleInit()
    await dispatcher.emit('ai_tokens.usage.recorded', 't1', undefined, {})
    expect(delivered).toHaveLength(1)
  })

  /** audit() reads the tenant from details, falling back to empty. */
  it('emits an audit event with the tenant read from details', async () => {
    const { sink, delivered } = capturingSink()
    const dispatcher = makeDispatcher({ sink })
    await dispatcher.audit('price.upsert', { tenantId: 't9', model: 'gpt-5' })
    await dispatcher.audit('price.upsert', { model: 'gpt-5' })
    expect(delivered[0]).toMatchObject({
      tenantId: 't9',
      type: 'ai_tokens.audit',
      data: { action: 'price.upsert', details: { tenantId: 't9', model: 'gpt-5' } },
    })
    expect(delivered[1]?.tenantId).toBe('')
  })
})
