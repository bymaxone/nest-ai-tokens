/**
 * @fileoverview `EventDispatcher` — the typed event fan-out (spec §12). Builds the
 * `AiTokensEvent` envelope (unique id + `occurredAt`) and delivers it on two
 * optional channels: the in-process `@nestjs/event-emitter` (bigints intact) and a
 * programmatic `IEventSink` (bigints serialized to decimal strings via
 * `toJsonSafe`, §15.5). Delivery failures on EITHER channel are logged and NEVER
 * rethrown, so an event failure can never break the metering path (§12.1). No
 * prompt/response text is ever placed on an event. Internal — not part of the
 * public barrel; the module registers it.
 * @layer server
 */

import { randomUUID } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import type { OnModuleInit } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import type { AiTokensEvent, AiTokensEventType, AuditEventData, MeteringScope } from '../../shared'
import type { ResolvedAiTokensOptions } from '../config'
import { toJsonSafe } from '../utils/to-json-safe'
import { resolveEmitterChannel, type EmitterChannel } from './event-emitter.bridge'

/**
 * Internal fan-out bridge between the domain event hooks and the optional
 * `@nestjs/event-emitter` peer. Discovers the emitter lazily at startup so
 * the feature degrades gracefully when the peer is absent.
 */
@Injectable()
export class EventDispatcher implements OnModuleInit {
  private readonly logger = new Logger(EventDispatcher.name)
  private emitterChannel: EmitterChannel | null = null

  /**
   * @param moduleRef The DI container, used to resolve the optional emitter peer.
   * @param options The resolved options carrying the events configuration.
   */
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly options: Pick<ResolvedAiTokensOptions, 'events'>,
  ) {}

  /** Resolve the optional emitter channel once, at module init. */
  async onModuleInit(): Promise<void> {
    this.emitterChannel = await resolveEmitterChannel(this.moduleRef, this.options.events.emitter)
  }

  /**
   * Build and deliver one event on every configured channel. Never throws. The
   * `data` payload is typed at each call site against the §12.2 catalog.
   *
   * @param type The event type.
   * @param tenantId The owning tenant.
   * @param scope The optional payer scope.
   * @param data The event payload.
   */
  async emit(type: AiTokensEventType, tenantId: string, scope: MeteringScope | undefined, data: unknown): Promise<void> {
    const envelope: AiTokensEvent = {
      id: randomUUID(),
      type,
      occurredAt: new Date(),
      tenantId,
      ...(scope !== undefined ? { scope } : {}),
      data,
    }
    this.emitViaEmitter(envelope)
    await this.emitViaSink(envelope)
  }

  /**
   * Emit an admin-plane audit event (§14.4). The tenant is read from `details`.
   *
   * @param action The admin action performed.
   * @param details Structured context (never prompt/response text).
   */
  audit(action: string, details: Record<string, unknown>): Promise<void> {
    const tenantId = typeof details.tenantId === 'string' ? details.tenantId : ''
    const data: AuditEventData = { action, details }
    return this.emit('ai_tokens.audit', tenantId, undefined, data)
  }

  /** Deliver on the in-process emitter channel (bigints intact); log a listener error. */
  private emitViaEmitter(envelope: AiTokensEvent): void {
    try {
      this.emitterChannel?.emit(envelope.type, envelope)
    } catch {
      // Stryker disable next-line StringLiteral -- logger text is internal observability; tests check that events are emitted, not error message text
      this.logger.error(`event emitter listener failed for ${envelope.type} (${envelope.id})`)
    }
  }

  /** Deliver on the programmatic sink (bigints as decimal strings); log a delivery failure. */
  private async emitViaSink(envelope: AiTokensEvent): Promise<void> {
    const { sink } = this.options.events
    if (sink === undefined) return
    try {
      await sink.deliver(toJsonSafe(envelope))
    } catch {
      // Stryker disable next-line StringLiteral -- logger text is internal observability
      this.logger.error(`event sink delivery failed for ${envelope.type} (${envelope.id})`)
    }
  }
}
