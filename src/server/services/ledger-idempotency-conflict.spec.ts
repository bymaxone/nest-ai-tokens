import { isLedgerIdempotencyConflict, LedgerIdempotencyConflict } from './ledger-idempotency-conflict'

describe('LedgerIdempotencyConflict', () => {
  /** The error carries the colliding tenant + key and the structural brand. */
  it('carries the tenant, key, and brand', () => {
    const error = new LedgerIdempotencyConflict('tenant-1', 'key-1')
    expect(error.tenantId).toBe('tenant-1')
    expect(error.idempotencyKey).toBe('key-1')
    expect(error.isAiTokensLedgerConflict).toBe(true)
    expect(error.name).toBe('LedgerIdempotencyConflict')
  })
})

describe('isLedgerIdempotencyConflict', () => {
  /** A genuine conflict is recognized. */
  it('recognizes a conflict instance', () => {
    expect(isLedgerIdempotencyConflict(new LedgerIdempotencyConflict('t', 'k'))).toBe(true)
  })

  /** A plain error object without the brand is not a conflict. */
  it('rejects an unbranded object', () => {
    expect(isLedgerIdempotencyConflict(new Error('other'))).toBe(false)
    expect(isLedgerIdempotencyConflict({ isAiTokensLedgerConflict: false })).toBe(false)
  })

  /** null and non-object primitives are not conflicts. */
  it('rejects null and non-objects', () => {
    expect(isLedgerIdempotencyConflict(null)).toBe(false)
    expect(isLedgerIdempotencyConflict('conflict')).toBe(false)
    expect(isLedgerIdempotencyConflict(undefined)).toBe(false)
  })
})
