/**
 * @fileoverview The optional `@nestjs/event-emitter` bridge (spec §12.1).
 * `@nestjs/event-emitter` is an OPTIONAL peer, so it is NEVER imported at the top
 * level — it is resolved lazily with a guarded dynamic import at module init. When
 * present (the host imported `EventEmitterModule.forRoot()`), the host's shared
 * `EventEmitter2` instance is fetched from the DI container so events reach the
 * host's `@OnEvent` listeners; when absent, the channel is silently disabled. The
 * emitter channel carries `bigint` fields INTACT (in-process delivery).
 * @layer server
 */

import type { ModuleRef } from '@nestjs/core'

/** A minimal in-process emitter: publish an event envelope under its type string. */
export interface EmitterChannel {
  emit(type: string, envelope: unknown): void
}

/**
 * Resolve the `@nestjs/event-emitter` channel, or `null` when the channel is
 * disabled or the optional peer is not installed/registered. Never throws.
 *
 * @param moduleRef The host DI container (to fetch the shared `EventEmitter2`).
 * @param enabled Whether the emitter channel is enabled (`events.emitter`).
 * @returns The channel, or `null` when unavailable.
 */
export async function resolveEmitterChannel(moduleRef: ModuleRef, enabled: boolean): Promise<EmitterChannel | null> {
  if (!enabled) return null
  try {
    const emitterModule = await import('@nestjs/event-emitter')
    // Stryker disable next-line ObjectLiteral,BooleanLiteral -- { strict: false } retrieves a global singleton; unit tests do not install @nestjs/event-emitter so the catch path always fires, making the options value unobservable
    const emitter = moduleRef.get(emitterModule.EventEmitter2, { strict: false })
    return {
      emit: (type: string, envelope: unknown): void => {
        emitter.emit(type, envelope)
      },
    }
  } catch {
    return null
  }
}
