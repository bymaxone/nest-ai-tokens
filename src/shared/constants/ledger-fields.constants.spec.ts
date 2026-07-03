import {
  AMOUNT_FIELDS,
  RELEASE_FIELDS,
  REVERSAL_LINKAGE_FIELD,
  SETTLEMENT_FIELDS,
  SETTLEMENT_PATCH_KEYS,
  isLegalLedgerTransition,
  isLegalTransitionPatchKey,
} from './ledger-fields.constants'

describe('ledger-field whitelists', () => {
  /** The settlement patch set is exactly the settlement columns plus the reversal linkage. */
  it('composes SETTLEMENT_PATCH_KEYS from the settlement fields and the reversal linkage', () => {
    for (const field of SETTLEMENT_FIELDS) expect(SETTLEMENT_PATCH_KEYS.has(field)).toBe(true)
    expect(SETTLEMENT_PATCH_KEYS.has(REVERSAL_LINKAGE_FIELD)).toBe(true)
    expect(SETTLEMENT_PATCH_KEYS.size).toBe(SETTLEMENT_FIELDS.length + 1)
  })

  /** Release annotations never overlap the append-only amounts. */
  it('keeps the release annotations disjoint from the append-only amounts', () => {
    for (const field of RELEASE_FIELDS) expect(AMOUNT_FIELDS).not.toContain(field)
  })
})

describe('isLegalLedgerTransition', () => {
  /** pending → posted (settle) and pending → released (void) are the two legal hold outcomes. */
  it('permits settling and voiding a hold', () => {
    expect(isLegalLedgerTransition('pending', 'posted')).toBe(true)
    expect(isLegalLedgerTransition('pending', 'released')).toBe(true)
  })

  /** posted → reversed (annotate) is the only legal post-posting flip. */
  it('permits annotating a posted record as reversed', () => {
    expect(isLegalLedgerTransition('posted', 'reversed')).toBe(true)
  })

  /** A pending hold may not jump straight to reversed. */
  it('rejects an illegal pending → reversed jump', () => {
    expect(isLegalLedgerTransition('pending', 'reversed')).toBe(false)
  })

  /** A posted record may not revert to pending. */
  it('rejects an illegal posted → pending revert', () => {
    expect(isLegalLedgerTransition('posted', 'pending')).toBe(false)
  })

  /** A released/terminal record cannot transition anywhere. */
  it('rejects a transition out of a terminal state', () => {
    expect(isLegalLedgerTransition('released', 'posted')).toBe(false)
  })
})

describe('isLegalTransitionPatchKey', () => {
  /** pending → posted may patch a settlement amount. */
  it('allows a settlement field on settle', () => {
    expect(isLegalTransitionPatchKey('pending', 'posted', 'billedCostNanoUsd')).toBe(true)
  })

  /** pending → posted may not patch an immutable identity column. */
  it('rejects an immutable identity field on settle', () => {
    expect(isLegalTransitionPatchKey('pending', 'posted', 'tenantId')).toBe(false)
  })

  /** pending → released may annotate correlation linkage. */
  it('allows an audit-annotation field on release', () => {
    expect(isLegalTransitionPatchKey('pending', 'released', 'correlationId')).toBe(true)
  })

  /** pending → released may never patch an amount. */
  it('rejects an amount field on release', () => {
    expect(isLegalTransitionPatchKey('pending', 'released', 'billedCostNanoUsd')).toBe(false)
  })

  /** A release voids a hold, so it may not backfill settlement pricing metadata. */
  it('rejects settlement pricing metadata on release', () => {
    expect(isLegalTransitionPatchKey('pending', 'released', 'priceVersionId')).toBe(false)
  })

  /** posted → reversed may set only the reversal linkage. */
  it('allows the reversal linkage on reversal', () => {
    expect(isLegalTransitionPatchKey('posted', 'reversed', REVERSAL_LINKAGE_FIELD)).toBe(true)
  })

  /** posted → reversed may not annotate anything else. */
  it('rejects a non-linkage field on reversal', () => {
    expect(isLegalTransitionPatchKey('posted', 'reversed', 'correlationId')).toBe(false)
  })

  /** An illegal from-state (not posted) reaching the reversal branch patches nothing. */
  it('rejects a patch on an illegal transition into reversed', () => {
    expect(isLegalTransitionPatchKey('released', 'reversed', REVERSAL_LINKAGE_FIELD)).toBe(false)
  })

  /** A wholly illegal transition patches nothing. */
  it('rejects any patch on an illegal transition', () => {
    expect(isLegalTransitionPatchKey('posted', 'pending', 'correlationId')).toBe(false)
    expect(isLegalTransitionPatchKey('pending', 'reversed', 'correlationId')).toBe(false)
  })
})
