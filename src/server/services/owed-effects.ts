/**
 * @fileoverview The settlement of one row whose effects are still owed: a capture whose wallet and budget legs did not
 * run, a release whose reservation was not given back, or a reversal whose refund and budget release did not run. Every
 * leg is keyed by what causes it (`capture:<id>`, `release:<id>`, `reverse:<id>` and the budget application keys), so
 * running a leg again moves nothing; the marker is cleared last, so a row whose effects fail again is found on the
 * next tick. Each leg takes the tenant and payer of the row itself.
 * @layer server
 */

import type { Logger } from '@nestjs/common'
import type { UsageRecord } from '../../shared'
import type { LedgerService } from './ledger.service'
import type { MeteringEffects } from './metering-effects'
import type { OwedEffects } from '../interfaces'

/** The reason stated on the effects and events a sweep produces. */
const RECOVERED_REASON = 'effects recovered by the settlement sweep'

/** The collaborators of the settlement of an owed row. */
export interface OwedEffectsDeps {
  /** The ledger service: the lookup of the original of a reversal, its annotation and the clearing of the marker. */
  ledger: LedgerService
  /** The effects the inline path runs, which are the same legs. */
  effects: MeteringEffects
  /** The event hooks the transition owes. */
  events: {
    usageRecorded(record: UsageRecord): Promise<void>
    holdReleased(record: UsageRecord, reason: string, expired: boolean): Promise<void>
    usageReversed(original: UsageRecord, reversalRecordId: string, reason: string): Promise<void>
  }
}

/**
 * Finish the effects of one owed row and clear its marker. Safe to run twice, and by two sweepers at once: every leg is
 * keyed, and clearing is idempotent.
 *
 * @param deps The ledger, the effects and the event hooks.
 * @param owed The owed row with the values its marker kept.
 */
export async function settleOwed(deps: OwedEffectsDeps, owed: OwedEffects): Promise<void> {
  const { record } = owed
  if (record.reversesRecordId !== undefined) await settleReversal(deps, record, record.reversesRecordId)
  else if (record.status === 'released') {
    await deps.effects.restoreHold(record)
    await deps.events.holdReleased(record, RECOVERED_REASON, false)
  } else if (record.status === 'posted') {
    const reservedBilled = owed.reservedBilledNanoUsd ?? record.billedCostNanoUsd
    const reservedTokens = owed.reservedTokens ?? record.totalTokens
    await deps.effects.settleCapture(record, reservedBilled, reservedTokens, record.billedCostNanoUsd, record.totalTokens)
    await deps.events.usageRecorded(record)
  }
  await deps.ledger.clearEffectsOwed(record.id)
}

/** Finish a reversal: the annotation of the original when the crash came before it, then the refund and the release. */
async function settleReversal(deps: OwedEffectsDeps, compensating: UsageRecord, originalId: string): Promise<void> {
  const original = await deps.ledger.findById(originalId)
  if (original === null) return
  if (original.status === 'posted') await deps.ledger.transition(original.id, 'posted', 'reversed', { reversedByRecordId: compensating.id })
  if (original.enforced && !original.isSystemCost) await deps.effects.reverseEffects(original, RECOVERED_REASON)
  await deps.events.usageReversed(original, compensating.id, RECOVERED_REASON)
}

/**
 * Clear the marker of a row whose effects have run. A failure here only means the sweep repeats keyed legs, so it is logged
 * and not thrown.
 *
 * @param ledger The ledger service.
 * @param logger Where a failed clearing is logged.
 * @param id The row id.
 */
export async function clearOwed(ledger: LedgerService, logger: Logger, id: string): Promise<void> {
  try {
    await ledger.clearEffectsOwed(id)
  } catch {
    // Stryker disable next-line StringLiteral: logger text is internal observability
    logger.warn(`failed to clear the effects-owed marker of ${id}`)
  }
}

/**
 * Run the legs of a reversal inline. When one fails the marker stays on the compensating row and the sweep finishes it,
 * and the reversal still returns: the ledger transition committed.
 *
 * @param ledger The ledger service.
 * @param effects The effects the inline path runs.
 * @param logger Where a failed leg is logged.
 * @param original The reversed original record.
 * @param reason The caller's stated reason.
 * @param compensatingId The id of the compensating row that carries the marker.
 */
export async function reverseOrLeaveOwed(ledger: LedgerService, effects: MeteringEffects, logger: Logger, original: UsageRecord, reason: string, compensatingId: string): Promise<void> {
  try {
    await effects.reverseEffects(original, reason)
  } catch {
    // Stryker disable next-line StringLiteral: logger text is internal observability
    logger.warn('a leg of a reversal failed; its effects are left to the settlement sweep')
    return
  }
  await clearOwed(ledger, logger, compensatingId)
}

