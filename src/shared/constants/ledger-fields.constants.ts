/**
 * @fileoverview Append-only ledger field whitelists and the transition guard — the
 * single source of truth shared by the ledger service and the store adapters so the
 * two layers can never drift. `AMOUNT_FIELDS` are the money/token amounts that stay
 * immutable after a record posts; `SETTLEMENT_FIELDS` are everything a settlement
 * (`pending → posted`) may replace with actuals; `RELEASE_FIELDS` are the audit
 * annotations a void (`pending → released`) may set; `REVERSAL_LINKAGE_FIELD` is the
 * sole annotation a `posted → reversed` flip may set. `isLegalLedgerTransition` and
 * `isLegalTransitionPatchKey` encode the state machine and its per-transition patch
 * contract so every layer accepts exactly the same patches (see spec §8.3/§8.5).
 * @layer shared
 */

import type { UsageRecord, UsageStatus } from '../types/usage-record'

/**
 * The money/token amount columns that are append-only once a record posts — a
 * void (`pending → released`) or a reversal annotation may never patch them.
 */
export const AMOUNT_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
  'reasoningTokens',
  'audioInTokens',
  'audioOutTokens',
  'imageInTokens',
  'imageOutTokens',
  'totalTokens',
  'rawCostNanoUsd',
  'surchargeNanoUsd',
  'billedCostNanoUsd',
] as const satisfies readonly (keyof UsageRecord)[]

/**
 * Every field a settlement (`pending → posted`) may replace with actuals: the
 * append-only amounts plus the pricing metadata resolved at settlement time.
 */
export const SETTLEMENT_FIELDS = [
  ...AMOUNT_FIELDS,
  'priceVersionId',
  'priceMissing',
  'markupMultiplier',
] as const satisfies readonly (keyof UsageRecord)[]

/**
 * The audit-annotation columns a void (`pending → released`) may patch. A release
 * never bills, so it may only annotate the voided hold with request/correlation
 * linkage — never an append-only amount, the settlement pricing metadata, or an
 * immutable identity column. Kept as an explicit column whitelist so the store
 * boundary never interpolates an unknown identifier into raw SQL.
 */
export const RELEASE_FIELDS = ['correlationId', 'requestId'] as const satisfies readonly (keyof UsageRecord)[]

/** The sole field a `posted → reversed` annotation may set — the reversal linkage. */
export const REVERSAL_LINKAGE_FIELD = 'reversedByRecordId' as const satisfies keyof UsageRecord

/**
 * The only patch keys a settlement (`pending → posted`) may set — the settlement
 * amount/cost/pricing columns plus the reversal-linkage field. An immutable
 * identity column (`id`/`tenantId`/`idempotencyKey`) is never a member.
 */
export const SETTLEMENT_PATCH_KEYS: ReadonlySet<string> = new Set<string>([...SETTLEMENT_FIELDS, REVERSAL_LINKAGE_FIELD])

/** Fast-membership set of the release audit-annotation columns. */
const RELEASE_FIELD_SET: ReadonlySet<string> = new Set<string>(RELEASE_FIELDS)

/**
 * Whether `from → to` is a legal ledger state transition (§8.3): a hold settles
 * (`pending → posted`) or is voided (`pending → released`), and a posted record may
 * be annotated as reversed (`posted → reversed`). Every other pair is a caller bug.
 *
 * @param from The record's current lifecycle status.
 * @param to The requested target status.
 * @returns `true` when the transition is permitted by the state machine.
 */
export function isLegalLedgerTransition(from: UsageStatus, to: UsageStatus): boolean {
  if (from === 'pending') return to === 'posted' || to === 'released'
  return from === 'posted' && to === 'reversed'
}

/**
 * Whether `key` is a legal patch field for the `from → to` transition (§8.3/§8.5) —
 * the single source of truth shared by the ledger service guard and every store
 * adapter so the two layers can never drift:
 * - `pending → posted` (settle): only the settlement fields (+ the reversal linkage).
 * - `pending → released` (void): only the audit-annotation fields.
 * - `posted → reversed` (annotate): only the reversal linkage.
 * Any other (illegal) transition patches nothing. The result set is always drawn
 * from the fixed column whitelists above, so a store may interpolate a passing key
 * as a raw SQL identifier without risk of injection.
 *
 * @param from The record's current lifecycle status.
 * @param to The requested target status.
 * @param key The patch column a caller wishes to set.
 * @returns `true` when the column may legally be patched on this transition.
 */
export function isLegalTransitionPatchKey(from: UsageStatus, to: UsageStatus, key: string): boolean {
  if (from === 'pending' && to === 'posted') return SETTLEMENT_PATCH_KEYS.has(key)
  if (from === 'pending' && to === 'released') return RELEASE_FIELD_SET.has(key)
  if (from === 'posted' && to === 'reversed') return key === REVERSAL_LINKAGE_FIELD
  return false
}
