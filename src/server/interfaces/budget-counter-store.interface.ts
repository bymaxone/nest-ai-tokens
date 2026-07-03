/**
 * @fileoverview The optional live cross-replica budget counter port (spec §15.1,
 * §10.8). The fast path for budget enforcement; the DB conditional consume is the
 * fallback. Values are serialized as int64 decimal strings. Implemented by the
 * official Redis adapter (`./redis`).
 * @layer server
 */

/** The live budget counter port. */
export interface IBudgetCounterStore {
  /**
   * Atomically increment `key` by `amount` iff the result stays `<= limit`,
   * setting the TTL. Returns `false` when the increment would exceed the limit.
   */
  incrIfBelow(key: string, amount: bigint, limit: bigint, ttlSeconds: number): Promise<boolean>
  /** Decrement `key` by `amount` (release/reverse). */
  decr(key: string, amount: bigint): Promise<void>
  /** Reset `key` (window rotation). */
  reset(key: string): Promise<void>
}
