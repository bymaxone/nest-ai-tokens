/**
 * @fileoverview Adapters from the service-level event hooks to the
 * {@link EventDispatcher} (spec §12.2). `MeteringService` and `LedgerService`
 * depend only on small hook contracts (default no-op) to avoid a dependency cycle
 * on the dispatcher; the module uses these factories to wire the real dispatcher
 * in. The metering hooks map a settled record to the documented
 * `ai_tokens.usage.recorded` / `ai_tokens.price.missing` payloads; the ledger hook
 * forwards chain-verification audits. Internal — not part of the public barrel.
 * @layer server
 */

import type {
  MeteringScope,
  PriceMissingEventData,
  UsageRecord,
  UsageRecordedEventData,
  WalletDepletedEventData,
  WalletGrantedEventData,
  WalletRef,
} from '../../shared'
import type { LedgerAuditHook, MeteringEventHooks, WalletEventHooks } from '../services'
import type { EventDispatcher } from './event-dispatcher'

/** Map a wallet owner reference to the metering scope its events carry. */
function scopeOfWallet(ref: WalletRef): MeteringScope {
  return { type: ref.ownerType, id: ref.ownerId }
}

/** Build the metering event hooks that fan a settled record out through the dispatcher. */
export function createMeteringEventHooks(dispatcher: EventDispatcher): MeteringEventHooks {
  return {
    usageRecorded: (record: UsageRecord): Promise<void> => {
      const data: UsageRecordedEventData = {
        usageRecordId: record.id,
        feature: record.feature,
        provider: record.provider,
        model: record.model,
        serviceTier: record.serviceTier,
        totalTokens: record.totalTokens,
        rawCostNanoUsd: record.rawCostNanoUsd,
        billedCostNanoUsd: record.billedCostNanoUsd,
        enforced: record.enforced,
        isSystemCost: record.isSystemCost,
      }
      return dispatcher.emit('ai_tokens.usage.recorded', record.tenantId, record.scope, data)
    },
    priceMissing: (record: UsageRecord): Promise<void> => {
      const data: PriceMissingEventData = {
        provider: record.provider,
        model: record.model,
        operation: record.operation,
        serviceTier: record.serviceTier,
        usageRecordId: record.id,
      }
      return dispatcher.emit('ai_tokens.price.missing', record.tenantId, record.scope, data)
    },
  }
}

/** Build the ledger audit hook that forwards `verifyChain` audits (fire-and-forget). */
export function createLedgerAuditHook(dispatcher: EventDispatcher): LedgerAuditHook {
  return (action: string, details: Record<string, unknown>): void => {
    void dispatcher.audit(action, details)
  }
}

/** Build the wallet event hooks that fan grant/depletion/audit events through the dispatcher. */
export function createWalletEventHooks(dispatcher: EventDispatcher): WalletEventHooks {
  return {
    granted: (ref: WalletRef, data: WalletGrantedEventData): Promise<void> =>
      dispatcher.emit('ai_tokens.wallet.granted', ref.tenantId, scopeOfWallet(ref), data),
    depleted: (ref: WalletRef, data: WalletDepletedEventData): Promise<void> =>
      dispatcher.emit('ai_tokens.wallet.depleted', ref.tenantId, scopeOfWallet(ref), data),
    audit: (action: string, details: Record<string, unknown>): Promise<void> => dispatcher.audit(action, details),
  }
}
