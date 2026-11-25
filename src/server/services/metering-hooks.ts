/**
 * @fileoverview The event hooks the metering lifecycle fires, their no-op default, and the announcement of a settle that failed
 * after the work was served.
 * @layer server
 */

import type { Logger } from '@nestjs/common'
import type { SettleFailedEventData, UsageRecord } from '../../shared'
import { assertScope, assertText } from '../utils/argument-guards'
import { fieldOf } from '../utils/field-names'
import { describeError, errorCodeOf } from '../errors/describe-error'
import type { HoldCaller } from '../interfaces'
import type { LedgerService } from './ledger.service'

const SETTLE_FAILED_LOG_KEY = 'ai_tokens.settle.failed'

/** The event hooks the lifecycle fires; the module wires them to the dispatcher (default no-op). */
export interface MeteringEventHooks {
  usageRecorded(record: UsageRecord): Promise<void>
  priceMissing(record: UsageRecord): Promise<void>
  holdReleased(record: UsageRecord, reason: string, expired: boolean): Promise<void>
  usageReversed(original: UsageRecord, reversalRecordId: string, reason: string): Promise<void>
  settleFailed(tenantId: string, scope: HoldCaller['scope'], data: SettleFailedEventData): Promise<void>
  audit(action: string, details: Record<string, unknown>): Promise<void>
}

/** The no-op hooks used until the event dispatcher is wired. */
export const NOOP_EVENT_HOOKS: MeteringEventHooks = {
  usageRecorded: (): Promise<void> => Promise.resolve(),
  priceMissing: (): Promise<void> => Promise.resolve(),
  holdReleased: (): Promise<void> => Promise.resolve(),
  usageReversed: (): Promise<void> => Promise.resolve(),
  settleFailed: (): Promise<void> => Promise.resolve(),
  audit: (): Promise<void> => Promise.resolve(),
}

/** Where a settle failed, and the hold it was for when there was one. */
export interface SettleSite {
  where: SettleFailedEventData['where']
  holdId?: string
}

/**
 * Log and emit a failed settle with the error's code, never its message. Nothing is announced when the hold's row is posted, since
 * there is then no usage to reconcile; a row that cannot be read is announced. Never throws, so the caller's error is the one that
 * reaches the client.
 *
 * @param deps The ledger to read the row from and the hooks to emit through.
 * @param logger The caller's logger.
 * @param site Where the settle failed.
 * @param caller The tenant and payer scope from the host's verified auth context; read only inside the guarded block.
 * @param error What the settle threw.
 */
export async function announceSettleFailure(deps: { ledger: LedgerService; events: MeteringEventHooks }, logger: Logger, site: SettleSite, caller: HoldCaller, error: unknown): Promise<void> {
  const { holdId, where } = site
  const subject = holdId === undefined ? 'a metered call' : `hold ${holdId}`
  try {
    if (holdId !== undefined && (await deps.ledger.findById(holdId))?.status === 'posted') return
  } catch {
    // The row's state is unknown, so the failure is announced.
  }
  logger.warn(`${SETTLE_FAILED_LOG_KEY} ${subject} was not settled: ${describeError(error)}`)
  const errorCode = errorCodeOf(error)
  try {
    // A context with no payer reaches here when `record()` refused it; an event nobody can be told about is not emitted.
    assertText('context.tenantId', caller.tenantId)
    assertScope('context.scope', caller.scope)
    const correlationId = fieldOf(caller, 'correlationId')
    await deps.events.settleFailed(caller.tenantId, caller.scope, { ...(holdId !== undefined ? { holdId } : {}), ...(typeof correlationId === 'string' ? { correlationId } : {}), ...(errorCode !== undefined ? { errorCode } : {}), where })
  } catch (failure) {
    logger.warn(`${SETTLE_FAILED_LOG_KEY} the event for ${subject} was not delivered: ${describeError(failure)}`)
  }
}
