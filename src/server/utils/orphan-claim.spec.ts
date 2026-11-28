/**
 * @fileoverview Unit tests of the claim helpers: which wallet debit keys the sweep recognises and the rollback refund each
 * one maps to, and which ledger rows are claims. A host feature or provider that happens to carry the fixed value is not a claim.
 * @layer server
 */

import {
  DEBIT_PREFIXES,
  ORPHAN_CLAIM,
  ORPHAN_DEBIT_REASON,
  claimShares,
  isOrphanClaim,
  lateAppend,
  ledgerKeyOfDebit,
  rollbackOfDebit,
} from './orphan-claim'

describe('the claim helpers', () => {
  /** The fixed values are part of what an operator greps for and what the owed sweep dispatches on. */
  it('uses the fixed values', () => {
    expect(ORPHAN_CLAIM).toBe('orphan-claim')
    expect(ORPHAN_DEBIT_REASON).toBe('orphan-debit')
    expect(DEBIT_PREFIXES).toEqual(['hold:', 'record:'])
  })

  /** A hold's and a record's debit key map to the ledger key and to the refund the inline rollback of that debit sends. */
  it.each([
    ['hold:k', 'k', 'hold-rollback:k', 'hold rollback'],
    ['hold:hold:u', 'hold:u', 'hold-rollback:hold:u', 'hold rollback'],
    ['record:c', 'c', 'record-rollback:c', 'enforcement rollback'],
  ])('maps the debit key %s', (debitKey, ledgerKey, refundKey, reason) => {
    expect(ledgerKeyOfDebit(debitKey)).toBe(ledgerKey)
    expect(rollbackOfDebit(debitKey)).toEqual({ key: refundKey, reason })
  })

  /** A key that is neither maps to nothing. */
  it('maps no other key', () => {
    expect(ledgerKeyOfDebit('capture:x')).toBeNull()
    expect(rollbackOfDebit('capture:x')).toBeNull()
    expect(rollbackOfDebit('xhold:k')).toBeNull()
  })

  /** A capture whose claim was already written is refused as a conflict that names the tenant and the key. */
  it('refuses a late append as a conflict naming the tenant and the key', () => {
    const logger = { error: jest.fn(), warn: jest.fn() } as unknown as Parameters<typeof lateAppend>[0]
    const refusal = lateAppend(logger, { tenantId: 't1', idempotencyKey: 'k1' } as Parameters<typeof lateAppend>[1])
    expect(refusal).toHaveProperty('response.error.code', 'AI_TOKENS_IDEMPOTENCY_CONFLICT')
    expect(refusal).toHaveProperty('response.error.details', { tenantId: 't1', idempotencyKey: 'k1' })
  })

  /** A row is a claim only when its provider and its feature both carry the fixed value. */
  it('recognises a claim by provider and feature together', () => {
    expect(isOrphanClaim({ provider: 'orphan-claim', feature: 'orphan-claim' })).toBe(true)
    expect(isOrphanClaim({ provider: 'orphan-claim', feature: 'chat' })).toBe(false)
    expect(isOrphanClaim({ provider: 'openai', feature: 'orphan-claim' })).toBe(false)
  })

  /** A claim shares only the debit of its own kind: the key prefix of the debit it names decides. */
  it('shares the debit of its own kind only', () => {
    const claim = (requestId?: string): Parameters<typeof claimShares>[0] => ({
      provider: 'orphan-claim',
      feature: 'orphan-claim',
      ...(requestId === undefined ? {} : { requestId }),
    })
    expect(claimShares(claim('hold:k'), 'hold:')).toBe(true)
    expect(claimShares(claim('hold:k'), 'record:')).toBe(false)
    expect(claimShares(claim('record:k'), 'record:')).toBe(true)
    expect(claimShares(claim('record:k'), 'hold:')).toBe(false)
    expect(claimShares(claim(), 'hold:')).toBe(false)
    expect(claimShares({ provider: 'openai', feature: 'chat', requestId: 'hold:k' }, 'hold:')).toBe(
      false,
    )
  })
})
