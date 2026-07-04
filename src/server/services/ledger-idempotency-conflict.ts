/**
 * @fileoverview The cross-store signal for an idempotency-key payload mismatch.
 * `ILedgerStore.append` upserts on `(tenantId, idempotencyKey)`: a replay with a
 * matching payload hash returns the existing record, but the same key with a
 * DIFFERENT payload hash is a conflict (spec §8.4). Stores raise this marker
 * instead of the framework `AiTokensException` so the persistence port stays free
 * of any HTTP concern; `LedgerService.append` catches it and maps it to
 * `AI_TOKENS_IDEMPOTENCY_CONFLICT`. The boolean brand is matched structurally so
 * detection survives crossing a bundle boundary — the official Prisma adapter
 * ships in a separate bundle from the server and cannot rely on `instanceof`
 * identity of this class.
 * @layer server
 */

/** A ledger idempotency-key payload-hash mismatch raised by an `ILedgerStore`. */
export class LedgerIdempotencyConflict extends Error {
  /** Structural brand matched by {@link isLedgerIdempotencyConflict} across bundles. */
  readonly isAiTokensLedgerConflict = true

  /**
   * @param tenantId The tenant whose key collided.
   * @param idempotencyKey The key reused with a different payload.
   */
  constructor(
    readonly tenantId: string,
    readonly idempotencyKey: string,
  ) {
    // Stryker disable next-line StringLiteral -- Error message string is internal diagnostics; tests check the error type, not the message text
    super('Ledger idempotency-key payload mismatch')
    this.name = 'LedgerIdempotencyConflict'
  }
}

/** The structural shape {@link isLedgerIdempotencyConflict} narrows an unknown value to. */
export interface LedgerConflictShape {
  isAiTokensLedgerConflict: true
  tenantId: string
  idempotencyKey: string
}

/**
 * Narrow an unknown thrown value to a ledger idempotency conflict. Matches the
 * boolean brand structurally so it works regardless of which bundle threw it.
 *
 * @param error The caught value.
 * @returns `true` when `error` is a ledger idempotency conflict.
 */
export function isLedgerIdempotencyConflict(error: unknown): error is LedgerConflictShape {
  if (typeof error !== 'object' || error === null) return false
  return (error as Record<string, unknown>).isAiTokensLedgerConflict === true
}
